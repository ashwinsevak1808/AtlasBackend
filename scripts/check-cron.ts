/** Checks the schedule maths — the part that decides when a flow actually fires. */
import { cronProblem, describeCron, nextRunAt, parseCron, wallClock } from '../src/modules/flows/schedule.cron.js';

let passed = 0, failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label} ${detail}`); }
};

console.log('\nparsing');
check('parses a daily expression', parseCron('30 7 * * *').hours[0] === 7);
check('parses a list', parseCron('0,30 * * * *').minutes.join() === '0,30');
check('parses a range', parseCron('0 9-11 * * *').hours.join() === '9,10,11');
check('parses a step', parseCron('*/15 * * * *').minutes.join() === '0,15,30,45');
check('parses an hour step', parseCron('0 */6 * * *').hours.join() === '0,6,12,18');
check('* means every minute', parseCron('* * * * *').minutes.length === 60);
check('rejects four fields', cronProblem('0 7 * *') !== null);
check('rejects a bad minute', cronProblem('99 7 * * *') !== null);
check('rejects nonsense', cronProblem('every morning') !== null);
check('accepts a good one', cronProblem('30 7 * * 1-5') === null);

console.log('\nnext run, in the right zone');
{
  /* 2026-06-01T00:00:00Z. India is UTC+5:30 with no DST. */
  const from = new Date('2026-06-01T00:00:00Z');
  const next = nextRunAt('30 7 * * *', 'Asia/Kolkata', from);
  const wall = next ? wallClock(next, 'Asia/Kolkata') : null;
  check('daily 07:30 lands at 07:30 local', wall?.hour === 7 && wall?.minute === 30, JSON.stringify(wall));
  check('and is 02:00 UTC', next?.toISOString() === '2026-06-01T02:00:00.000Z', next?.toISOString() ?? '');
}
{
  /* New York is UTC-4 in July, UTC-5 in January: the same wall time, two
     different UTC instants. This is the whole reason for the timezone work. */
  const summer = nextRunAt('0 9 * * *', 'America/New_York', new Date('2026-07-01T00:00:00Z'));
  const winter = nextRunAt('0 9 * * *', 'America/New_York', new Date('2026-01-01T00:00:00Z'));
  check('09:00 in July is 13:00 UTC', summer?.toISOString() === '2026-07-01T13:00:00.000Z', summer?.toISOString() ?? '');
  check('09:00 in January is 14:00 UTC', winter?.toISOString() === '2026-01-01T14:00:00.000Z', winter?.toISOString() ?? '');
  check('both read 09:00 locally',
    wallClock(summer!, 'America/New_York').hour === 9 && wallClock(winter!, 'America/New_York').hour === 9);
}
{
  const from = new Date('2026-06-01T02:00:00Z');
  const next = nextRunAt('30 7 * * *', 'Asia/Kolkata', from);
  check('a time that has just passed rolls to tomorrow', next?.toISOString() === '2026-06-02T02:00:00.000Z', next?.toISOString() ?? '');
}
{
  /* 2026-06-01 is a Monday. Weekdays-only from Saturday must land on Monday. */
  const sat = new Date('2026-06-06T12:00:00Z');
  const next = nextRunAt('0 9 * * 1-5', 'UTC', sat);
  check('weekdays-only skips the weekend', next?.toISOString() === '2026-06-08T09:00:00.000Z', next?.toISOString() ?? '');
}
{
  const next = nextRunAt('0 * * * *', 'UTC', new Date('2026-06-01T10:15:00Z'));
  check('hourly finds the next hour', next?.toISOString() === '2026-06-01T11:00:00.000Z', next?.toISOString() ?? '');
}
check('always strictly in the future', (nextRunAt('* * * * *', 'UTC', new Date('2026-06-01T10:15:00Z'))!).getTime() > new Date('2026-06-01T10:15:00Z').getTime());
check('an impossible date gives null', nextRunAt('0 0 30 2 *', 'UTC', new Date('2026-01-01T00:00:00Z')) === null);
check('an unknown zone falls back to UTC rather than throwing', nextRunAt('0 9 * * *', 'Mars/Olympus', new Date('2026-06-01T00:00:00Z'))?.toISOString() === '2026-06-01T09:00:00.000Z');

console.log('\ndescriptions');
check('describes daily', describeCron('30 7 * * *', 'Asia/Kolkata').startsWith('Every day at 07:30'));
check('describes weekdays', describeCron('0 9 * * 1-5', 'UTC').startsWith('Weekdays at 09:00'));
check('describes one weekday', describeCron('0 9 * * 1', 'UTC').startsWith('Every Monday at 09:00'));
check('describes hourly', describeCron('0 * * * *', 'UTC').startsWith('Every hour'));

console.log(`\n${failed === 0 ? 'all checks passed' : `${failed} FAILED`} (${passed} passed)\n`);
if (failed > 0) process.exit(1);
