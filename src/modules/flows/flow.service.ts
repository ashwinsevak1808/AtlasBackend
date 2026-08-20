import { sendReportEmail } from '../../services/mailer.js';
import { badRequest, notFound } from '../../utils/app-error.js';
import { checkUrl } from '../../utils/safe-url.js';
import logger from '../../utils/logger.js';
import { openJson, sealJson, type SealedValue } from '../../utils/secret-box.js';
import { runFlow, substitute } from './flow.engine.js';
import * as repo from './flow.repository.js';
import type { EnvironmentRow, FlowRow, RunRow, RunStepRow } from './flow.repository.js';
import {
  renderReportHtml,
  renderReportText,
  toCsv,
  toJson,
  verdictOf,
} from './flow.report.js';
import type { FlowDefinition } from './flow.types.js';

/**
 * The flow runner, from the outside.
 *
 * Two things live here and nowhere else: deciding whether a flow is even
 * runnable from a server, and holding the only code path that opens a sealed
 * definition. Everything sensitive is opened, used and dropped inside a single
 * function call — nothing hands a decrypted definition back to a caller.
 */

/* ── Public shapes ──────────────────────────────────────────────────────── */

export interface PublicEnvironment {
  id: string;
  name: string;
  projectKey: string;
  /** Names only. The values are never returned once saved. */
  valueKeys: string[];
  updatedAt: string;
}

export interface PublicFlow {
  id: string;
  name: string;
  projectKey: string;
  clientFlowId: string;
  environmentId: string | null;
  stepCount: number;
  hosts: string[];
  recipients: string[];
  summary: { nodeId: string; name: string; method: string; path: string }[];
  lastRunAt: string | null;
  updatedAt: string;
}

export interface PublicRun {
  id: string;
  flowId: string;
  trigger: string;
  status: string;
  error: string | null;
  totals: { total: number; passed: number; failed: number; skipped: number };
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  reportSent: boolean;
}

const toPublicEnvironment = (row: EnvironmentRow): PublicEnvironment => ({
  id: row.id,
  name: row.name,
  projectKey: row.project_key,
  valueKeys: row.value_keys,
  updatedAt: row.updated_at.toISOString(),
});

const toPublicFlow = (row: FlowRow): PublicFlow => ({
  id: row.id,
  name: row.name,
  projectKey: row.project_key,
  clientFlowId: row.client_flow_id,
  environmentId: row.environment_id,
  stepCount: row.step_count,
  hosts: row.hosts,
  recipients: row.recipients,
  summary: row.summary ?? [],
  lastRunAt: row.last_run_at?.toISOString() ?? null,
  updatedAt: row.updated_at.toISOString(),
});

const toPublicRun = (row: RunRow): PublicRun => ({
  id: row.id,
  flowId: row.flow_id,
  trigger: row.trigger,
  status: row.status,
  error: row.error,
  totals: {
    total: row.total_steps,
    passed: row.passed_steps,
    failed: row.failed_steps,
    skipped: row.skipped_steps,
  },
  startedAt: row.started_at?.toISOString() ?? null,
  finishedAt: row.finished_at?.toISOString() ?? null,
  durationMs: row.duration_ms,
  reportSent: row.report_sent,
});

const publicStep = (step: RunStepRow) => ({
  position: step.position,
  nodeId: step.node_id,
  name: step.name,
  method: step.method,
  url: step.url,
  status: step.status,
  statusCode: step.status_code,
  durationMs: step.duration_ms,
  sizeBytes: step.size_bytes,
  error: step.error,
  responseExcerpt: step.response_excerpt,
});

const sealedOf = (row: {
  values_encrypted?: Buffer;
  values_iv?: Buffer;
  values_tag?: Buffer;
  definition_encrypted?: Buffer;
  definition_iv?: Buffer;
  definition_tag?: Buffer;
  key_version: number;
}): SealedValue => ({
  ciphertext: (row.values_encrypted ?? row.definition_encrypted) as Buffer,
  iv: (row.values_iv ?? row.definition_iv) as Buffer,
  tag: (row.values_tag ?? row.definition_tag) as Buffer,
  keyVersion: row.key_version,
});

/* ── Environments ───────────────────────────────────────────────────────── */

export async function saveEnvironment(
  userId: string,
  body: { projectKey: string; name: string; values: Record<string, string> },
): Promise<PublicEnvironment> {
  const row = await repo.upsertEnvironment({
    userId,
    projectKey: body.projectKey,
    name: body.name,
    sealed: sealJson(body.values),
    valueKeys: Object.keys(body.values).sort(),
  });
  if (!row) throw badRequest('Could not save that environment.', 'environment_not_saved');
  return toPublicEnvironment(row);
}

export const listEnvironments = async (userId: string, projectKey: string) =>
  (await repo.listEnvironments(userId, projectKey)).map(toPublicEnvironment);

