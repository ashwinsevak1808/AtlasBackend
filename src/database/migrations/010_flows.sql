-- 010_flows.sql
-- A flow uploaded so the server can run it.
--
-- Flows normally live in `collections.json` beside the user's project and
-- never leave their machine. A row here is a deliberate, per-flow exception:
-- the user asked for this one to run unattended, and unattended execution
-- requires us to hold what it needs to make the calls.
--
-- `definition_encrypted` is the entire flow — nodes, edges, and the full
-- requests with their headers, bodies and auth. Encrypted whole, because the
-- secrets are not in one tidy corner of it: an API key can be a header row, a
-- query parameter, or a field in a JSON body. Encrypting selected fields would
-- mean being right about every place a secret can hide, forever.
--
-- `summary` is the small, deliberately dull part kept readable: enough to list
-- flows and render a report without decrypting anything.

create table if not exists flows (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references users (id) on delete cascade,

  -- Null is allowed: a flow with no variables to resolve needs no environment.
  environment_id       uuid references flow_environments (id) on delete set null,

  project_key          text not null,
  -- The flow's id in the user's local collections file, so re-uploading the
  -- same flow updates this row instead of creating a second one.
  client_flow_id       text not null,
  name                 text not null,

  definition_encrypted bytea not null,
  definition_iv        bytea not null,
  definition_tag       bytea not null,
  key_version          integer not null default 1,

  -- [{ nodeId, name, method, path }] — no headers, no bodies, no auth.
  summary              jsonb not null default '[]'::jsonb,
  step_count           integer not null default 0,

  -- Every host this flow calls, checked against the SSRF guard at upload time
  -- and shown to the user before they confirm. A flow that resolves to a
  -- private address cannot be scheduled, and this is the record of why.
  hosts                text[] not null default '{}',

  -- Where reports go. Empty means the owner's own address.
  recipients           text[] not null default '{}',

  last_run_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,

  unique (user_id, project_key, client_flow_id)
);

create index if not exists flows_user_idx on flows (user_id, updated_at desc);

drop trigger if exists flows_set_updated_at on flows;
create trigger flows_set_updated_at
  before update on flows
  for each row execute function set_updated_at();

alter table flows enable row level security;
