import { checkUrl } from '../../utils/safe-url.js';
import logger from '../../utils/logger.js';
import type {
  FlowDefinition,
  FlowRequest,
  KeyValueRow,
  RequestAuth,
  RunResult,
  StepResult,
} from './flow.types.js';

/**
 * Running a flow, server-side.
 *
 * A faithful port of `runFlow` in `Frontend/src/lib/testing-store.ts`, so that
 * pressing Run in the workspace and letting the scheduler do it at 3am produce
 * the same result for the same flow. Where the two differ, the browser is
 * right and this is the bug.
 *
 * Three things are different here, and all three are because this runs on our
 * infrastructure rather than on the user's machine:
 *
 *   - Every URL goes through the SSRF guard before a socket is opened.
 *   - Redirects are followed by hand so each hop can be checked too.
 *   - Responses are truncated before they are kept, because these are stored
 *     in our database rather than held in a tab that will be closed.
 */

const REQUEST_TIMEOUT_MS = 30_000;
/** The whole flow, so one hanging step cannot hold a worker forever. */
const FLOW_TIMEOUT_MS = 5 * 60_000;
const MAX_REDIRECTS = 5;
const EXCERPT_LIMIT = 2_000;
const MAX_RESPONSE_BYTES = 1_000_000;

/* ── Request building — ported from Frontend/src/lib/http.ts ────────────── */

export function substitute(text: string, env: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name: string) => env[name] ?? whole);
}

const activeRows = (rows: KeyValueRow[]): KeyValueRow[] =>
  (rows ?? []).filter((row) => row.enabled && row.key.trim() !== '');

