import { config } from '../../config/env.js';
import type { FlowRow, RunRow, RunStepRow } from './flow.repository.js';

/**
 * What a run looks like when it lands in someone's inbox.
 *
 * Written for the person who reads it on a phone at 7am and needs one thing
 * from it: did anything break, and what. The verdict is the first line, the
 * failures come before the successes, and the response body of a failing step
 * is in the email rather than behind a link — because the link needs a login
 * and the answer is usually right there in the body.
 *
 * Table-based HTML with inline styles, because that is what mail clients
 * render. No dark-mode variants: the product is light-mode only, and Gmail
 * would ignore them anyway.
 */

const INK = '#0f172a';
const MUTE = '#64748b';
const LINE = '#e2e8f0';
const OK = '#157347';
const BAD = '#c12827';
const WARN = '#9e6a08';

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );

const toneOf = (status: string): string =>
  status === 'ok' ? OK : status === 'failed' ? BAD : WARN;

const duration = (ms: number | null): string =>
  ms === null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

const when = (date: Date | null): string =>
  date ? date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';

export interface ReportInput {
  flow: FlowRow;
  run: RunRow;
  steps: RunStepRow[];
}

/** The one-line verdict, reused as the subject and the banner. */
export function verdictOf({ flow, run }: Pick<ReportInput, 'flow' | 'run'>): {
  subject: string;
  headline: string;
  tone: string;
} {
  if (run.status === 'error') {
    return {
      subject: `[error] ${flow.name} could not run`,
      headline: 'This flow could not run',
      tone: BAD,
    };
  }
  if (run.status === 'passed') {
    return {
      subject: `[pass] ${flow.name} — ${run.passed_steps}/${run.total_steps} steps`,
      headline: `All ${run.total_steps} step${run.total_steps === 1 ? '' : 's'} passed`,
      tone: OK,
    };
  }
  const broken = run.failed_steps + run.skipped_steps;
  return {
    subject: `[fail] ${flow.name} — ${broken} of ${run.total_steps} steps did not pass`,
    headline: `${broken} of ${run.total_steps} step${run.total_steps === 1 ? '' : 's'} did not pass`,
    tone: BAD,
  };
}

function stepRow(step: RunStepRow): string {
  const tone = toneOf(step.status);
  const label = step.status === 'ok' ? 'PASS' : step.status === 'failed' ? 'FAIL' : 'SKIP';

  const detail = step.error
    ? `<div style="margin-top:4px;font-size:12px;line-height:1.5;color:${BAD}">${escape(step.error)}</div>`
    : '';

  /* The body of a failing step is the thing that saves a round trip. A passing
     step's body is noise, so it is left out. */
  const body =
    step.status !== 'ok' && step.response_excerpt
      ? `<pre style="margin:6px 0 0;padding:8px;background:#f8fafc;border:1px solid ${LINE};border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;color:${INK};white-space:pre-wrap;word-break:break-word;overflow-x:auto">${escape(
          step.response_excerpt.slice(0, 600),
        )}</pre>`
      : '';

  return `
  <tr>
    <td style="padding:10px 8px;border-bottom:1px solid ${LINE};vertical-align:top;width:44px">
      <span style="display:inline-block;padding:2px 6px;border-radius:4px;background:${tone}1a;color:${tone};font-size:10px;font-weight:700;letter-spacing:0.04em">${label}</span>
    </td>
    <td style="padding:10px 8px;border-bottom:1px solid ${LINE};vertical-align:top">
      <div style="font-size:13px;font-weight:600;color:${INK}">${escape(step.name)}</div>
      <div style="margin-top:2px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:${MUTE};word-break:break-all">
        ${escape(step.method)} ${escape(step.url || '—')}
      </div>
      ${detail}${body}
    </td>
    <td style="padding:10px 8px;border-bottom:1px solid ${LINE};vertical-align:top;text-align:right;white-space:nowrap">
      <div style="font-size:13px;font-weight:600;color:${tone}">${step.status_code ?? '—'}</div>
      <div style="margin-top:2px;font-size:11px;color:${MUTE}">${duration(step.duration_ms)}</div>
    </td>
  </tr>`;
}

