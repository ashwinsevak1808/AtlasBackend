-- 001_extensions.sql
-- Run this first. Every migration after it assumes these exist.

-- gen_random_uuid() for primary keys.
create extension if not exists "pgcrypto";

-- citext gives us a case-insensitive email column, so "Ash@x.com" and
-- "ash@x.com" collide on the unique index instead of becoming two accounts.
-- Normalising in application code alone would leave that to be remembered at
-- every call site.
create extension if not exists "citext";

-- Every table with an updated_at column hangs this trigger off it, so "when
-- was this row last touched" is answered by the database rather than by
-- remembering to set a column in each UPDATE.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