function withQuery(url: string, query: KeyValueRow[], env: Record<string, string>): string {
  const pairs = activeRows(query).map(
    (row) => `${encodeURIComponent(row.key.trim())}=${encodeURIComponent(substitute(row.value, env))}`,
  );
  if (pairs.length === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${pairs.join('&')}`;
}

function encodeBody(request: FlowRequest): { body: string; contentType: string | null } {
  const form = () =>
    activeRows(request.formFields)
      .map((row) => `${encodeURIComponent(row.key.trim())}=${encodeURIComponent(row.value)}`)
      .join('&');

  switch (request.bodyType) {
    case 'none':
      return { body: '', contentType: null };
    case 'json':
      return { body: request.body, contentType: 'application/json' };
    case 'xml':
      return { body: request.body, contentType: 'application/xml' };
    case 'raw':
      return { body: request.body, contentType: 'text/plain' };
    case 'urlencoded':
      return { body: form(), contentType: 'application/x-www-form-urlencoded' };
    /* Matches the browser: real multipart is not supported, and sending the
       fields urlencoded works for every API that accepts either. */
    case 'form-data':
      return { body: form(), contentType: 'application/x-www-form-urlencoded' };
    case 'graphql':
      return {
        body: JSON.stringify({
          query: request.graphqlQuery,
          variables: request.graphqlVariables ? safeParse(request.graphqlVariables) : undefined,
        }),
        contentType: 'application/json',
      };
    default:
      return { body: request.body, contentType: null };
  }
}

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function authRows(auth: RequestAuth): { headers: KeyValueRow[]; query: KeyValueRow[] } {
  const make = (key: string, value: string): KeyValueRow => ({
    id: `auth-${key}`,
    key,
    value,
    enabled: true,
  });

  switch (auth?.mode) {
    case 'bearer':
      return auth.token
        ? { headers: [make('Authorization', `Bearer ${auth.token}`)], query: [] }
        : { headers: [], query: [] };

    case 'basic': {
      if (!auth.username && !auth.password) return { headers: [], query: [] };
      /* The browser uses btoa; Buffer is the same base64 on this side. */
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { headers: [make('Authorization', `Basic ${encoded}`)], query: [] };
    }

    case 'apiKey':
      if (!auth.keyName || !auth.token) return { headers: [], query: [] };
      return auth.keyIn === 'query'
        ? { headers: [], query: [make(auth.keyName, auth.token)] }
        : { headers: [make(auth.keyName, auth.token)], query: [] };

    default:
      return { headers: [], query: [] };
  }
}

const cookieHeader = (cookies: KeyValueRow[]): KeyValueRow[] => {
  const pairs = activeRows(cookies).map((row) => `${row.key.trim()}=${row.value}`);
  return pairs.length > 0
    ? [{ id: 'cookie', key: 'Cookie', value: pairs.join('; '), enabled: true }]
    : [];
};

/** Reads a dotted path out of a response body. Supports numeric array indices. */
export function valueAtPath(source: unknown, path: string): unknown {
  if (!path.trim()) return undefined;
  let cursor: unknown = source;

  for (const segment of path.split('.')) {
    if (cursor == null) return undefined;
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/* ── Sending ────────────────────────────────────────────────────────────── */

interface Sent {
  ok: boolean;
  status: number;
  statusText: string;
  body: unknown;
  raw: string;
  sizeBytes: number;
  durationMs: number;
  error: string | null;
}

/**
 * One request, with every hop checked.
 *
 * Redirects are `manual` rather than followed by the runtime: a public URL that
 * 302s to `http://169.254.169.254/` would otherwise walk straight past the
 * guard, which is the classic way an SSRF filter gets bypassed.
 */
async function send(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | null,
  deadline: number,
): Promise<Sent> {
  const started = Date.now();
  const fail = (error: string): Sent => ({
    ok: false,
    status: 0,
    statusText: '',
    body: null,
    raw: '',
    sizeBytes: 0,
    durationMs: Date.now() - started,
    error,
  });

  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const verdict = await checkUrl(target);
    if (!verdict.ok) {
      return fail(hop === 0 ? verdict.reason : `Redirected to somewhere we cannot call. ${verdict.reason}`);
    }

    const remaining = Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (remaining <= 0) return fail('The flow ran out of time.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const response = await fetch(verdict.url, {
        method,
        headers,
        /* Spread rather than `body: undefined`: with exactOptionalPropertyTypes
           an explicit undefined is not the same as an absent property. */
        ...(body === null ? {} : { body }),
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return fail(`${response.status} with no Location header.`);
        target = new URL(location, verdict.url).toString();
        continue;
      }

      const raw = await readCapped(response);
      const type = response.headers.get('content-type') ?? '';
      const parsed = type.includes('json') ? safeParse(raw) ?? raw : raw;

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: parsed,
        raw,
        sizeBytes: Buffer.byteLength(raw, 'utf8'),
        durationMs: Date.now() - started,
        error: response.ok ? null : `${response.status} ${response.statusText}`.trim(),
      };
    } catch (err) {
      const error = err as Error;
      return fail(
        error.name === 'AbortError'
          ? `No response within ${Math.round(remaining / 1000)}s.`
          : error.message || 'The request could not be sent.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return fail(`Gave up after ${MAX_REDIRECTS} redirects.`);
}

/** Reads the body but refuses to be handed a gigabyte. */
async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      void reader.cancel();
      chunks.push(value);
      break;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    .subarray(0, MAX_RESPONSE_BYTES)
    .toString('utf8');
}

/* ── The run ────────────────────────────────────────────────────────────── */

const excerpt = (raw: string): string | null => {
  if (!raw) return null;
  return raw.length > EXCERPT_LIMIT ? `${raw.slice(0, EXCERPT_LIMIT)}\n… truncated` : raw;
};

/** The URL without its query string, which is where API keys tend to ride. */
const forStorage = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
};

/**
 * Executes the flow and reports what happened.
 *
 * Never throws for anything the flow did — a step that fails, a whole flow
 * that fails, a cycle in the graph are all results. It throws only if the
 * engine itself is broken, which the caller treats as a 500.
 */
