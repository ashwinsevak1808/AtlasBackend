import { query, queryOne } from '../../database/pool.js';
import type { SubscriberContext, SubscriberRow } from './subscriber.types.js';

/**
 * Every SQL statement the subscriber list runs.
 *
 * Same split as the auth module: nothing above this file writes a query and
 * nothing in it makes a decision.
 */

const COLUMNS = `
  id, email, status, source, referrer, utm_source, utm_medium, utm_campaign,
  unsubscribe_token, subscribed_at, unsubscribed_at, created_at, updated_at
`;

/* Postgres rejects a malformed inet outright, so a proxy sending a
   comma-separated forwarded-for chain would turn a sign-up into a 500. Same
   guard the auth repository uses. */
const toInet = (ip: string | null | undefined): string | null => {
  if (!ip) return null;
  const first = ip.split(',')[0]?.trim() ?? '';
  return /^[0-9a-fA-F:.]+$/.test(first) && first.length > 2 ? first : null;
};

export const findByEmail = (email: string): Promise<SubscriberRow | null> =>
  queryOne<SubscriberRow>(`select ${COLUMNS} from subscribers where email = $1`, [email]);

/**
 * Adds an address, or brings a previously unsubscribed one back.
 *
 * One statement rather than select-then-insert: two browser tabs submitting
 * the same address at once would otherwise race past the check and one would
 * fail on the unique constraint. `on conflict` makes the second a no-op that
 * still returns the row.
 *
 * Attribution is only written on first insert. Someone who unsubscribes and
 * returns via a different link has a first answer already, and overwriting it
 * would quietly rewrite history.
 */
export async function upsert(
  email: string,
  context: SubscriberContext,
): Promise<{ row: SubscriberRow; created: boolean }> {
  const row = await queryOne<SubscriberRow & { inserted: boolean }>(
    `
    insert into subscribers
      (email, source, referrer, utm_source, utm_medium, utm_campaign, ip, user_agent)
    values ($1, $2, $3, $4, $5, $6, $7, $8)
    on conflict (email) do update
      set status          = 'subscribed',
          unsubscribed_at = null,
          /* Re-subscribing is a fresh consent, so the date moves. */
          subscribed_at   = case
                              when subscribers.status = 'unsubscribed' then now()
                              else subscribers.subscribed_at
                            end
    returning ${COLUMNS}, (xmax = 0) as inserted
    `,
    [
      email,
      context.source ?? null,
      context.referrer ?? null,
      context.utmSource ?? null,
      context.utmMedium ?? null,
      context.utmCampaign ?? null,
      toInet(context.ip),
      context.userAgent ?? null,
    ],
  );

  /* `queryOne` is only null when nothing came back, which `returning` on an
     upsert cannot produce. Narrowing rather than asserting keeps the caller
     honest if that ever changes. */
  if (!row) throw new Error('The subscribe write returned no row.');

  /* xmax = 0 marks a genuine insert. On a conflict update it holds the
     locking transaction id, which is how one statement can still tell the
     caller whether this address is new. */
  const { inserted, ...rest } = row;
  return { row: rest as SubscriberRow, created: inserted };
}

/** Removes an address by its emailed token, or by the address itself. */
export async function unsubscribe(by: {
  token?: string;
  email?: string;
}): Promise<SubscriberRow | null> {
  const [column, value] = by.token ? ['unsubscribe_token', by.token] : ['email', by.email];
  return queryOne<SubscriberRow>(
    `
    update subscribers
       set status = 'unsubscribed', unsubscribed_at = now()
     where ${column} = $1
       and status = 'subscribed'
    returning ${COLUMNS}
    `,
    [value],
  );
}

/** How many addresses are currently on the list. */
export async function countActive(): Promise<number> {
  const rows = await query<{ count: number }>(
    `select count(*)::int as count from subscribers where status = 'subscribed'`,
  );
  return rows[0]?.count ?? 0;
}
