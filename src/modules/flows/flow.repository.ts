import type pg from 'pg';
import { query, queryOne } from '../../database/pool.js';
import type { SealedValue } from '../../utils/secret-box.js';
import type { RunResult } from './flow.types.js';

/**
 * Every SQL statement the flow runner runs.
 *
 * Same split as the auth module: nothing above here writes a query, nothing
 * here makes a decision. Ciphertext goes in and out as buffers — this file
 * never opens a sealed value, which keeps the set of places that can read a
 * user's API token down to one.
 */

type Client = pg.PoolClient | undefined;

async function run<T extends pg.QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  if (!client) return query<T>(text, params);
  return (await client.query<T>(text, params as unknown[])).rows;
}

const one = async <T extends pg.QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> => (await run<T>(client, text, params))[0] ?? null;

/* ── Rows ───────────────────────────────────────────────────────────────── */

export interface EnvironmentRow {
  id: string;
  user_id: string;
  project_key: string;
  name: string;
  values_encrypted: Buffer;
  values_iv: Buffer;
  values_tag: Buffer;
  key_version: number;
  value_keys: string[];
  created_at: Date;
  updated_at: Date;
}

export interface FlowRow {
  id: string;
  user_id: string;
  environment_id: string | null;
  project_key: string;
  client_flow_id: string;
  name: string;
  definition_encrypted: Buffer;
  definition_iv: Buffer;
  definition_tag: Buffer;
  key_version: number;
  summary: { nodeId: string; name: string; method: string; path: string }[];
  step_count: number;
  hosts: string[];
  recipients: string[];
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  id: string;
  flow_id: string;
  user_id: string;
  trigger: 'manual' | 'scheduled';
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error';
  total_steps: number;
  passed_steps: number;
  failed_steps: number;
  skipped_steps: number;
  started_at: Date | null;
  finished_at: Date | null;
  duration_ms: number | null;
  error: string | null;
  report_sent: boolean;
  created_at: Date;
}

export interface RunStepRow {
  id: string;
  run_id: string;
  position: number;
  node_id: string;
  name: string;
  method: string;
  url: string;
  status: 'ok' | 'failed' | 'skipped';
  status_code: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
  error: string | null;
  response_excerpt: string | null;
}

/* ── Environments ───────────────────────────────────────────────────────── */

export const upsertEnvironment = (
  values: {
    userId: string;
    projectKey: string;
    name: string;
    sealed: SealedValue;
    valueKeys: string[];
  },
  client?: Client,
): Promise<EnvironmentRow | null> =>
  one<EnvironmentRow>(
    client,
    `insert into flow_environments
       (user_id, project_key, name, values_encrypted, values_iv, values_tag, key_version, value_keys)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (user_id, project_key, name) do update set
       values_encrypted = excluded.values_encrypted,
       values_iv        = excluded.values_iv,
       values_tag       = excluded.values_tag,
       key_version      = excluded.key_version,
       value_keys       = excluded.value_keys
     returning *`,
    [
      values.userId,
      values.projectKey,
      values.name,
      values.sealed.ciphertext,
      values.sealed.iv,
      values.sealed.tag,
      values.sealed.keyVersion,
      values.valueKeys,
    ],
  );

export const findEnvironment = (
  id: string,
  userId: string,
  client?: Client,
): Promise<EnvironmentRow | null> =>
  one<EnvironmentRow>(client, `select * from flow_environments where id = $1 and user_id = $2`, [
    id,
    userId,
  ]);

export const listEnvironments = (
  userId: string,
  projectKey: string,
): Promise<EnvironmentRow[]> =>
  query<EnvironmentRow>(
    `select * from flow_environments
      where user_id = $1 and project_key = $2
      order by name`,
    [userId, projectKey],
  );

export const deleteEnvironment = async (id: string, userId: string): Promise<boolean> => {
  const rows = await query(`delete from flow_environments where id = $1 and user_id = $2 returning id`, [
    id,
    userId,
  ]);
  return rows.length > 0;
};

/* ── Flows ──────────────────────────────────────────────────────────────── */

export const upsertFlow = (
  values: {
    userId: string;
    environmentId: string | null;
    projectKey: string;
    clientFlowId: string;
    name: string;
    sealed: SealedValue;
    summary: unknown;
    stepCount: number;
    hosts: string[];
    recipients: string[];
  },
  client?: Client,
): Promise<FlowRow | null> =>
  one<FlowRow>(
    client,
    `insert into flows
       (user_id, environment_id, project_key, client_flow_id, name,
        definition_encrypted, definition_iv, definition_tag, key_version,
        summary, step_count, hosts, recipients)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
     on conflict (user_id, project_key, client_flow_id) do update set
       environment_id       = excluded.environment_id,
       name                 = excluded.name,
       definition_encrypted = excluded.definition_encrypted,
       definition_iv        = excluded.definition_iv,
       definition_tag       = excluded.definition_tag,
       key_version          = excluded.key_version,
       summary              = excluded.summary,
       step_count           = excluded.step_count,
       hosts                = excluded.hosts,
       recipients           = excluded.recipients,
       deleted_at           = null
     returning *`,
    [
      values.userId,
      values.environmentId,
      values.projectKey,
      values.clientFlowId,
      values.name,
      values.sealed.ciphertext,
      values.sealed.iv,
      values.sealed.tag,
      values.sealed.keyVersion,
      JSON.stringify(values.summary),
      values.stepCount,
      values.hosts,
      values.recipients,
    ],
  );

