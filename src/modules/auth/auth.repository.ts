import type pg from 'pg';
import { query, queryOne } from '../../database/pool.js';
import logger from '../../utils/logger.js';
import type {
  AuthEventKind,
  OtpPurpose,
  OtpRow,
  ProfileRow,
  RequestMeta,
  SessionRow,
  UserRow,
} from './auth.types.js';

/**
 * Every SQL statement the auth feature runs.
 *
 * Nothing above this file writes a query, and nothing in this file makes a
 * decision. That split is what lets the service read as the flow it is, and
 * lets a schema change be reviewed by reading one file.
 *
 * Each function optionally takes a `pg.PoolClient` so the caller can run it
 * inside a transaction — see `withTransaction` in the pool.
 */

type Client = pg.PoolClient | undefined;

async function run<T extends pg.QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  if (!client) return query<T>(text, params);
  const result = await client.query<T>(text, params as unknown[]);
  return result.rows;
}

const one = async <T extends pg.QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> => (await run<T>(client, text, params))[0] ?? null;

/* Postgres rejects a malformed inet outright, which would turn a proxy sending
   a comma-separated forwarded-for chain into a 500 on sign-in. */
const toInet = (ip: string | null): string | null => {
  if (!ip) return null;
  const first = ip.split(',')[0]?.trim() ?? '';
  return /^[0-9a-fA-F:.]+$/.test(first) && first.length > 2 ? first : null;
};

/* ── Users ──────────────────────────────────────────────────────────────── */

const USER_COLUMNS = `
  id, email, password_hash, full_name, avatar_color, email_verified,
  email_verified_at, status, onboarded_at, last_login_at,
  failed_login_attempts, locked_until, created_at, updated_at
`;

export const findUserByEmail = (email: string, client?: Client): Promise<UserRow | null> =>
  one<UserRow>(client, `select ${USER_COLUMNS} from users where email = $1`, [email]);

export const findUserById = (id: string, client?: Client): Promise<UserRow | null> =>
  one<UserRow>(client, `select ${USER_COLUMNS} from users where id = $1`, [id]);

export const insertUser = (
  values: { email: string; passwordHash: string; avatarColor: string },
  client?: Client,
): Promise<UserRow | null> =>
  one<UserRow>(
    client,
    `insert into users (email, password_hash, avatar_color)
     values ($1, $2, $3)
     returning ${USER_COLUMNS}`,
    [values.email, values.passwordHash, values.avatarColor],
  );

export const markEmailVerified = async (userId: string, client?: Client): Promise<void> => {
  await run(
    client,
    `update users
        set email_verified = true,
            email_verified_at = coalesce(email_verified_at, now()),
            failed_login_attempts = 0,
            locked_until = null
      where id = $1`,
    [userId],
  );
};

export const updatePasswordHash = async (
  userId: string,
  passwordHash: string,
  client?: Client,
): Promise<void> => {
  await run(
    client,
    `update users
        set password_hash = $2, failed_login_attempts = 0, locked_until = null
      where id = $1`,
    [userId, passwordHash],
  );
};

export const recordLoginSuccess = async (userId: string, client?: Client): Promise<void> => {
  await run(
    client,
    `update users
        set last_login_at = now(), failed_login_attempts = 0, locked_until = null
      where id = $1`,
    [userId],
  );
};

/**
 * Counts a failed attempt and locks the account once the ceiling is reached.
 *
 * Done in one statement so two simultaneous attempts cannot both read the same
 * count and write it back — the increment happens in the database, not here.
 */
export const recordLoginFailure = (
  userId: string,
  maxAttempts: number,
  lockMs: number,
  client?: Client,
): Promise<{ failed_login_attempts: number; locked_until: Date | null } | null> =>
  one<{ failed_login_attempts: number; locked_until: Date | null }>(
    client,
    `update users
        set failed_login_attempts = failed_login_attempts + 1,
            locked_until = case
              when failed_login_attempts + 1 >= $2
              then now() + ($3::bigint * interval '1 millisecond')
              else locked_until
            end
      where id = $1
      returning failed_login_attempts, locked_until`,
    [userId, maxAttempts, Math.round(lockMs)],
  );

