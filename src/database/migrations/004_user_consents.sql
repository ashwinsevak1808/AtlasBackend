-- 004_user_consents.sql
-- Marketing consent, as a log rather than a boolean.
--
-- A boolean column answers "may we email them" and nothing else. If someone
-- asks when consent was given, from which screen, or against which version of
-- the privacy policy, a boolean cannot answer and the record is worthless.
-- This table is append-only: withdrawing consent inserts a row with
-- granted = false. The current answer is the newest row for that kind.

create table if not exists user_consents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,

  kind       text not null check (kind in ('product_updates', 'terms', 'privacy')),
  granted    boolean not null,

  -- Which text they agreed to, e.g. '2026-08-17'. Bump when the policy changes.
  version    text,

  -- Where the answer came from: 'onboarding', 'settings', 'unsubscribe-link'.
  source     text,

  ip         inet,
  user_agent text,

  created_at timestamptz not null default now()
);

create index if not exists user_consents_user_kind_idx
  on user_consents (user_id, kind, created_at desc);

alter table user_consents enable row level security;

-- Current consent per user and kind. Query this, never the raw table, or you
-- will read a withdrawn consent as if it still stood.
create or replace view user_consents_current as
select distinct on (user_id, kind)
  user_id, kind, granted, version, source, created_at
from user_consents
order by user_id, kind, created_at desc;
