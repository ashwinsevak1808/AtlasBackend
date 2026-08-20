import bcrypt from 'bcrypt';
import { config } from '../config/env.js';

/**
 * Password hashing.
 *
 * bcrypt rather than a bare hash: the cost factor is what makes a stolen
 * `users` dump expensive to crack, and it is tunable as hardware improves
 * without invalidating existing hashes.
 */

/* bcrypt silently ignores everything past 72 bytes of input. A user who set a
   100-character passphrase would find the first 72 characters were enough to
   sign in, which is not what they were promised. Reject instead. */
const MAX_PASSWORD_BYTES = 72;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.bcryptRounds);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  /* bcrypt.compare throws on a malformed hash rather than returning false. */
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/**
 * Why a password is not acceptable, or null if it is.
 *
 * Deliberately modest: length is what actually matters, and rules demanding a
 * symbol mostly produce `Password1!`. The upper bound is bcrypt's, not ours.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters.';
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return 'That password is too long. Use 72 characters or fewer.';
  }
  if (!/[a-z]/i.test(password)) return 'Include at least one letter.';
  if (!/\d/.test(password)) return 'Include at least one number.';
  return null;
}

/**
 * Burns roughly the time a real verification would take.
 *
 * Sign-in for an address with no account would otherwise answer far faster
 * than one with an account, and that difference is enough to enumerate which
 * addresses are registered.
 */
export async function fakeVerifyDelay(): Promise<void> {
  await bcrypt.hash('timing-equaliser', config.bcryptRounds);
}
