-- 002_users.sql
-- The account itself. Credentials only: anything we ask during onboarding
-- lives in user_profiles, so this table stays the security-sensitive one and
-- can be reasoned about on its own.

create table if not exists users (
  id                    uuid primary key default gen_random_uuid(),
  email                 citext not null unique,
  password_hash         text not null,

  -- Collected at onboarding, not at registration, so it starts null.
  full_name             text,
  avatar_color          text not null default '#155EBD',

  email_verified        boolean not null default false,
  email_verified_at     timestamptz,

  status                text not null default 'active'
                          check (status in ('active', 'suspended', 'deleted')),

  -- Set when the onboarding questions are answered. Null means the client
  -- should send them to /auth/onboarding after signing in.
  onboarded_at          timestamptz,

  last_login_at         timestamptz,

  -- Brute-force brake. Reset on any successful sign-in.
  failed_login_attempts integer not null default 0,
  locked_until          timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint users_email_not_blank check (length(trim(email::text)) > 0)
);

create index if not exists users_status_idx     on users (status);
create index if not exists users_created_at_idx on users (created_at desc);

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

-- Supabase exposes every table in the public schema through PostgREST, and the
-- publishable key is in the browser. With RLS on and no policy defined, that
-- door is shut: anon and authenticated get nothing. The backend connects as the
-- table owner, which bypasses RLS, so its queries are unaffected.
-- Do not add a policy here unless you intend the table to be readable from a
-- browser holding only the publishable key.
alter table users enable row level security;
