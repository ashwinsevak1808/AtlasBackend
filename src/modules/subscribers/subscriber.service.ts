import logger from '../../utils/logger.js';
import * as repository from './subscriber.repository.js';
import type { PublicSubscriber, SubscriberContext } from './subscriber.types.js';

/**
 * The product-updates list.
 *
 * Single opt-in, on purpose. A confirmation email needs a mail provider, and
 * none is configured yet (see `services/mailer.ts`); shipping double opt-in
 * against a mailer that logs to the console would leave every subscriber in a
 * pending state nobody could clear. The consent evidence the table records —
 * when, from which screen, from which address — is what makes single opt-in
 * defensible in the meantime.
 */

export async function subscribe(
  email: string,
  context: SubscriberContext,
): Promise<PublicSubscriber> {
  const { row, created } = await repository.upsert(email, context);

  /* The address is deliberately not logged. A subscriber list in the log file
     is a second copy of the data with none of the controls the table has. */
  logger.info(`Subscriber ${created ? 'added' : 'confirmed'} (source: ${context.source ?? 'unknown'})`);

  return {
    email: row.email,
    status: row.status,
    alreadySubscribed: !created,
  };
}

/**
 * Removes an address.
 *
 * Reports success whether or not anything matched. An unsubscribe endpoint
 * that distinguishes the two is a way to test whether an address is on the
 * list, and the person clicking the link only wants to know it worked.
 */
export async function unsubscribe(by: { token?: string; email?: string }): Promise<void> {
  const row = await repository.unsubscribe(by);
  logger.info(`Unsubscribe requested — ${row ? 'removed' : 'no active match'}`);
}

export const countActive = repository.countActive;
