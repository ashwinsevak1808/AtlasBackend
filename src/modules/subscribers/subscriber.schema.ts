import { z } from 'zod';

/**
 * What a subscribe request may contain.
 *
 * The attribution fields come from the page rather than from headers, because
 * `document.referrer` is the only place the original channel survives a
 * client-side navigation. They are therefore untrusted: capped hard, and never
 * interpolated anywhere. Length limits are the whole defence and are enough —
 * nothing here is executed, and the columns are plain text.
 */

const attribution = z.string().trim().max(300).optional().nullable();

export const subscribeSchema = z.object({
  email: z
    .string({ required_error: 'Enter an email address.' })
    .trim()
    .toLowerCase()
    .min(3, 'Enter an email address.')
    .max(254, 'That address is too long.')
    .email('That does not look like an email address.'),

  /* Which surface asked. Constrained, because it is ours to set. */
  source: z.enum(['landing', 'scroll-prompt', 'footer', 'docs']).optional(),

  referrer: attribution,
  utmSource: attribution,
  utmMedium: attribution,
  utmCampaign: attribution,
});

export const unsubscribeSchema = z
  .object({
    token: z.string().trim().min(8).max(128).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
  })
  /* One or the other. A request with neither would otherwise read as valid and
     then quietly match nothing. */
  .refine((body) => Boolean(body.token || body.email), {
    message: 'Give the token from your email, or the address to remove.',
  });

export type SubscribeBody = z.infer<typeof subscribeSchema>;
export type UnsubscribeBody = z.infer<typeof unsubscribeSchema>;
