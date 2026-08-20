import rateLimit from 'express-rate-limit';
import { isProduction } from '../config/env.js';

/**
 * Rate limits.
 *
 * The general API limit is generous because one dashboard page load fires a
 * dozen requests. The auth limits are not: sign-in and code entry are exactly
 * the endpoints worth guessing against, and no honest user hits them twenty
 * times in a quarter of an hour.
 *
 * Skipped in development, where hitting the limit while testing a flow is the
 * only thing that would ever happen.
 */

const message = (text: string) => ({ success: false, message: text, data: null, errors: [] });

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !isProduction,
  message: message('Too many requests from this IP. Try again in a few minutes.'),
});

/** Sign-in, registration, password reset. Keyed on IP. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !isProduction,
  /* A failed attempt is the one worth counting; a successful sign-in should
     not spend the same budget. */
  skipSuccessfulRequests: true,
  message: message('Too many attempts. Try again in 15 minutes.'),
});

/**
 * Asking for a code to be emailed.
 *
 * Tighter still, because each one sends mail: unthrottled, this endpoint is a
 * way to use our mail reputation to deliver spam to a third party. There is a
 * second, per-address throttle in the service — this one is per IP, and the
 * two catch different abuses.
 */
export const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !isProduction,
  message: message('Too many codes requested. Try again in an hour.'),
});