export const markOnboarded = async (
  userId: string,
  fullName: string,
  client?: Client,
): Promise<void> => {
  await run(
    client,
    `update users
        set full_name = $2, onboarded_at = coalesce(onboarded_at, now())
      where id = $1`,
    [userId, fullName],
  );
};

/* ── Profiles ───────────────────────────────────────────────────────────── */

export const findProfile = (userId: string, client?: Client): Promise<ProfileRow | null> =>
  one<ProfileRow>(client, `select * from user_profiles where user_id = $1`, [userId]);

/** Upsert, so re-running onboarding from settings updates rather than fails. */
export const upsertProfile = async (
  userId: string,
  values: {
    persona: string | null;
    roleTitle: string | null;
    companyName: string | null;
    companySize: string | null;
    heardFrom: string | null;
    heardFromDetail: string | null;
    primaryGoal: string | null;
  },
  client?: Client,
): Promise<void> => {
  await run(
    client,
    `insert into user_profiles
       (user_id, persona, role_title, company_name, company_size,
        heard_from, heard_from_detail, primary_goal)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (user_id) do update set
       persona           = excluded.persona,
       role_title        = excluded.role_title,
       company_name      = excluded.company_name,
       company_size      = excluded.company_size,
       heard_from        = excluded.heard_from,
       heard_from_detail = excluded.heard_from_detail,
       primary_goal      = excluded.primary_goal`,
    [
      userId,
      values.persona,
      values.roleTitle,
      values.companyName,
      values.companySize,
      values.heardFrom,
      values.heardFromDetail,
      values.primaryGoal,
    ],
  );
};

/* ── Consent ────────────────────────────────────────────────────────────── */