export function renderReportHtml(input: ReportInput): string {
  const { flow, run, steps } = input;
  const verdict = verdictOf(input);

  /* Failures first. Nobody scrolls past twelve passing steps to find the one
     that broke, and on a phone they would have to. */
  const ordered = [...steps].sort((a, b) => {
    const rank = (status: string) => (status === 'failed' ? 0 : status === 'skipped' ? 1 : 2);
    return rank(a.status) - rank(b.status) || a.position - b.position;
  });

  const stat = (label: string, value: string | number, tone = INK) => `
    <td style="padding:0 16px 0 0">
      <div style="font-size:20px;font-weight:700;color:${tone}">${value}</div>
      <div style="font-size:11px;color:${MUTE};text-transform:uppercase;letter-spacing:0.04em">${label}</div>
    </td>`;

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:0 auto;padding:28px 20px;color:${INK};background:#ffffff">
  <p style="font-size:18px;font-weight:700;letter-spacing:-0.03em;margin:0 0 24px">
    atlas<span style="color:#10b981;font-weight:400">.api</span>
  </p>

  <div style="padding:14px 16px;border-radius:10px;border:1px solid ${verdict.tone}33;background:${verdict.tone}0f">
    <div style="font-size:15px;font-weight:650;color:${verdict.tone}">${escape(verdict.headline)}</div>
    <div style="margin-top:3px;font-size:13px;color:${MUTE}">
      ${escape(flow.name)} · ${run.trigger === 'scheduled' ? 'scheduled run' : 'run from the workspace'}
    </div>
  </div>

  ${
    run.error
      ? `<p style="margin:16px 0 0;padding:10px 12px;border-radius:8px;background:${BAD}14;font-size:13px;line-height:1.5;color:${BAD}">${escape(run.error)}</p>`
      : ''
  }

  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 0">
    <tr>
      ${stat('Passed', run.passed_steps, OK)}
      ${stat('Failed', run.failed_steps, run.failed_steps > 0 ? BAD : INK)}
      ${stat('Skipped', run.skipped_steps, run.skipped_steps > 0 ? WARN : INK)}
      ${stat('Duration', duration(run.duration_ms))}
    </tr>
  </table>

  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0 0;border-top:1px solid ${LINE};border-collapse:collapse">
    ${ordered.map(stepRow).join('')}
  </table>

  <p style="margin:20px 0 0;padding-top:14px;border-top:1px solid ${LINE};font-size:11px;line-height:1.6;color:${MUTE}">
    Started ${escape(when(run.started_at))}. Run id <code style="font-family:ui-monospace,Menlo,monospace">${escape(run.id)}</code>.<br>
    Sent by ${escape(config.appName)} because this flow lists you as a report recipient.
  </p>
</div>`;
}

/** The same thing for a client that will not render HTML. */
export function renderReportText(input: ReportInput): string {
  const { flow, run, steps } = input;
  const verdict = verdictOf(input);

  const lines = [
    verdict.headline,
    `${flow.name} — ${run.trigger === 'scheduled' ? 'scheduled run' : 'run from the workspace'}`,
    '',
    `Passed ${run.passed_steps}  Failed ${run.failed_steps}  Skipped ${run.skipped_steps}  Duration ${duration(run.duration_ms)}`,
    '',
  ];

  if (run.error) lines.push(`Error: ${run.error}`, '');

  for (const step of steps) {
    const label = step.status === 'ok' ? 'PASS' : step.status === 'failed' ? 'FAIL' : 'SKIP';
    lines.push(`${label}  ${step.method} ${step.url || '—'}  ${step.status_code ?? ''}`.trimEnd());
    lines.push(`      ${step.name}`);
    if (step.error) lines.push(`      ${step.error}`);
  }

  lines.push('', `Started ${when(run.started_at)}. Run id ${run.id}.`);
  return lines.join('\n');
}

/* ── Exports ────────────────────────────────────────────────────────────── */

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  /* A leading =, +, - or @ is executed as a formula by Excel and Sheets. */
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${guarded.replace(/"/g, '""')}"`;
};

export function toCsv({ flow, run, steps }: ReportInput): string {
  const header = [
    'flow', 'run_id', 'trigger', 'run_status', 'position', 'step', 'method',
    'url', 'status', 'status_code', 'duration_ms', 'size_bytes', 'error',
  ];

  const rows = steps.map((step) =>
    [
      flow.name, run.id, run.trigger, run.status, step.position, step.name, step.method,
      step.url, step.status, step.status_code, step.duration_ms, step.size_bytes, step.error,
    ].map(csvCell).join(','),
  );

  return [header.join(','), ...rows].join('\n');
}

export function toJson({ flow, run, steps }: ReportInput): unknown {
  return {
    flow: { id: flow.id, name: flow.name, projectKey: flow.project_key },
    run: {
      id: run.id,
      trigger: run.trigger,
      status: run.status,
      error: run.error,
      startedAt: run.started_at?.toISOString() ?? null,
      finishedAt: run.finished_at?.toISOString() ?? null,
      durationMs: run.duration_ms,
      totals: {
        total: run.total_steps,
        passed: run.passed_steps,
        failed: run.failed_steps,
        skipped: run.skipped_steps,
      },
    },
    steps: steps.map((step) => ({
      position: step.position,
      name: step.name,
      method: step.method,
      url: step.url,
      status: step.status,
      statusCode: step.status_code,
      durationMs: step.duration_ms,
      sizeBytes: step.size_bytes,
      error: step.error,
      responseExcerpt: step.response_excerpt,
    })),
  };
}
