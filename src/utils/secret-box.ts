import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from './app-error.js';

/**
 * Sealing the things we are trusted to hold.
 *
 * A flow that runs at 3am needs the API token it authenticates with, so that
 * token has to be in our database. This is what makes that defensible: it is
 * AES-256-GCM, so the ciphertext is also authenticated — a row someone edited
 * in the database fails to open rather than decrypting to something else.
 *
 * The key lives in the environment, not the database. A dump of Postgres on
 * its own is therefore useless, which is the specific attack worth caring
 * about: backups get copied around far more casually than environments do.
 *
 * Rotation: `keyVersion` is stored beside every ciphertext. To rotate, add the
 * new key, seal new rows with it, and re-seal old rows in the background. The
 * version is what makes that possible without a flag day — today there is one
 * key and every row says version 1.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; /* 96 bits, what GCM is specified for */

export const CURRENT_KEY_VERSION = 1;

export interface SealedValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

let cachedKey: Buffer | null = null;

/**
 * The master key, or a refusal that says how to fix it.
 *
 * Deliberately not checked at boot: the rest of the API works without it, and
 * an instance that will not start because an unused feature is unconfigured is
 * worse than one that declines that feature clearly.
 */
function masterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = env.ENCRYPTION_KEY;
  if (!raw) {
    throw new AppError(
      503,
      'Scheduled and server-side runs are not available: this server has no encryption key.',
      'encryption_unconfigured',
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new AppError(
      503,
      'ENCRYPTION_KEY must be 32 bytes, base64 encoded. Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      'encryption_misconfigured',
    );
  }

  cachedKey = key;
  return key;
}

/** True when this server can hold secrets at all. Checked before offering to. */
export function encryptionAvailable(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

export function seal(plaintext: string): SealedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION };
}

export function open(sealed: SealedValue): string {
  /* A future key version means a row sealed by a newer deployment. Saying so
     is more useful than the "unsupported state" the decipher would throw. */
  if (sealed.keyVersion !== CURRENT_KEY_VERSION) {
    throw new AppError(
      500,
      `That was encrypted with key version ${sealed.keyVersion}, and this server has ${CURRENT_KEY_VERSION}.`,
      'key_version_mismatch',
    );
  }

  const decipher = createDecipheriv(ALGORITHM, masterKey(), sealed.iv);
  decipher.setAuthTag(sealed.tag);

  try {
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    /* GCM's tag check failed: the row was altered, or the key is wrong. Both
       are worth the same blunt answer, and neither should leak which. */
    throw new AppError(
      500,
      'That data could not be decrypted. It may have been altered, or the encryption key has changed.',
      'decryption_failed',
    );
  }
}

/** Seals any JSON-serialisable value. */
export const sealJson = (value: unknown): SealedValue => seal(JSON.stringify(value));

export const openJson = <T>(sealed: SealedValue): T => JSON.parse(open(sealed)) as T;