export const insertConsent = async (
  values: {
    userId: string;
    kind: 'product_updates' | 'terms' | 'privacy';
    granted: boolean;
    version: string | null;
    source: string;
    meta: RequestMeta;
  },
  client?: Client,
): Promise<void> => {
  await run(
    client,
    `insert into user_consents (user_id, kind, granted, version, source, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      values.userId,
      values.kind,
      values.granted,
      values.version,
      values.source,
      toInet(values.meta.ip),
      values.meta.userAgent,
    ],
  );
};

/** The current answer, from the view — never the raw table. */
export const findCurrentConsent = async (
  userId: string,
  kind: 'product_updates' | 'terms' | 'privacy',
  client?: Client,
): Promise<boolean> => {
  const row = await one<{ granted: boolean }>(
    client,
    `select granted from user_consents_current where user_id = $1 and kind = $2`,
    [userId, kind],
  );
  return row?.granted ?? false;
};

/* ── Sessions ───────────────────────────────────────────────────────────── */

export const insertSession = (
  values: { userId: string; tokenHash: string; expiresAt: Date; meta: RequestMeta },
  client?: Client,
): Promise<SessionRow | null> =>
  one<SessionRow>(
    client,
    `insert into sessions (user_id, token_hash, expires_at, ip, user_agent)
     values ($1, $2, $3, $4, $5)
     returning id, user_id, token_hash, created_at, last_used_at, expires_at, revoked_at`,
    [
      values.userId,
      values.tokenHash,
      values.expiresAt,
      toInet(values.meta.ip),
      values.meta.userAgent?.slice(0, 400) ?? null,
    ],
  );

/**
 * Resolves a token to its session and user in one round trip.
 *
 * This runs on every authenticated request, so it is one query rather than
 * two, and it filters on the same partial index the migration creates.
 */
export const findSessionUser = (
  tokenHash: string,
  client?: Client,
): Promise<(UserRow & { session_id: string }) | null> =>
  one<UserRow & { session_id: string }>(
    client,
    `select s.id as session_id,
            u.id, u.email, u.password_hash, u.full_name, u.avatar_color,
            u.email_verified, u.email_verified_at, u.status, u.onboarded_at,
            u.last_login_at, u.failed_login_attempts, u.locked_until,
            u.created_at, u.updated_at
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()`,
    [tokenHash],
  );

/** Fire-and-forget: a failed touch must not fail the request it belongs to. */
export const touchSession = (sessionId: string): void => {
  void query(`update sessions set last_used_at = now() where id = $1`, [sessionId]).catch(
    (err: Error) => logger.warn(`Could not touch session ${sessionId}: ${err.message}`),
  );
};

export const revokeSession = async (sessionId: string, client?: Client): Promise<void> => {
  await run(client, `update sessions set revoked_at = now() where id = $1 and revoked_at is null`, [
    sessionId,
  ]);
};

/** Used after a password reset: every other device is signed out. */
export const revokeAllUserSessions = async (
  userId: string,
  except: string | null,
  client?: Client,
): Promise<void> => {
  await run(
    client,
    `update sessions
        set revoked_at = now()
      where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2)`,
    [userId, except],
  );
};

/** Opportunistic cleanup, so the table cannot grow without bound. */
export const pruneExpiredSessions = (): void => {
  void query(`delete from sessions where expires_at < now() - interval '30 days'`).catch(
    (err: Error) => logger.warn(`Session prune failed: ${err.message}`),
  );
};

/* ── One-time codes ─────────────────────────────────────────────────────── */

/**
 * Issues a code, invalidating any previous live one for the same purpose.
 *
 * Two valid codes in an inbox is a support ticket waiting to happen, and it
 * doubles the guessing surface.
 */
export const insertOtp = async (
  values: {
    email: string;
    purpose: OtpPurpose;
    codeHash: string;
    expiresAt: Date;
    meta: RequestMeta;
  },
  client?: Client,
): Promise<void> => {
  await run(
    client,
    `update otp_codes set consumed_at = now()
      where email = $1 and purpose = $2 and consumed_at is null`,
    [values.email, values.purpose],
  );
  await run(
    client,
    `insert into otp_codes (email, purpose, code_hash, expires_at, ip)
     values ($1, $2, $3, $4, $5)`,
    [values.email, values.purpose, values.codeHash, values.expiresAt, toInet(values.meta.ip)],
  );
};

export const findLiveOtp = (
  email: string,
  purpose: OtpPurpose,
  client?: Client,
): Promise<OtpRow | null> =>
  one<OtpRow>(
    client,
    `select id, email, purpose, code_hash, attempts, consumed_at, created_at, expires_at
       from otp_codes
      where email = $1 and purpose = $2 and consumed_at is null
      order by created_at desc
      limit 1`,
    [email, purpose],
  );

export const incrementOtpAttempts = (id: string, client?: Client): Promise<{ attempts: number } | null> =>
  one<{ attempts: number }>(
    client,
    `update otp_codes set attempts = attempts + 1 where id = $1 returning attempts`,
    [id],
  );

export const consumeOtp = async (id: string, client?: Client): Promise<void> => {
  await run(client, `update otp_codes set consumed_at = now() where id = $1`, [id]);
};

export const countRecentOtps = async (
  email: string,
  sinceMs: number,
  client?: Client,
): Promise<number> => {
  const row = await one<{ count: number }>(
    client,
    `select count(*)::int as count
       from otp_codes
      where email = $1 and created_at > now() - ($2::bigint * interval '1 millisecond')`,
    [email, Math.round(sinceMs)],
  );
  return row?.count ?? 0;
};

/* ── Audit ──────────────────────────────────────────────────────────────── */

/**
 * Records an auth event. Never awaited by a request path.
 *
 * The audit trail is valuable, but not so valuable that a hiccup writing to it
 * should stop someone signing in.
 */
export const logAuthEvent = (values: {
  kind: AuthEventKind;
  userId?: string | null;
  email?: string | null;
  detail?: Record<string, unknown>;
  meta: RequestMeta;
}): void => {
  void query(
    `insert into auth_events (user_id, email, kind, detail, ip, user_agent)
     values ($1, $2, $3, $4::jsonb, $5, $6)`,
    [
      values.userId ?? null,
      values.email ?? null,
      values.kind,
      JSON.stringify(values.detail ?? {}),
      toInet(values.meta.ip),
      values.meta.userAgent?.slice(0, 400) ?? null,
    ],
  ).catch((err: Error) => logger.warn(`Could not write auth event: ${err.message}`));
};
