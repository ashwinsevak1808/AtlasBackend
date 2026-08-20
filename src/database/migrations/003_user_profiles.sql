-- 003_user_profiles.sql
-- The onboarding answers. Separate from users because this is product
-- analytics, not credentials: it is the table you would hand to whoever asks
-- "who is actually using this", and it contains nothing that grants access.

create table if not exists user_profiles (
  user_id           uuid primary key references users (id) on delete cascade,

  -- Who they are. Drives the copy we show and the segments we can report on.
  persona           text check (persona in (
                      'student', 'developer', 'freelancer',
                      'startup', 'company', 'qa', 'other'
                    )),

  -- Free text, e.g. "Backend Engineer". Optional.
  role_title        text,

  company_name      text,
  company_size      text check (company_size in (
                      '1', '2-10', '11-50', '51-200', '201-1000', '1000+'
                    )),

  -- Where they heard about us. heard_from_detail carries the "other" answer
  -- and the referrer name, so the enum stays small and still reportable.
  heard_from        text check (heard_from in (
                      'search', 'github', 'twitter', 'linkedin', 'youtube',
                      'reddit', 'friend', 'newsletter', 'event', 'other'
                    )),
  heard_from_detail text,

  -- What they came to do. The one answer that should shape the roadmap.
  primary_goal      text check (primary_goal in (
                      'test-apis', 'document-apis', 'understand-codebase',
                      'replace-postman', 'evaluating', 'other'
                    )),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists user_profiles_persona_idx    on user_profiles (persona);
create index if not exists user_profiles_heard_from_idx on user_profiles (heard_from);

drop trigger if exists user_profiles_set_updated_at on user_profiles;
create trigger user_profiles_set_updated_at
  before update on user_profiles
  for each row execute function set_updated_at();

alter table user_profiles enable row level security;
