-- 012_flow_schedules.sql
--
-- THE SCHEDULER. Written now so the shape is settled, wired to nothing yet —
-- the engine that executes a flow comes first, and this is a thin layer on top
-- of it. Running this migration is safe and changes nothing today.
--
-- The design point worth keeping: `next_run_at` plus a claim. A worker takes
-- due rows with FOR UPDATE SKIP LOCKED, which is what stops two Cloud Run
-- instances firing the same schedule twice. Cloud Run also scales to zero, so
-- something external has to knock — a Cloud Scheduler job hitting the tick
-- endpoint. An in-process cron would go quiet the moment the instance did.

create table if not exists flow_schedules (
  id             uuid primary key default gen_random_uuid(),
  flow_id        uuid not null references flows (id) on delete cascade,
  user_id        uuid not null references users (id) on delete cascade,

  enabled        boolean not null default true,

  --   cron — a repeating expression, read in `timezone`
  --   once — a single run at `next_run_at`, disabled afterwards
  kind           text not null default 'cron' check (kind in ('cron', 'once')),
  cron           text,
  -- IANA name, e.g. 'Asia/Kolkata'. Stored because "07:00" is meaningless
  -- without it, and because a UTC offset breaks twice a year.
  timezone       text not null default 'UTC',

  -- The queue. Indexed, and the only column the tick reads to find work.
  next_run_at    timestamptz,
  last_run_at    timestamptz,

  -- Held while a worker is running it, so a crash cannot wedge the row
  -- forever: a claim older than the lease is fair game again.
  claimed_at     timestamptz,
  claimed_by     text,

  -- Stops a flow that fails every time from emailing someone hourly forever.
  consecutive_failures integer not null default 0,
  disabled_reason      text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint flow_schedules_cron_present
    check (kind <> 'cron' or cron is not null),

  -- One schedule per flow. Saving the schedule again edits it rather than
  -- stacking a second one, and the upsert relies on this to do that.
  unique (flow_id)
);

-- The tick's only query: enabled, due, unclaimed.
create index if not exists flow_schedules_due_idx
  on flow_schedules (next_run_at)
  where enabled and next_run_at is not null;

create index if not exists flow_schedules_flow_idx on flow_schedules (flow_id);

drop trigger if exists flow_schedules_set_updated_at on flow_schedules;
create trigger flow_schedules_set_updated_at
  before update on flow_schedules
  for each row execute function set_updated_at();

alter table flow_schedules enable row level security;
