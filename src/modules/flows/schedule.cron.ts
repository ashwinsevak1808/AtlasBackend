/**
 * When does this schedule fire next?
 *
 * A five-field cron expression read in the user's own timezone. "Every day at
 * 07:00" means 07:00 where they are, which is a different instant in June than
 * in December — so this cannot be done with a fixed UTC offset, and storing one
 * would silently drift by an hour twice a year.
 *
 * No dependency: the expressions this needs to understand are the ones the UI
 * generates, plus anything simple somebody types. Fields support `*`, a number,
 * a list `1,15`, a range `9-17`, and a step `*​/15`. That is the whole grammar,
 * and refusing anything else is better than half-supporting `L` and `#`.
 *
 * Search is bounded: candidate days forward, then the hours and minutes the
 * expression allows. It never walks minute by minute.
 */

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[] | null; /* null means "any" */
  months: number[];
  daysOfWeek: number[] | null; /* null means "any", 0 = Sunday */
}

const RANGES = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
} as const;

function parseField(raw: string, [min, max]: readonly [number, number], label: string): number[] {
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) throw new Error(`Empty ${label} in the schedule.`);

    const [spec, stepText] = piece.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`"${piece}" is not a valid ${label}.`);

    let from: number;
    let to: number;

    if (spec === '*' || spec === undefined) {
      from = min;
      to = max;
    } else if (spec.includes('-')) {
      const [a, b] = spec.split('-');
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(spec);
      to = stepText === undefined ? from : max;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`"${piece}" is not a valid ${label} (${min}-${max}).`);
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('A schedule needs five fields: minute hour day-of-month month day-of-week.');
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];

  return {
    minutes: parseField(minute, RANGES.minute, 'minute'),
    hours: parseField(hour, RANGES.hour, 'hour'),
    /* `*` in either day field means "no restriction from this one". Standard
       cron ORs the two when both are restricted, which is the one genuinely
       surprising rule in the format, and is honoured below. */
    daysOfMonth: dayOfMonth.trim() === '*' ? null : parseField(dayOfMonth, RANGES.dayOfMonth, 'day of month'),
    months: parseField(month, RANGES.month, 'month'),
    daysOfWeek: dayOfWeek.trim() === '*' ? null : parseField(dayOfWeek, RANGES.dayOfWeek, 'day of week'),
  };
}

/** True when the expression is one we can actually schedule. */
export function cronProblem(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/* ── Timezones ──────────────────────────────────────────────────────────── */

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const partsFormatter = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock reading of an instant in a zone. */
export function wallClock(instant: Date, timeZone: string): Wall {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';

  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    /* 24-hour formatting renders midnight as "24" in some ICU versions. */
    hour: Number(pick('hour')) % 24,
    minute: Number(pick('minute')),
    weekday: WEEKDAYS[pick('weekday')] ?? 0,
  };
}

/**
 * The instant at which a zone's wall clock reads the given time.
 *
 * Two passes: guess that the wall time is UTC, measure how far off the zone
 * actually is at that instant, and correct. One correction is enough except
 * inside a DST transition, where an hour either does not exist or happens
 * twice — there the result lands on a neighbouring minute rather than being
 * wrong by an hour, which for a "run this every morning" schedule is the right
 * trade against pulling in a full timezone library.
 */
function instantFor(wall: Omit<Wall, 'weekday'>, timeZone: string): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);
  const guess = new Date(asUtc);

  const seen = wallClock(guess, timeZone);
  const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, 0);

  return new Date(asUtc - (seenAsUtc - asUtc));
}

/* ── The answer ─────────────────────────────────────────────────────────── */

/** How far ahead to look before giving up. A yearly schedule still resolves. */
const HORIZON_DAYS = 400;

/**
 * The next instant this expression fires, strictly after `from`.
 *
 * Returns null when nothing matches inside the horizon — a 30th of February
 * expression, for instance, which is worth reporting rather than looping.
 */
export function nextRunAt(
  expression: string,
  timeZone: string,
  from: Date = new Date(),
): Date | null {
  const fields = parseCron(expression);
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';

  const start = wallClock(from, zone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);

  for (let day = 0; day < HORIZON_DAYS; day += 1) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const dayOfMonth = date.getUTCDate();
    const weekday = date.getUTCDay();

    cursor += 24 * 60 * 60 * 1000;

    if (!fields.months.includes(month)) continue;

    /* Cron's one odd rule: when both day fields are restricted, a match in
       either is a match. When only one is, that one decides. */
    const monthDayOk = fields.daysOfMonth?.includes(dayOfMonth);
    const weekDayOk = fields.daysOfWeek?.includes(weekday);

    const dayMatches =
      fields.daysOfMonth === null && fields.daysOfWeek === null
        ? true
        : fields.daysOfMonth !== null && fields.daysOfWeek !== null
          ? Boolean(monthDayOk) || Boolean(weekDayOk)
          : Boolean(monthDayOk ?? weekDayOk);

    if (!dayMatches) continue;

    for (const hour of fields.hours) {
      for (const minute of fields.minutes) {
        const candidate = instantFor({ year, month, day: dayOfMonth, hour, minute }, zone);
        if (candidate.getTime() > from.getTime()) return candidate;
      }
    }
  }

  return null;
}

/* ── Presets ────────────────────────────────────────────────────────────── */

/**
 * The expressions the UI offers, so nobody has to know cron to schedule a
 * flow. Everything here is still a plain expression, so a typed one keeps
 * working alongside them.
 */
export const PRESETS = {
  hourly: (minute: number) => `${minute} * * * *`,
  daily: (hour: number, minute: number) => `${minute} ${hour} * * *`,
  weekdays: (hour: number, minute: number) => `${minute} ${hour} * * 1-5`,
  weekly: (day: number, hour: number, minute: number) => `${minute} ${hour} * * ${day}`,
  everyNHours: (n: number, minute: number) => `${minute} */${n} * * *`,
} as const;

/** A schedule in words, for the UI and the report footer. */
export function describeCron(expression: string, timeZone: string): string {
  let fields: CronFields;
  try {
    fields = parseCron(expression);
  } catch {
    return expression;
  }

  const at = (hour: number, minute: number) =>
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const minute = fields.minutes[0] ?? 0;
  const hour = fields.hours[0] ?? 0;
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const everyHour = fields.hours.length === 24;
  const oneTime = fields.minutes.length === 1 && fields.hours.length === 1;

  if (fields.minutes.length === 1 && everyHour && !fields.daysOfWeek) {
    return `Every hour at ${String(minute).padStart(2, '0')} past, ${timeZone}`;
  }
  if (oneTime && !fields.daysOfWeek && !fields.daysOfMonth) {
    return `Every day at ${at(hour, minute)}, ${timeZone}`;
  }
  if (oneTime && fields.daysOfWeek?.join(',') === '1,2,3,4,5') {
    return `Weekdays at ${at(hour, minute)}, ${timeZone}`;
  }
  if (oneTime && fields.daysOfWeek?.length === 1) {
    return `Every ${names[fields.daysOfWeek[0] ?? 0]} at ${at(hour, minute)}, ${timeZone}`;
  }
  if (fields.hours.length > 1 && fields.minutes.length === 1) {
    const gap = (fields.hours[1] ?? 0) - (fields.hours[0] ?? 0);
    return `Every ${gap} hours, ${timeZone}`;
  }

  return `${expression} (${timeZone})`;
}