export async function runFlow(
  definition: FlowDefinition,
  env: Record<string, string>,
): Promise<RunResult> {
  const startedAt = Date.now();
  const deadline = startedAt + FLOW_TIMEOUT_MS;

  const nodes = definition.nodes ?? [];
  const edges = definition.edges ?? [];
  const requests = new Map((definition.requests ?? []).map((request) => [request.id, request]));

  const done = (steps: StepResult[], error: string | null): RunResult => {
    const totals = {
      total: steps.length,
      passed: steps.filter((step) => step.status === 'ok').length,
      failed: steps.filter((step) => step.status === 'failed').length,
      skipped: steps.filter((step) => step.status === 'skipped').length,
    };
    return {
      status: error ? 'error' : totals.failed + totals.skipped > 0 ? 'failed' : 'passed',
      error,
      steps,
      totals,
      durationMs: Date.now() - startedAt,
    };
  };

  if (nodes.length === 0) return done([], 'This flow has no steps.');

  /* Kahn's algorithm. Whatever never reaches the order is in a cycle. */
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of edges) {
    if (!incoming.has(edge.target) || !outgoing.has(edge.source)) continue;
    incoming.get(edge.target)?.push(edge.source);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const pending = new Map(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const order: string[] = [];
  const queue = nodes.filter((node) => (pending.get(node.id) ?? 0) === 0).map((node) => node.id);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  const inOrder = new Set(order);
  const cyclic = nodes.filter((node) => !inOrder.has(node.id));

  const steps: StepResult[] = [];
  const carried: Record<string, string> = {};
  const failed = new Set<string>();
  let position = 0;

  const record = (partial: Omit<StepResult, 'position'>): void => {
    steps.push({ ...partial, position: position++ });
  };

  for (const nodeId of order) {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) continue;

    const request = requests.get(node.requestId);
    const name = request?.name ?? 'Deleted request';

    const skip = (error: string): void => {
      failed.add(nodeId);
      record({
        nodeId,
        name,
        method: request?.method ?? '—',
        url: '',
        status: 'skipped',
        statusCode: null,
        durationMs: null,
        sizeBytes: null,
        error,
        responseExcerpt: null,
        produced: {},
      });
    };

    if ((incoming.get(nodeId) ?? []).some((id) => failed.has(id))) {
      skip('An earlier step in this chain failed.');
      continue;
    }
    if (!request) {
      skip('That request no longer exists in the flow.');
      continue;
    }
    if (Date.now() > deadline) {
      skip('The flow ran out of time before this step.');
      continue;
    }

    /* Values produced upstream sit over the environment for this call. */
    const merged = { ...env, ...carried };
    const encoded = encodeBody(request);
    const auth = authRows(request.auth);
    const rows = [...(request.headers ?? []), ...auth.headers, ...cookieHeader(request.cookies ?? [])];

    if (encoded.contentType && !rows.some((row) => row.key.toLowerCase() === 'content-type')) {
      rows.push({ id: 'content-type', key: 'Content-Type', value: encoded.contentType, enabled: true });
    }

    const headers: Record<string, string> = {};
    for (const row of activeRows(rows)) headers[row.key.trim()] = substitute(row.value, merged);

    const url = withQuery(
      substitute(request.url, merged),
      [...(request.queryParams ?? []), ...auth.query],
      merged,
    );

    const method = (request.method || 'GET').toUpperCase();
    const sendsBody = method !== 'GET' && method !== 'HEAD' && encoded.body.trim() !== '';
    const body = sendsBody ? substitute(encoded.body, merged) : null;

    const response = await send(url, method, headers, body, deadline);

    if (!response.ok) {
      failed.add(nodeId);
      record({
        nodeId,
        name,
        method,
        url: forStorage(url),
        status: 'failed',
        statusCode: response.status || null,
        durationMs: response.durationMs,
        sizeBytes: response.sizeBytes,
        error: response.error ?? 'The request failed.',
        responseExcerpt: excerpt(response.raw),
        produced: {},
      });
      continue;
    }

    /* What this node hands to each of its outgoing edges. */
    const produced: Record<string, unknown> = {};
    for (const edge of edges) {
      if (edge.source !== nodeId) continue;
      for (const mapping of edge.mappings ?? []) {
        if (!mapping.to.trim()) continue;
        const value = valueAtPath(response.body, mapping.from);
        produced[mapping.to] = value;
        carried[mapping.to] =
          value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      }
    }

    record({
      nodeId,
      name,
      method,
      url: forStorage(url),
      status: 'ok',
      statusCode: response.status,
      durationMs: response.durationMs,
      sizeBytes: response.sizeBytes,
      error: null,
      responseExcerpt: excerpt(response.raw),
      produced,
    });
  }

  /* Reported last so the order reads as "everything that ran, then what could
     not". A loop is a flaw in the flow, not a failure of the API under test. */
  for (const node of cyclic) {
    const request = requests.get(node.requestId);
    record({
      nodeId: node.id,
      name: request?.name ?? 'Deleted request',
      method: request?.method ?? '—',
      url: '',
      status: 'skipped',
      statusCode: null,
      durationMs: null,
      sizeBytes: null,
      error: 'This step is part of a loop, so it has no turn to run in.',
      responseExcerpt: null,
      produced: {},
    });
  }

  if (steps.length === 0) return done(steps, 'Nothing in this flow could run.');

  logger.info(
    `Flow "${definition.name}" finished: ${steps.filter((s) => s.status === 'ok').length}/${steps.length} passed`,
  );

  return done(steps, null);
}
