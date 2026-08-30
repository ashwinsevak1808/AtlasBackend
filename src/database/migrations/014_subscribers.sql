-- 014_subscribers.sql
-- The product-updates list, for people who have no account.
--
-- `user_consents` (004) already records this answer, but only for a signed-in
-- user, and phase 1 has no accounts. Someone who reads the landing page and
-- wants to hear about releases is not a user row and should not be made into
-- one — asking for a password to receive an email is a worse trade than
-- keeping a second, smaller table.
--
-- What is stored is the minimum that makes the list lawful to send to and
-- possible to leave: the address, when they asked, from which screen, and a
-- token that unsubscribes without signing in. `referrer` and the UTM columns
-- are kept because "which channel actually produces subscribers" is the
-- question the list exists to answer, and it cannot be reconstructed later.

create table if not exists subscribers (
  id          uuid primary key default gen_random_uuid(),

  -- citext, so Ada@example.com and ada@example.com are one person and the
  -- unique constraint below actually holds.
  email       citext not null unique,

  status      text not null default 'subscribed'
              check (status in ('subscribed', 'unsubscribed')),

  -- Which surface asked: 'landing', 'scroll-prompt', 'footer'.
  source      text,

  -- Attribution, captured once at sign-up. A later visit overwrites nothing.
  referrer    text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,

  -- Consent evidence. Same reasoning as user_consents: a boolean cannot answer
  -- "when, and from where", and without that the record is not worth holding.
  ip          inet,
  user_agent  text,

  -- Lets someone leave from a link in an email with no account and no login.
  -- Unique so the lookup is a primary-key-shaped read, not a scan.
  --
  -- Built from gen_random_uuid() rather than the more obvious
  -- encode(gen_random_bytes(24), 'hex'): gen_random_bytes comes from pgcrypto,
  -- and Supabase installs pgcrypto into the `extensions` schema, which is not
  -- on the default search_path. The default would resolve on a stock Postgres
  -- and fail here with "function gen_random_bytes(integer) does not exist".
  -- gen_random_uuid is core since Postgres 13, so it needs no extension and no
  -- schema qualification. 32 hex characters, 122 bits of randomness.
  unsubscribe_token text not null unique
              default replace(gen_random_uuid()::text, '-', ''),

  subscribed_at   timestamptz not null default now(),
  unsubscribed_at timestamptz,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- "Who is currently on the list", which is every send. Partial, so it stays
-- small as unsubscribes accumulate.
create index if not exists subscribers_active_idx
  on subscribers (subscribed_at desc)
  where status = 'subscribed';

-- "Which channel produced subscribers", the reporting question.
create index if not exists subscribers_source_idx
  on subscribers (utm_source, source);

drop trigger if exists subscribers_set_updated_at on subscribers;
create trigger subscribers_set_updated_at
  before update on subscribers
  for each row execute function set_updated_at();

alter table subscribers enable row level security;