export const findFlow = (id: string, userId: string, client?: Client): Promise<FlowRow | null> =>
  one<FlowRow>(client, `select * from flows where id = $1 and user_id = $2 and deleted_at is null`, [
    id,
    userId,
  ]);

export const listFlows = (userId: string, projectKey: string | null): Promise<FlowRow[]> =>
  query<FlowRow>(
    `select * from flows
      where user_id = $1 and deleted_at is null
        and ($2::text is null or project_key = $2)
      order by updated_at desc`,
    [userId, projectKey],
  );

/** Soft delete: a run history that outlives its flow is still worth reading.
 * Also disables any schedule on this flow immediately so the tick loop cannot
 * claim it between this call and a separate cancel — the schedule only runs
 * while enabled, so clearing that flag is enough. */
export const softDeleteFlow = async (id: string, userId: string): Promise<boolean> => {
  const deleted = await query<{ id: string }>(
    `update flows set deleted_at = now()
      where id = $1 and user_id = $2 and deleted_at is null
      returning id`,
    [id, userId],
  );

  if (deleted.length === 0) return false;

  /* Kill the schedule in the same logical operation. The tick's claimDue only
     reads enabled rows, so setting enabled=false prevents any further run
     without needing a separate DELETE from the application layer. */
  await query(
    `update flow_schedules
        set enabled = false, next_run_at = null, disabled_reason = 'Flow was deleted.'
      where flow_id = $1`,
    [id],
  );

  return true;
};

/** True when this flow has any schedule row (enabled or not). */
export const hasScheduleForFlow = async (flowId: string, userId: string): Promise<boolean> => {
  const row = await queryOne<{ id: string }>(
    `select id from flow_schedules where flow_id = $1 and user_id = $2 limit 1`,
    [flowId, userId],
  );
  return row !== null;
};



export const setRecipients = (
  id: string,
  userId: string,
  recipients: string[],
): Promise<FlowRow | null> =>
  one<FlowRow>(
    undefined,
    `update flows set recipients = $3
      where id = $1 and user_id = $2 and deleted_at is null
      returning *`,
    [id, userId, recipients],
  );

/* ── Runs ───────────────────────────────────────────────────────────────── */

export const createRun = (
  values: { flowId: string; userId: string; trigger: 'manual' | 'scheduled' },
  client?: Client,
): Promise<RunRow | null> =>
  one<RunRow>(
    client,
    `insert into flow_runs (flow_id, user_id, trigger, status, started_at)
     values ($1, $2, $3, 'running', now())
     returning *`,
    [values.flowId, values.userId, values.trigger],
  );

/**
 * Writes the outcome and every step in one transaction-free burst.
 *
 * The steps go in with a single multi-row insert rather than one statement
 * each: a twenty-step flow was twenty round trips to a database that is not on
 * this machine, and the run is finished either way.
 */
export const finishRun = async (
  runId: string,
  result: RunResult,
  client?: Client,
): Promise<void> => {
  await run(
    client,
    `update flow_runs set
       status        = $2,
       total_steps   = $3,
       passed_steps  = $4,
       failed_steps  = $5,
       skipped_steps = $6,
       duration_ms   = $7,
       error         = $8,
       finished_at   = now()
     where id = $1`,
    [
      runId,
      result.status,
      result.totals.total,
      result.totals.passed,
      result.totals.failed,
      result.totals.skipped,
      result.durationMs,
      result.error,
    ],
  );

  if (result.steps.length === 0) return;

  const columns = 10;
  const placeholders = result.steps
    .map((_, index) => `(${Array.from({ length: columns }, (__, c) => `$${index * columns + c + 1}`).join(', ')})`)
    .join(', ');

  const params = result.steps.flatMap((step) => [
    runId,
    step.position,
    step.nodeId,
    step.name,
    step.method,
    step.url,
    step.status,
    step.statusCode,
    step.durationMs,
    step.error,
  ]);

  await run(
    client,
    `insert into flow_run_steps
       (run_id, position, node_id, name, method, url, status, status_code, duration_ms, error)
     values ${placeholders}`,
    params,
  );

  /* Excerpts are updated separately so the bulk insert above stays a fixed
     shape; most steps have one and it is by far the largest column. */
  for (const step of result.steps) {
    if (!step.responseExcerpt) continue;
    await run(
      client,
      `update flow_run_steps set response_excerpt = $3 where run_id = $1 and position = $2`,
      [runId, step.position, step.responseExcerpt],
    );
  }
};

