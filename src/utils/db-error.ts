/**
 * Turning a Postgres failure into something a person can act on.
 *
 * Every unexpected error used to reach the client as "Something went wrong on
 * our end." That is the right answer for a genuine surprise, and the wrong one
 * for the two failures this project actually hits: the migrations have not
 * been run, or the database is not reachable. Both have an obvious fix, and
 * hiding it behind a generic 500 means reading server logs to find out that a
 * table is missing.
 *
 * Only failures whose cause is unambiguous are translated. Anything else keeps
 * the generic message, because guessing at a cause is worse than admitting
 * there isn't one.
 */

export interface TranslatedError {
  statusCode: number;
  message: string;
  code: string;
}

/** Postgres puts the offending relation in the message; pull it out to name it. */
const relationIn = (message: string): string | null =>
  /relation "([^"]+)" does not exist/.exec(message)?.[1] ?? null;

/** Which migration creates a given table, so the message can say which to run. */
const MIGRATIONS: Record<string, string> = {
  users: '002_users.sql',
  user_profiles: '003_user_profiles.sql',
  user_consents: '004_user_consents.sql',
  user_consents_current: '004_user_consents.sql',
  sessions: '005_sessions.sql',
  otp_codes: '006_otp_codes.sql',
  auth_events: '007_auth_events.sql',
  organizations: '008_organizations.sql',
  organization_members: '008_organizations.sql',
  organization_invites: '008_organizations.sql',
  flow_environments: '009_flow_environments.sql',
  flows: '010_flows.sql',
  flow_runs: '011_flow_runs.sql',
  flow_run_steps: '011_flow_runs.sql',
  flow_schedules: '012_flow_schedules.sql',
};

export function translateDbError(err: unknown): TranslatedError | null {
  if (!err || typeof err !== 'object') return null;

  const error = err as { code?: string; message?: string; constraint?: string; detail?: string };
  const code = error.code ?? '';
  const message = error.message ?? '';

  /* Not reachable at all. On this project that is nearly always the Supabase
     direct host, which is IPv6-only — the pooler is the IPv4 route. */
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      statusCode: 503,
      code: 'db_unreachable',
      message:
        'The database host could not be resolved. If this is Supabase, the direct ' +
        '`db.<ref>.supabase.co` host is IPv6-only — use the transaction pooler ' +
        'connection string instead.',
    };
  }

  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return {
      statusCode: 503,
      code: 'db_unreachable',
      message: 'The database refused the connection. Check DATABASE_URL and that the database is running.',
    };
  }

  /* 42P01 undefined_table — the migrations have not been run. */
  if (code === '42P01') {
    const relation = relationIn(message);
    const file = relation ? MIGRATIONS[relation] : undefined;
    return {
      statusCode: 503,
      code: 'schema_missing',
      message: file
        ? `The database is missing the "${relation}" table. Run Backend/src/database/migrations/${file}.`
        : 'The database schema is not set up. Run the files in Backend/src/database/migrations in order.',
    };
  }

  /* 42883 undefined_function / 42704 undefined_object — 001 was skipped, so
     gen_random_uuid() or citext is absent. */
  if (code === '42883' || code === '42704') {
    return {
      statusCode: 503,
      code: 'schema_missing',
      message:
        'The database is missing an extension or function the schema needs. Run ' +
        'Backend/src/database/migrations/001_extensions.sql first, then the rest in order.',
    };
  }

  /* 42P10 — an ON CONFLICT target with no matching unique constraint. Always
     means a table was created by an older version of its migration. */
  if (code === '42P10' || /no unique or exclusion constraint matching/i.test(message)) {
    return {
      statusCode: 503,
      code: 'schema_outdated',
      message:
        'A table in the database is missing a constraint this build needs. Run the ' +
        'newest migrations in Backend/src/database/migrations — 013_flow_schedules_unique.sql ' +
        'fixes this for schedules.',
    };
  }

  /* 42703 undefined_column — schema is present but older than this code. */
  if (code === '42703') {
    return {
      statusCode: 503,
      code: 'schema_outdated',
      message:
        'The database schema is older than this build. Run any migrations in ' +
        'Backend/src/database/migrations you have not applied yet.',
    };
  }

  if (code === '28P01' || code === '28000') {
    return {
      statusCode: 503,
      code: 'db_auth_failed',
      message: 'The database rejected our credentials. Check the password in DATABASE_URL.',
    };
  }

  if (code === '3D000') {
    return {
      statusCode: 503,
      code: 'db_missing',
      message: 'That database does not exist. Check the database name in DATABASE_URL.',
    };
  }

  /* 23505 unique_violation — a duplicate is the caller's business, not a fault. */
  if (code === '23505') {
    return {
      statusCode: 409,
      code: 'duplicate',
      message: 'That already exists.',
    };
  }

  /* 23514 check_violation — a value outside what a CHECK constraint allows.
     Usually an enum the frontend and the migration disagree about. */
  if (code === '23514') {
    return {
      statusCode: 400,
      code: 'value_not_allowed',
      message: error.constraint
        ? `A value was rejected by the database rule "${error.constraint}".`
        : 'One of those values is not one the database allows.',
    };
  }

  if (code === '23503') {
    return {
      statusCode: 400,
      code: 'missing_reference',
      message: 'That refers to something which no longer exists.',
    };
  }

  /* 53300 too_many_connections — the direct Supabase host has a low ceiling. */
  if (code === '53300') {
    return {
      statusCode: 503,
      code: 'db_pool_exhausted',
      message:
        'The database is out of connections. Use the transaction pooler connection ' +
        'string and keep DATABASE_POOL_MAX small.',
    };
  }

  return null;
}
