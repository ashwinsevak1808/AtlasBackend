import { randomUUID } from 'node:crypto';
import logger from '../../utils/logger.js';
import { badRequest, notFound } from '../../utils/app-error.js';
import * as repo from './flow.repository.js';
import type { ScheduleRow } from './flow.repository.js';
import { runStoredFlow } from './flow.service.js';
import { cronProblem, describeCron, isValidTimeZone, nextRunAt } from './schedule.cron.js';

/**
 * The clock half of the flow runner.
 *
 * It does not know how to run a flow — it calls `runStoredFlow`, the same
 * function the button in the workspace calls. All this decides is *when*, and
 * that a run that has already been claimed by another instance is not run
 * twice.
 */

/** How long a claim is honoured before another worker may take the row. */
const LEASE_MS = 10 * 60_000;
/** Per tick. Bounded so one instance cannot take on more than it can finish. */
const BATCH = 5;
/** Consecutive failures before a schedule turns itself off. */
const FAILURE_LIMIT = 10;

const WORKER = `${process.env.K_REVISION ?? 'local'}-${randomUUID().slice(0, 8)}`;

export interface PublicSchedule {
  id: string;
  flowId: string;
  enabled: boolean;
  kind: 'cron' | 'once';
  cron: string | null;
  timezone: string;
  /** The expression in words, so the UI never has to explain cron. */
  description: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

const toPublic = (row: ScheduleRow): PublicSchedule => ({
  id: row.id,
  flowId: row.flow_id,
  enabled: row.enabled,
  kind: row.kind,
  cron: row.cron,
  timezone: row.timezone,
  description:
    row.kind === 'once'
      ? `Once, at ${row.next_run_at?.toISOString() ?? 'a time that has passed'}`
      : describeCron(row.cron ?? '', row.timezone),
  nextRunAt: row.next_run_at?.toISOString() ?? null,
  lastRunAt: row.last_run_at?.toISOString() ?? null,
  consecutiveFailures: row.consecutive_failures,
  disabledReason: row.disabled_reason,
});

export interface SaveScheduleBody {
  enabled: boolean;
  kind: 'cron' | 'once';
  cron?: string | null | undefined;
  runAt?: string | null | undefined;
  timezone: string;
}

/**
 * Creates or edits the schedule on a flow.
 *
 * Validates before storing, because a schedule that cannot be parsed is a flow
 * that silently never runs — and nobody notices a report that does not arrive
 * until they needed it.
 */
export async function saveSchedule(
  userId: string,
  flowId: string,
  body: SaveScheduleBody,
): Promise<PublicSchedule> {
  const flow = await repo.findFlow(flowId, userId);
  if (!flow) throw notFound('No such flow.');

  if (!isValidTimeZone(body.timezone)) {
    throw badRequest(`"${body.timezone}" is not a timezone we recognise.`, 'bad_timezone');
  }

  let next: Date | null;

  if (body.kind === 'once') {
    const at = body.runAt ? new Date(body.runAt) : null;
    if (!at || Number.isNaN(at.getTime())) throw badRequest('Pick a date and time.', 'bad_run_at');
    if (at.getTime() <= Date.now()) throw badRequest('That time has already passed.', 'run_at_past');
    next = at;
  } else {
    const expression = body.cron?.trim() ?? '';
    const problem = cronProblem(expression);
    if (problem) throw badRequest(problem, 'bad_cron');

    next = nextRunAt(expression, body.timezone);
    if (!next) throw badRequest('That schedule never comes round.', 'cron_never_fires');
  }

  const row = await repo.upsertSchedule({
    flowId,
    userId,
    enabled: body.enabled,
    kind: body.kind,
    cron: body.kind === 'cron' ? (body.cron?.trim() ?? null) : null,
    timezone: body.timezone,
    /* A disabled schedule keeps its settings but leaves the queue. */
    nextRunAt: body.enabled ? next : null,
  });

  if (!row) throw badRequest('Could not save that schedule.', 'schedule_not_saved');
  return toPublic(row);
}

export async function getSchedule(userId: string, flowId: string): Promise<PublicSchedule | null> {
  const row = await repo.findSchedule(flowId, userId);
  return row ? toPublic(row) : null;
}

export async function removeSchedule(userId: string, flowId: string): Promise<void> {
  if (!(await repo.deleteSchedule(flowId, userId))) throw notFound('No schedule on that flow.');
}

/* ── The tick ───────────────────────────────────────────────────────────── */

export interface TickResult {
  claimed: number;
  ran: { flowId: string; status: string }[];
}

/**
 * Runs whatever is due.
 *
 * Called by an external scheduler — Cloud Run scales to zero, so an in-process
 * timer would stop with the instance. Every row is claimed before it runs, so
 * two instances ticking in the same second take different work rather than
 * both sending the same report.
 *
 * One flow failing must not stop the batch, so each is caught individually.
 */
export async function tick(): Promise<TickResult> {
  const due = await repo.claimDue(BATCH, WORKER, LEASE_MS);
  const ran: TickResult['ran'] = [];

  for (const schedule of due) {
    let status = 'error';
    let failed = true;

    try {
      const email = await repo.ownerEmail(schedule.user_id);
      const outcome = await runStoredFlow(
        schedule.user_id,
        schedule.flow_id,
        'scheduled',
        email ?? '',
      );
      status = outcome.run.status;
      /* A flow whose assertions fail is still a working schedule. Only a run
         that could not happen at all counts against the failure limit. */
      failed = outcome.run.status === 'error';
    } catch (err) {
      logger.error(`Scheduled flow ${schedule.flow_id} failed: ${(err as Error).message}`);
    }

    const failures = schedule.consecutive_failures + (failed ? 1 : 0);
    const giveUp = failures >= FAILURE_LIMIT;

    /* A `once` schedule is spent. A cron one books its next occurrence — and
       from now, not from the time it was due, so a backlog cannot cause a
       burst of catch-up runs nobody asked for. */
    const next =
      giveUp || schedule.kind === 'once'
        ? null
        : nextRunAt(schedule.cron ?? '', schedule.timezone);

    await repo.releaseSchedule(schedule.id, {
      nextRunAt: next,
      enabled: !giveUp && schedule.kind !== 'once',
      failed,
      disabledReason: giveUp
        ? `Turned off after ${failures} runs in a row could not complete.`
        : null,
    });

    ran.push({ flowId: schedule.flow_id, status });
  }

  if (due.length > 0) logger.info(`Schedule tick ran ${due.length} flow(s).`);
  return { claimed: due.length, ran };
}
