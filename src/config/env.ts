import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production' || nodeEnv === 'prod';
const envFile = isProd ? '.env.prod' : '.env.local';

dotenv.config({ path: path.resolve(process.cwd(), envFile) });


const envSchema = z.object({
  PORT: z.string().default('5005'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().default('https://getatlas.space'),

  /* Comma-separated. Every origin allowed to call this API from a browser.
     FRONTEND_URL is added automatically, so this is for the extras: preview
     deployments, localhost during development. */
  CORS_ORIGINS: z.string().default(''),

  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),

  /* Required. Every endpoint past /health needs it, so a missing value should
     stop the process at boot rather than 500 on the first sign-in. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /* PEM for the database CA. Set it to get certificate verification back —
     see the note in src/database/pool.ts. */
  DATABASE_CA: z.string().optional(),
  DATABASE_POOL_MAX: z.string().default('5'),

  /* ── Auth ───────────────────────────────────────────────────────────────
     Sessions are opaque tokens in a table, so there is no signing secret to
     configure and nothing to rotate. */
  SESSION_TTL_DAYS: z.string().default('30'),
  BCRYPT_ROUNDS: z.string().default('12'),
  MAX_LOGIN_ATTEMPTS: z.string().default('8'),
  ACCOUNT_LOCK_MINUTES: z.string().default('15'),

  OTP_TTL_MINUTES: z.string().default('10'),
  /* Accepted in place of the real code while no mail provider is configured,
     and returned in the API response so the flow can be completed. Guarded by
     OTP_DEV_MODE, which must be off in production. */
  OTP_DEV_CODE: z.string().default('123456'),
  OTP_DEV_MODE: z.string().optional(),
  /* Codes an address may request per hour before it is throttled. */
  OTP_MAX_PER_HOUR: z.string().default('5'),

  /* ── Flow runner ────────────────────────────────────────────────────────
     Seals the flow definitions and environment values we are trusted to hold
     so a scheduled run can authenticate. 32 bytes, base64. Without it the
     server-side runner declines rather than storing anything in the clear.
       node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" */
  ENCRYPTION_KEY: z.string().optional(),

  /* Shared secret for the scheduler tick endpoint. There is no user behind
     that request, so a session cannot authorise it. Unset means the scheduler
     is off rather than open. */
  CRON_SECRET: z.string().optional(),

  /* Optional shared secret between the Next.js proxy and this API. When set,
     auth routes require `x-atlas-key` to match. Cloud Run is on the public
     internet and CORS does not apply to server-to-server calls, so this is the
     only thing that stops someone talking to the API directly. */
  INTERNAL_API_KEY: z.string().optional(),

  /* ── Mail ───────────────────────────────────────────────────────────────
     TODO: no provider is configured yet. Until SMTP_HOST is set, codes are
     logged to the server console instead of sent. See src/services/mailer.ts. */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().default('587'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.string().optional(),
  MAIL_FROM: z.string().default('Atlas <no-reply@getatlas.space>'),

  APP_NAME: z.string().default('Atlas'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

const flag = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value);

export const isProduction = env.NODE_ENV === 'production';

/**
 * Derived values, parsed once.
 *
 * Everything above arrives as a string because that is what an environment
 * gives you. Converting at each call site is how one of them ends up being
 * compared as `'10' > 5`.
 */
export const config = {
  appName: env.APP_NAME,

  poolMax: Number(env.DATABASE_POOL_MAX),

  sessionTtlMs: Number(env.SESSION_TTL_DAYS) * 24 * 60 * 60 * 1000,
  sessionTtlSeconds: Number(env.SESSION_TTL_DAYS) * 24 * 60 * 60,
  bcryptRounds: Number(env.BCRYPT_ROUNDS),
  maxLoginAttempts: Number(env.MAX_LOGIN_ATTEMPTS),
  accountLockMs: Number(env.ACCOUNT_LOCK_MINUTES) * 60 * 1000,

  otpTtlMs: Number(env.OTP_TTL_MINUTES) * 60 * 1000,
  otpTtlMinutes: Number(env.OTP_TTL_MINUTES),
  otpMaxPerHour: Number(env.OTP_MAX_PER_HOUR),
  otpDevCode: env.OTP_DEV_CODE,

  /* Defaults on outside production. Turning it on in production would make
     every account openable with a fixed six-digit code, so it is refused
     below rather than merely discouraged. */
  otpDevMode: flag(env.OTP_DEV_MODE, !isProduction),

  mailConfigured: Boolean(env.SMTP_HOST),

  /** Origins allowed to call this API from a browser. */
  corsOrigins: [
    env.FRONTEND_URL,
    ...env.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
  ].filter(Boolean),
} as const;

if (isProduction && config.otpDevMode) {
  console.error(
    '❌ OTP_DEV_MODE is on in production. Every account would be openable with ' +
      `the fixed code ${config.otpDevCode}. Unset OTP_DEV_MODE and configure SMTP.`,
  );
  process.exit(1);
}

if (isProduction && !config.mailConfigured) {
  console.warn(
    '⚠️  No SMTP_HOST configured. Verification codes cannot be delivered, so ' +
      'nobody will be able to finish signing up.',
  );
}
