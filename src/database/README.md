# Database

Postgres, hosted on Supabase. We use Supabase as a database and nothing else —
**not** Supabase Auth. The `users` table here is ours, the password hashing is
ours, and the session lives in the `sessions` table below.

There is no migration runner. Each file in `migrations/` is a plain script you
paste into the Supabase SQL editor, in order. They are idempotent
(`create table if not exists`, `create or replace`), so re-running one is safe.

## Run order

| # | File | Creates | Needed for |
|---|------|---------|-----------|
| 001 | `001_extensions.sql` | `pgcrypto`, `citext`, `set_updated_at()` | everything |
| 002 | `002_users.sql` | `users` | register, login |
| 003 | `003_user_profiles.sql` | `user_profiles` | onboarding answers |
| 004 | `004_user_consents.sql` | `user_consents`, `user_consents_current` | the product-updates opt-in |
| 005 | `005_sessions.sql` | `sessions` | staying signed in |
| 006 | `006_otp_codes.sql` | `otp_codes` | email verification, password reset |
| 007 | `007_auth_events.sql` | `auth_events` | audit trail |
| 008 | `008_organizations.sql` | `organizations`, `organization_members`, `organization_invites` | part two, not yet wired |
| 009 | `009_flow_environments.sql` | `flow_environments` | variables a scheduled flow resolves against |
| 010 | `010_flows.sql` | `flows` | flows uploaded so the server can run them |
| 011 | `011_flow_runs.sql` | `flow_runs`, `flow_run_steps` | run history and reports |
| 012 | `012_flow_schedules.sql` | `flow_schedules` | the scheduler |
| 013 | `013_flow_schedules_unique.sql` | one-schedule-per-flow constraint | **run this if you applied 012 before 2026-08-18** |

001 through 007 are required for the auth feature to work. 009 through 012 are
required for server-side flow runs and schedules. 008 is safe to run now and
changes nothing until the organization endpoints exist.

**013 repairs a table, it does not create one.** 012 shipped briefly without a
unique constraint on `flow_schedules.flow_id`, and `create table if not exists`
means re-running it does nothing to a table that already exists. Without the
constraint, saving a schedule fails with *"there is no unique or exclusion
constraint matching the ON CONFLICT specification"* — a 500. Run 013 if you
applied 012 before 2026-08-18; it is idempotent, so running it regardless is
harmless.

**009 through 012 need `ENCRYPTION_KEY` set** in the environment before a flow
can be uploaded — the definitions and environment values are sealed with it,
and the server declines to store them in the clear. Generate one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Changing that key afterwards makes every stored flow and environment
unreadable. There is a `key_version` column on both tables so a rotation can
re-seal rows rather than orphan them; nothing does that yet.

## Running them

Supabase dashboard → SQL Editor → New query → paste one file → Run. Repeat in
numerical order.

Or from a terminal, if you have `psql` and the direct connection string:

```bash
for f in src/database/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

To confirm afterwards:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
```

You should see: `auth_events`, `flow_environments`, `flow_run_steps`,
`flow_runs`, `flow_schedules`, `flows`, `organization_invites`,
`organization_members`, `organizations`, `otp_codes`, `sessions`,
`user_consents`, `user_profiles`, `users`.

## Row Level Security

Every table is created with `alter table ... enable row level security` and
**no policy**.

This matters more than it looks. Supabase publishes every table in the `public`
schema through PostgREST, and the publishable key that reaches this is in the
browser. Without RLS, anyone who opens the network tab on the site could read
the whole `users` table through that API. With RLS on and no policy, PostgREST
returns nothing to `anon` and `authenticated`.

The backend is unaffected: it connects over `DATABASE_URL` as the table owner,
and the owner bypasses RLS.

**Do not add a policy to any of these tables** unless you specifically intend
that table to be readable by a browser holding only the publishable key. None
of them should be.

## Adding a table later

1. New file, next number, `migrations/0NN_thing.sql`.
2. `updated_at timestamptz not null default now()` plus the `set_updated_at`
   trigger if the row is ever updated.
3. `alter table thing enable row level security;` as the last line.
4. Add a row to the table above.

## Housekeeping

Nothing prunes itself except sessions, which are cleaned opportunistically on
sign-in. If the database has been running a while:

```sql
delete from sessions    where expires_at < now() - interval '30 days';
delete from otp_codes   where created_at < now() - interval '7 days';
delete from auth_events where created_at < now() - interval '180 days';
delete from flow_runs   where created_at < now() - interval '90 days';
```

## Connection

`DATABASE_URL` in `.env.local` / `.env.prod`. The pool lives in
[`pool.ts`](./pool.ts) and is the only place in the backend that talks to
Postgres directly — modules go through a repository, repositories go through
the pool.

One deployment note: the `db.<ref>.supabase.co:5432` host is the *direct*
connection and has a low connection ceiling. Cloud Run scales to many
instances, each with its own pool, and will exhaust it. For production use the
pooler host (`aws-0-<region>.pooler.supabase.com:6543`, transaction mode) and
keep `max` in the pool small.
