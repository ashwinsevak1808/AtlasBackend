-- 011_flow_runs.sql
-- What happened, each time a flow ran.
--
-- One row per run, one row per step. A run triggered by hand from the
-- workspace and a run fired by the scheduler are the same shape on purpose —
-- `trigger` is the only difference — so the report, the history and the
-- exports do not have to care which it was.

create table if not exists flow_runs (
  id            uuid primary key default gen_random_uuid(),
  flow_id       uuid not null references flows (id) on delete cascade,
  user_id       uuid not null references users (id) on delete cascade,

  trigger       text not null default 'manual' check (trigger in ('manual', 'scheduled')),

  --   queued  — accepted, not started
  --   running — in flight
  --   passed  — every step succeeded
  --   failed  — the flow ran, some step did not pass
  --   error   — the run itself broke: bad definition, a cycle, no environment
  status        text not null default 'queued'
                  check (status in ('queued', 'running', 'passed', 'failed', 'error')),

  total_steps   integer not null default 0,
  passed_steps  integer not null default 0,
  failed_steps  integer not null default 0,
  skipped_steps integer not null default 0,

  started_at    timestamptz,
  finished_at   timestamptz,
  duration_ms   integer,

  -- Set only when status is 'error'. A failing assertion is not this.
  error         text,

  -- Whether the report email went out, and to how many addresses.
  report_sent   boolean not null default false,

  created_at    timestamptz not null default now()
);

create index if not exists flow_runs_flow_idx on flow_runs (flow_id, created_at desc);
create index if not exists flow_runs_user_idx on flow_runs (user_id, created_at desc);

alter table flow_runs enable row level security;


-- One row per node, in the order they executed.
create table if not exists flow_run_steps (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid not null references flow_runs (id) on delete cascade,

  -- Position in the resolved order, so a report reads top to bottom.
  position       integer not null,

  node_id        text not null,
  name           text not null,
  method         text not null,
  -- Query string stripped: an API key travels there often enough that keeping
  -- the raw URL would put one in a table that is otherwise safe to read.
  url            text not null,

  status         text not null check (status in ('ok', 'failed', 'skipped')),
  status_code    integer,
  duration_ms    integer,
  size_bytes     integer,

  -- Why it failed, in a sentence. Transport failures land here too.
  error          text,

  -- A truncated response body, so a report can show what came back rather
  -- than only that something went wrong. Capped in the engine, and the user
  -- is told this is stored before they upload the flow.
  response_excerpt text,

  created_at     timestamptz not null default now(),

  unique (run_id, position)
);

create index if not exists flow_run_steps_run_idx on flow_run_steps (run_id, position);

alter table flow_run_steps enable row level security;

-- Housekeeping. Runs accumulate forever otherwise:
--   delete from flow_runs where created_at < now() - interval '90 days';