export async function deleteEnvironment(userId: string, id: string): Promise<void> {
  if (!(await repo.deleteEnvironment(id, userId))) throw notFound('No such environment.');
}

/* ── Pre-flight ─────────────────────────────────────────────────────────── */

export interface Problem {
  step: string;
  url: string;
  reason: string;
}

/**
 * Can this flow run from our servers at all?
 *
 * Checked at upload rather than at 3am. A flow pointed at localhost is not a
 * failing test, it is a flow that will never work unattended, and the person
 * setting it up should hear that while they are still looking at the screen.
 *
 * Unresolved `{{variables}}` in the path are fine — they are filled by earlier
 * steps at run time. One in the host is not: we cannot tell where it points.
 */
export async function preflight(
  definition: FlowDefinition,
  env: Record<string, string>,
): Promise<{ hosts: string[]; problems: Problem[] }> {
  const hosts = new Set<string>();
  const problems: Problem[] = [];

  for (const request of definition.requests ?? []) {
    const resolved = substitute(request.url ?? '', env);

    let parsed: URL;
    try {
      parsed = new URL(resolved);
    } catch {
      problems.push({
        step: request.name,
        url: resolved,
        reason: resolved.includes('{{')
          ? 'This address still has an unfilled variable in it. Pick an environment that defines it.'
          : 'This is not a complete address. It needs a scheme and a host, like https://api.example.com.',
      });
      continue;
    }

    if (parsed.hostname.includes('{{') || parsed.hostname.includes('}}')) {
      problems.push({
        step: request.name,
        url: resolved,
        reason: 'The host is a variable this environment does not define, so we cannot tell where it points.',
      });
      continue;
    }

    const verdict = await checkUrl(parsed.toString());
    if (!verdict.ok) {
      problems.push({ step: request.name, url: `${parsed.origin}${parsed.pathname}`, reason: verdict.reason });
      continue;
    }

    hosts.add(parsed.host);
  }

  return { hosts: [...hosts].sort(), problems };
}

/** Opens an environment's values, or an empty set when there is none. */
async function environmentValues(
  userId: string,
  environmentId: string | null,
): Promise<Record<string, string>> {
  if (!environmentId) return {};
  const row = await repo.findEnvironment(environmentId, userId);
  if (!row) throw notFound('That environment no longer exists.', 'environment_missing');
  return openJson<Record<string, string>>(sealedOf(row));
}

/* ── Flows ──────────────────────────────────────────────────────────────── */

export async function uploadFlow(
  userId: string,
  body: {
    projectKey: string;
    clientFlowId: string;
    name: string;
    definition: FlowDefinition;
    environmentId?: string | null | undefined;
    recipients?: string[] | undefined;
  },
): Promise<PublicFlow> {
  const environmentId = body.environmentId ?? null;
  const env = await environmentValues(userId, environmentId);

  const { hosts, problems } = await preflight(body.definition, env);

  if (problems.length > 0) {
    throw badRequest(
      problems.length === 1
        ? (problems[0]?.reason ?? 'This flow cannot run from our servers.')
        : `${problems.length} steps in this flow cannot run from our servers.`,
      'flow_not_runnable',
      problems,
    );
  }

  const summary = (body.definition.nodes ?? []).map((node) => {
    const request = (body.definition.requests ?? []).find((candidate) => candidate.id === node.requestId);
    let path = request?.url ?? '';
    try {
      path = new URL(substitute(path, env)).pathname;
    } catch {
      /* Leave the raw template; it is only for display. */
    }
    return { nodeId: node.id, name: request?.name ?? 'Deleted request', method: request?.method ?? '—', path };
  });

  const row = await repo.upsertFlow({
    userId,
    environmentId,
    projectKey: body.projectKey,
    clientFlowId: body.clientFlowId,
    name: body.name,
    sealed: sealJson(body.definition),
    summary,
    stepCount: (body.definition.nodes ?? []).length,
    hosts,
    recipients: body.recipients ?? [],
  });

  if (!row) throw badRequest('Could not save that flow.', 'flow_not_saved');
  return toPublicFlow(row);
}

export const listFlows = async (userId: string, projectKey: string | null) =>
  (await repo.listFlows(userId, projectKey)).map(toPublicFlow);

export async function deleteFlow(
  userId: string,
  id: string,
): Promise<{ hadSchedule: boolean }> {
  /* Check before deleting so the caller can warn the user that a schedule
     was also cancelled. softDeleteFlow disables the schedule atomically, so
     the flow never fires again even if the caller ignores this return value. */
  const hadSchedule = await repo.hasScheduleForFlow(id, userId);
  if (!(await repo.softDeleteFlow(id, userId))) throw notFound('No such flow.');
  return { hadSchedule };
}

