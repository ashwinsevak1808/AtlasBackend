-- 009_flow_environments.sql
-- Variable sets a flow resolves {{placeholders}} against.
--
-- Their own table rather than a copy embedded in each flow, so rotating a
-- token is one edit instead of one edit per flow that happened to use it.
-- A flow references one of these by id.
--
-- `values_encrypted` is the whole map, sealed with AES-256-GCM. It is the
-- reason this table exists in the shape it does: baseUrl is harmless, but the
-- API token beside it is live access to somebody's staging environment, and
-- storing that as readable text would be indefensible in a security review.
-- Only the *names* are kept in the clear, so the UI can show what a set
-- contains without anything having to decrypt it.

create table if not exists flow_environments (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users (id) on delete cascade,

  -- Which workspace it belongs to, as the client knows it. Opaque here.
  project_key      text not null,
  name             text not null,

  -- AES-256-GCM. iv and tag are stored beside the ciphertext because they are
  -- not secret and are required to open it.
  values_encrypted bytea not null,
  values_iv        bytea not null,
  values_tag       bytea not null,
  -- Which master key sealed this, so a key rotation can find and re-seal rows
  -- rather than orphaning them.
  key_version      integer not null default 1,

  -- Names only, never values. Lets the UI list what is in here.
  value_keys       text[] not null default '{}',

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (user_id, project_key, name)
);

create index if not exists flow_environments_user_idx
  on flow_environments (user_id, project_key);

drop trigger if exists flow_environments_set_updated_at on flow_environments;
create trigger flow_environments_set_updated_at
  before update on flow_environments
  for each row execute function set_updated_at();

alter table flow_environments enable row level security;
