/**
 * The flow model, as the browser sends it up.
 *
 * A deliberate copy of `Frontend/src/lib/collections.ts`, which stays the
 * source of truth. The two halves are separate npm packages with no shared
 * module, so this is a seam like `Frontend/src/api/auth/auth.types.ts` is: add
 * a field there without adding it here and the server quietly ignores it.
 *
 * Only what running a flow needs is here. Nothing about examples, docs or
 * folders, because the engine never looks at them.
 */

export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export interface RequestAuth {
  mode: 'none' | 'bearer' | 'basic' | 'apiKey';
  token: string;
  username: string;
  password: string;
  keyName: string;
  keyIn: 'header' | 'query';
}

export type BodyType = 'none' | 'json' | 'xml' | 'raw' | 'form-data' | 'urlencoded' | 'graphql';

export interface FlowRequest {
  id: string;
  name: string;
  method: string;
  url: string;
  queryParams: KeyValueRow[];
  headers: KeyValueRow[];
  cookies: KeyValueRow[];
  bodyType: BodyType;
  body: string;
  formFields: KeyValueRow[];
  graphqlQuery: string;
  graphqlVariables: string;
  auth: RequestAuth;
}

/** One value carried from a response into a later request. */
export interface FlowMapping {
  id: string;
  /** Dotted path into the source response body: `data.token`, `items.0.id`. */
  from: string;
  /** The variable it binds to, referred to downstream as `{{name}}`. */
  to: string;
}

export interface FlowNode {
  id: string;
  requestId: string;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  mappings: FlowMapping[];
}

/** Everything needed to run a flow, with no reference to anything outside it. */
export interface FlowDefinition {
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  requests: FlowRequest[];
}

/* ── Results ────────────────────────────────────────────────────────────── */

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface StepResult {
  position: number;
  nodeId: string;
  name: string;
  method: string;
  /** Query string stripped — an API key travels there more often than it should. */
  url: string;
  status: StepStatus;
  statusCode: number | null;
  durationMs: number | null;
  sizeBytes: number | null;
  error: string | null;
  /** Truncated. The user is told this is stored before they upload the flow. */
  responseExcerpt: string | null;
  /** What this step handed downstream, for the report. */
  produced: Record<string, unknown>;
}

export interface RunResult {
  status: 'passed' | 'failed' | 'error';
  /** Set only when the run itself could not proceed — a cycle, no steps. */
  error: string | null;
  steps: StepResult[];
  totals: { total: number; passed: number; failed: number; skipped: number };
  durationMs: number;
}
