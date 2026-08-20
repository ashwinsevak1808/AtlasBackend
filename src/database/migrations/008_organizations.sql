-- 008_organizations.sql
--
-- PART TWO. The schema is here so the shape is settled and the foreign keys
-- exist, but no endpoint writes to these tables yet. Running this migration is
-- safe and changes nothing about how the app behaves today.
--
-- The model: a person signs up as themselves. If they want to share a
-- workspace they create an organization, which they own, and invite others
-- into it by email. Membership is what makes a workspace shared; a user with
-- no organization is the guest-plus-account case and keeps working exactly as
-- they do now.

create table if not exists organizations (
  id         uuid primary key default gen_random_uuid(),

  name       text not null,
  -- URL-safe handle, e.g. 'acme-corp'. Unique across the product.
  slug       citext not null unique,

  created_by uuid references users (id) on delete set null,

  plan       text not null default 'free' check (plan in ('free', 'team', 'enterprise')),
  -- Null means no ceiling. Enforced in application code, not by the database,
  -- because the message shown when it is hit is a product decision.
  seat_limit integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint organizations_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$')
);

drop trigger if exists organizations_set_updated_at on organizations;
create trigger organizations_set_updated_at
  before update on organizations
  for each row execute function set_updated_at();

alter table organizations enable row level security;


-- Who is in an organization, and what they may do.
create table if not exists organization_members (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,

  --   owner  — billing, delete the org, cannot be removed by an admin
  --   admin  — invite and remove members
  --   member — use shared workspaces, invite nobody
  role       text not null default 'member' check (role in ('owner', 'admin', 'member')),

  invited_by uuid references users (id) on delete set null,
  joined_at  timestamptz not null default now(),

  unique (org_id, user_id)
);

create index if not exists organization_members_user_idx on organization_members (user_id);

alter table organization_members enable row level security;

-- Exactly one owner per organization. Transferring ownership must demote the
-- previous owner in the same transaction, which is the behaviour we want:
-- an org with no owner has nobody who can delete it or pay for it.
create unique index if not exists organization_members_single_owner_idx
  on organization_members (org_id)
  where role = 'owner';


-- Pending invitations. A row here is not a member; accepting it inserts into
-- organization_members and stamps accepted_at.
create table if not exists organization_invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,

  email       citext not null,
  role        text not null default 'member' check (role in ('admin', 'member')),

  -- SHA-256 of the invite token, same reasoning as sessions and otp_codes.
  token_hash  text not null unique,

  invited_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,

  accepted_at timestamptz,
  accepted_by uuid references users (id) on delete set null,
  revoked_at  timestamptz
);

create index if not exists organization_invites_email_idx on organization_invites (email);

-- One live invitation per address per organization. Re-inviting someone should
-- replace the old invite rather than leave two valid tokens in their inbox.
create unique index if not exists organization_invites_pending_idx
  on organization_invites (org_id, email)
  where accepted_at is null and revoked_at is null;

alter table organization_invites enable row level security;