export const markRunError = async (runId: string, message: string): Promise<void> => {
  await query(
    `update flow_runs set status = 'error', error = $2, finished_at = now() where id = $1`,
    [runId, message],
  );
};

export const markReportSent = async (runId: string): Promise<void> => {
  await query(`update flow_runs set report_sent = true where id = $1`, [runId]);
};

export const touchFlowRun = async (flowId: string): Promise<void> => {
  await query(`update flows set last_run_at = now() where id = $1`, [flowId]);
};

export const findRun = (id: string, userId: string): Promise<RunRow | null> =>
  queryOne<RunRow>(`select * from flow_runs where id = $1 and user_id = $2`, [id, userId]);

export const listRuns = (flowId: string, userId: string, limit: number): Promise<RunRow[]> =>
  query<RunRow>(
    `select * from flow_runs
      where flow_id = $1 and user_id = $2
      order by created_at desc
      limit $3`,
    [flowId, userId, limit],
  );

export const listRunSteps = (runId: string): Promise<RunStepRow[]> =>
  query<RunStepRow>(`select * from flow_run_steps where run_id = $1 order by position`, [runId]);

/* ── Schedules ──────────────────────────────────────────────────────────── */

export interface ScheduleRow {
  id: string;
  flow_id: string;
  user_id: string;
  enabled: boolean;
  kind: 'cron' | 'once';
  cron: string | null;
  timezone: string;
  next_run_at: Date | null;
  last_run_at: Date | null;
  claimed_at: Date | null;
  claimed_by: string | null;
  consecutive_failures: number;
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

/** One schedule per flow, so saving twice edits rather than stacks. */
export const upsertSchedule = (
  values: {
    flowId: string;
    userId: string;
    enabled: boolean;
    kind: 'cron' | 'once';
    cron: string | null;
    timezone: string;
    nextRunAt: Date | null;
  },
): Promise<ScheduleRow | null> =>
  one<ScheduleRow>(
    undefined,
    `insert into flow_schedules (flow_id, user_id, enabled, kind, cron, timezone, next_run_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (flow_id) do update set
       enabled              = excluded.enabled,
       kind                 = excluded.kind,
       cron                 = excluded.cron,
       timezone             = excluded.timezone,
       next_run_at          = excluded.next_run_at,
       consecutive_failures = 0,
       disabled_reason      = null,
       claimed_at           = null,
       claimed_by           = null
     returning *`,
    [values.flowId, values.userId, values.enabled, values.kind, values.cron, values.timezone, values.nextRunAt],
  );

export const findSchedule = (flowId: string, userId: string): Promise<ScheduleRow | null> =>
  queryOne<ScheduleRow>(`select * from flow_schedules where flow_id = $1 and user_id = $2`, [
    flowId,
    userId,
  ]);

export const deleteSchedule = async (flowId: string, userId: string): Promise<boolean> => {
  const rows = await query(`delete from flow_schedules where flow_id = $1 and user_id = $2 returning id`, [
    flowId,
    userId,
  ]);
  return rows.length > 0;
};

/**
 * Takes ownership of the schedules that are due.
 *
 * `for update skip locked` is what makes this safe with more than one instance
 * running: two workers ticking at the same second take different rows instead
 * of both running the same flow. A claim older than the lease is reclaimed, so
 * an instance that died mid-run does not wedge a schedule forever.
 */
export const claimDue = (limit: number, workerId: string, leaseMs: number): Promise<ScheduleRow[]> =>
  query<ScheduleRow>(
    `update flow_schedules set claimed_at = now(), claimed_by = $2
      where id in (
        select id from flow_schedules
         where enabled
           and next_run_at is not null
           and next_run_at <= now()
           and (claimed_at is null or claimed_at < now() - ($3::bigint * interval '1 millisecond'))
         order by next_run_at
         for update skip locked
         limit $1
      )
      returning *`,
    [limit, workerId, Math.round(leaseMs)],
  );

/** Releases a claim and books the next occurrence. */
export const releaseSchedule = async (
  id: string,
  values: { nextRunAt: Date | null; enabled: boolean; failed: boolean; disabledReason: string | null },
): Promise<void> => {
  await query(
    `update flow_schedules set
       claimed_at           = null,
       claimed_by           = null,
       last_run_at          = now(),
       next_run_at          = $2,
       enabled              = $3,
       consecutive_failures = case when $4 then consecutive_failures + 1 else 0 end,
       disabled_reason      = $5
     where id = $1`,
    [id, values.nextRunAt, values.enabled, values.failed, values.disabledReason],
  );
};

/** The owner's address, needed to send a scheduled report. */
export const ownerEmail = async (userId: string): Promise<string | null> => {
  const row = await queryOne<{ email: string }>(`select email from users where id = $1`, [userId]);
  return row?.email ?? null;
};
