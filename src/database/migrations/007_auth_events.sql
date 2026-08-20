-- 007_auth_events.sql
-- An audit trail for everything that touches an account.
--
-- This is the table a security review asks for by name. It is also the only
-- way to answer "was this account signed in from somewhere it should not have
-- been" after the fact, since sessions rows disappear when they are revoked.
--
-- user_id is nullable: a failed sign-in for an address with no account is
-- exactly the event worth recording, and there is no user to attach it to.

create table if not exists auth_events (
  id         uuid primary key default gen_random_uuid(),

  user_id    uuid references users (id) on delete set null,
  email      citext,

  kind       text not null check (kind in (
               'register',
               'login_success',
               'login_failed',
               'logout',
               'otp_issued',
               'otp_verified',
               'otp_failed',
               'password_reset',
               'onboarding_completed',
               'account_locked'
             )),

  -- Anything worth knowing that is not a column: the reason a login failed,
  -- which purpose a code was for. Never put a credential in here.
  detail     jsonb not null default '{}'::jsonb,

  ip         inet,
  user_agent text,

  created_at timestamptz not null default now()
);

create index if not exists auth_events_user_idx  on auth_events (user_id, created_at desc);
create index if not exists auth_events_email_idx on auth_events (email, created_at desc);
create index if not exists auth_events_kind_idx  on auth_events (kind, created_at desc);

alter table auth_events enable row level security;

-- Housekeeping:
--   delete from auth_events where created_at < now() - interval '180 days';
