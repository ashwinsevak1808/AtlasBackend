/** A row of `subscribers`, exactly as Postgres returns it. */
export interface SubscriberRow {
  id: string;
  email: string;
  status: 'subscribed' | 'unsubscribed';
  source: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  unsubscribe_token: string;
  subscribed_at: Date;
  unsubscribed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Where a sign-up came from, gathered by the page and passed through. */
export interface SubscriberContext {
  source?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * What the browser is told.
 *
 * Deliberately not the row. The unsubscribe token is a capability — anyone
 * holding it can remove that address — so it belongs in an email, never in a
 * response to a form anybody can submit.
 */
export interface PublicSubscriber {
  email: string;
  status: SubscriberRow['status'];
  /** True when this address was already on the list before today. */
  alreadySubscribed: boolean;
}
