import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Opaque tokens and the codes we email.
 *
 * Session tokens, invite tokens and OTPs are all stored as a SHA-256 digest
 * rather than as themselves, so a dump of the table is not a set of working
 * credentials. SHA-256 is right here and bcrypt is not: these values are 256
 * bits of randomness (or, for an OTP, rate-limited and short-lived), so there
 * is nothing to slow an attacker down against — and a session lookup happens
 * on every request, where a bcrypt comparison would be felt.
 */

/** 256 bits, hex encoded. Used for session and invite tokens. */
export const randomToken = (): string => randomBytes(32).toString('hex');

export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** A six-digit code, uniformly distributed and zero-padded. */
export const randomOtp = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

/**
 * Constant-time string comparison.
 *
 * Only meaningful for values of the same length, which is why the length check
 * comes first and is allowed to short-circuit.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Emails are stored in a citext column, but normalise before comparing anyway. */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();
