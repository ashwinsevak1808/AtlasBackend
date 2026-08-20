import pg from 'pg';
import { env } from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * The only place in the backend that talks to Postgres.
 *
 * Modules call a repository, repositories call the helpers here. Nothing
 * constructs its own client, so pool size, SSL and slow-query logging are
 * decided once.
 */

const { Pool } = pg;

/* Postgres returns bigint as a string to avoid silent precision loss. Every
   count() we run is small enough to be a number, and having them arrive as
   strings has surprised every codebase that left it alone. */
pg.types.setTypeParser(20, (value: string) => Number(value));

const isLocalHost = /@(localhost|127\.0\.0\.1)/.test(env.DATABASE_URL ?? '');

export const pool = new Pool({
  connectionString: env.DATABASE_URL,

  /* Supabase terminates TLS with a certificate Node does not trust out of the
     box, so verification is off against the hosted database. The connection is
     still encrypted; what we lose is protection against an active
     man-in-the-middle between Cloud Run and Supabase. Set DATABASE_CA to the
     Supabase CA certificate to get verification back. */
  ssl: isLocalHost
    ? false
    : env.DATABASE_CA
      ? { ca: env.DATABASE_CA }
      : { rejectUnauthorized: false },

  /* Cloud Run runs many instances, each with its own pool, against a database
     with a modest connection ceiling. A small max per instance is what keeps
     that from running out. */
  max: Number(env.DATABASE_POOL_MAX),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  /* An idle client dying is normal — the pool replaces it. Worth a line, not a
     crash: throwing here would take the process down for a recoverable event. */
  logger.error(`Postgres idle client error: ${err.message}`);
});

const SLOW_QUERY_MS = 500;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const started = Date.now();
  try {
    const result = await pool.query<T>(text, params as unknown[]);
    const elapsed = Date.now() - started;
    if (elapsed > SLOW_QUERY_MS) {
      logger.warn(`Slow query (${elapsed}ms): ${text.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    }
    return result.rows;
  } catch (err: any) {
    /* Log the statement but never the parameters — they carry password hashes,
       OTP hashes and session tokens. */
    logger.error(`Query failed: ${text.replace(/\s+/g, ' ').trim().slice(0, 200)} — ${err.message}`);
    throw err;
  }
}

/** The single row, or null. Use when the query is keyed on a unique column. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, rolling back if it throws.
 *
 * Registration writes to four tables and must not leave a user without a
 * session, or a consent row without a user.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Called at boot so a bad DATABASE_URL fails loudly rather than on first request. */
export async function verifyConnection(): Promise<void> {
  const row = await queryOne<{ now: Date }>('select now() as now');
  logger.info(`Postgres connected (server time ${row?.now.toISOString()})`);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
