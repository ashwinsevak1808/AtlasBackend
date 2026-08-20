-- 006_otp_codes.sql
-- Six-digit codes for email verification and password reset.
--
-- Keyed by email rather than user_id: a reset can be requested for an address
-- before we are willing to admit whether an account exists for it, and keying
-- on the user would leak that in the shape of the request.
--
-- Rows are kept after use, not deleted, because the resend throttle counts how
-- many were issued for an address in the last hour.

create table if not exists otp_codes (
  id          uuid primary key default gen_random_uuid(),

  email       citext not null,
  purpose     text not null check (purpose in ('verify_email', 'reset_password')),

  -- SHA-256 of the code. The table is not a list of live codes.
  code_hash   text not null,

  attempts    integer not null default 0,
  consumed_at timestamptz,

  ip          inet,

  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- Lookup of the one live code for an address and purpose.
create index if not exists otp_codes_live_idx
  on otp_codes (email, purpose, created_at desc)
  where consumed_at is null;

-- Feeds the "how many codes has this address asked for lately" throttle.
create index if not exists otp_codes_email_created_idx
  on otp_codes (email, created_at desc);

alter table otp_codes enable row level security;

-- Housekeeping:
--   delete from otp_codes where created_at < now() - interval '7 days';