export async function updateRecipients(
  userId: string,
  id: string,
  recipients: string[],
): Promise<PublicFlow> {
  const row = await repo.setRecipients(id, userId, recipients);
  if (!row) throw notFound('No such flow.');
  return toPublicFlow(row);
}

/**
 * Pause a schedule without deleting it.
 *
 * Sets enabled=false and clears next_run_at so the tick ignores it, but
 * leaves the cron expression and timezone in place so the user can re-enable
 * it later without re-entering the schedule. Distinct from deleteSchedule
 * which removes the row entirely.
 */
export async function pauseSchedule(userId: string, flowId: string): Promise<void> {
  const existing = await repo.findSchedule(flowId, userId);
  if (!existing) throw notFound('No schedule on that flow.');
  // Re-save with enabled:false — upsertSchedule resets failure counts on save,
  // which is intentional: pausing and resuming is not a failure.
  await repo.upsertSchedule({
    flowId,
    userId,
    enabled: false,
    kind: existing.kind,
    cron: existing.cron,
    timezone: existing.timezone,
    nextRunAt: null,
  });
}

/* ── Running ────────────────────────────────────────────────────────────── */

export interface RunOutcome {
  run: PublicRun;
  steps: ReturnType<typeof publicStep>[];
  report: { delivered: boolean; note: string };
}

/**
 * Runs a stored flow and keeps the result.
 *
 * The same function serves the button in the workspace and, later, the
 * scheduler — `trigger` is the only thing that differs. That is deliberate: a
 * report someone triggered and a report that arrived at 7am should be the same
 * report, and they will be, because there is one path that makes them.
 */
export async function runStoredFlow(
  userId: string,
  flowId: string,
  trigger: 'manual' | 'scheduled',
  ownerEmail: string,
): Promise<RunOutcome> {
  const flow = await repo.findFlow(flowId, userId);
  if (!flow) throw notFound('No such flow.');

  const run = await repo.createRun({ flowId: flow.id, userId, trigger });
  if (!run) throw badRequest('Could not start that run.', 'run_not_started');

  let result;
  try {
    const definition = openJson<FlowDefinition>(sealedOf(flow));
    const env = await environmentValues(userId, flow.environment_id);
    result = await runFlow(definition, env);
    await repo.finishRun(run.id, result);
  } catch (err) {
    /* The run row already exists, so a failure to even start has to be
       recorded against it — otherwise it sits at "running" forever. */
    const message = (err as Error).message || 'The run could not be completed.';
    await repo.markRunError(run.id, message);
    logger.error(`Flow ${flow.id} run ${run.id} failed to execute: ${message}`);
    throw err;
  }

  await repo.touchFlowRun(flow.id);

  /* Re-read so the report renders from what was stored, not from what we
     think we stored. A report that disagrees with the history is worse than
     no report. */
  const finished = (await repo.findRun(run.id, userId)) ?? run;
  const steps = await repo.listRunSteps(run.id);
  const input = { flow, run: finished, steps };

  const recipients = flow.recipients.length > 0 ? flow.recipients : [ownerEmail];
  const report = await sendReportEmail(
    recipients,
    verdictOf(input).subject,
    renderReportHtml(input),
    renderReportText(input),
  );
  if (report.delivered) await repo.markReportSent(run.id);

  return { run: toPublicRun(finished), steps: steps.map(publicStep), report };
}

export async function getRun(userId: string, runId: string) {
  const run = await repo.findRun(runId, userId);
  if (!run) throw notFound('No such run.');
  return { run: toPublicRun(run), steps: (await repo.listRunSteps(runId)).map(publicStep) };
}

export const listRuns = async (userId: string, flowId: string, limit: number) =>
  (await repo.listRuns(flowId, userId, limit)).map(toPublicRun);

/* ── Export ─────────────────────────────────────────────────────────────── */

export type ExportFormat = 'json' | 'csv' | 'html';

export async function exportRun(
  userId: string,
  runId: string,
  format: ExportFormat,
): Promise<{ body: string; contentType: string; filename: string }> {
  const run = await repo.findRun(runId, userId);
  if (!run) throw notFound('No such run.');

  const flow = await repo.findFlow(run.flow_id, userId);
  if (!flow) throw notFound('That flow has been deleted.');

  const input = { flow, run, steps: await repo.listRunSteps(runId) };
  const stem = `${flow.name.replace(/[^\w.-]+/g, '-').toLowerCase()}-${run.id.slice(0, 8)}`;

  switch (format) {
    case 'csv':
      return { body: toCsv(input), contentType: 'text/csv; charset=utf-8', filename: `${stem}.csv` };
    case 'html':
      return {
        body: renderReportHtml(input),
        contentType: 'text/html; charset=utf-8',
        filename: `${stem}.html`,
      };
    default:
      return {
        body: JSON.stringify(toJson(input), null, 2),
        contentType: 'application/json; charset=utf-8',
        filename: `${stem}.json`,
      };
  }
}
