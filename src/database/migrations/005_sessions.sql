-- 005_sessions.sql
-- Server-side sessions, not JWTs.
--
-- A JWT cannot be revoked before it expires, which means suspending an account
-- or signing out every device does nothing until the clock runs out. Sessions
-- in a table cost one indexed lookup per request and make both instant.
--
-- Only the SHA-256 of the token is stored. A leaked dump of this table is
-- therefore not a list of live sessions.

create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,

  token_hash   text not null unique,

  user_agent   text,
  ip           inet,

  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz
);

create index if not exists sessions_user_idx on sessions (user_id);

-- The hot path: resolve a token to a live session. Partial, because expired and
-- revoked rows are never the answer and only make the index bigger.
create index if not exists sessions_live_idx
  on sessions (token_hash)
  where revoked_at is null;

alter table sessions enable row level security;

-- Housekeeping. Sessions are pruned opportunistically on sign-in, but run this
-- if the table has been left alone for a long time.
--   delete from sessions where expires_at < now() - interval '30 days';
