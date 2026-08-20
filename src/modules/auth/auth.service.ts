import { createHash } from 'node:crypto';
import { config } from '../../config/env.js';
import { withTransaction } from '../../database/pool.js';
import { sendOtpEmail, sendWelcomeEmail, type MailResult } from '../../services/mailer.js';
import {
  badRequest,
  conflict,
  forbidden,
  tooManyRequests,
  unauthorized,
} from '../../utils/app-error.js';
import { fakeVerifyDelay, hashPassword, passwordProblem, verifyPassword } from '../../utils/password.js';
import { normaliseEmail, randomOtp, randomToken, safeEqual, sha256 } from '../../utils/tokens.js';
import * as repo from './auth.repository.js';
import type {
  LoginBody,
  OnboardingBody,
  RegisterBody,
  ResetPasswordBody,
  VerifyEmailBody,
} from './auth.schema.js';
import type {
  OtpPurpose,
  ProfileRow,
  PublicUser,
  RequestMeta,
  SessionResult,
  UserRow,
} from './auth.types.js';

/**
 * The auth flows, in the order a person meets them.
 *
 * Register with an email and a password, prove the address with a six-digit
 * code, answer the onboarding questions, and you are in. Nothing here reads a
 * request or writes a response — the controller does that — and nothing here
 * writes SQL, which the repository does.
 */

/* Bump when the terms or privacy text changes materially. Recorded against
   every consent row, so "what did they actually agree to" has an answer. */
const POLICY_VERSION = '2026-08-17';

const MAX_OTP_ATTEMPTS = 5;
const OTP_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

const AVATAR_COLORS = ['#157347', '#155EBD', '#6D3DC7', '#B02F76', '#0A7A74', '#9E6A08'];

/* Stable for a given address, so the same person keeps the same colour across
   devices without our storing a choice they never made. */
function avatarColorFor(email: string): string {
  const digest = createHash('sha256').update(email).digest();
  const index = (digest[0] ?? 0) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index] ?? '#155EBD';
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '';
  return (first + last).toUpperCase() || '?';
}

/** The display name, falling back to the local part before onboarding runs. */
const displayName = (user: UserRow): string =>
  user.full_name?.trim() || user.email.split('@')[0] || user.email;

export function toPublicUser(
  user: UserRow,
  profile: ProfileRow | null,
  productUpdates: boolean,
): PublicUser {
  const name = displayName(user);
  return {
    id: user.id,
    email: user.email,
    name,
    fullName: user.full_name,
    avatarColor: user.avatar_color,
    initials: initialsFor(name),
    emailVerified: user.email_verified,
    onboarded: user.onboarded_at !== null,
    createdAt: user.created_at.toISOString(),
    profile: profile
      ? {
          persona: profile.persona,
          roleTitle: profile.role_title,
          companyName: profile.company_name,
          companySize: profile.company_size,
          heardFrom: profile.heard_from,
          primaryGoal: profile.primary_goal,
        }
      : null,
    productUpdates,
  };
}

/** Loads the profile and consent that go alongside a user row. */
async function publicUserFor(user: UserRow): Promise<PublicUser> {
  const [profile, productUpdates] = await Promise.all([
    repo.findProfile(user.id),
    repo.findCurrentConsent(user.id, 'product_updates'),
  ]);
  return toPublicUser(user, profile, productUpdates);
}

/* ── One-time codes ─────────────────────────────────────────────────────── */

/**
 * Issues a code and tries to email it.
 *
 * In development the issued code *is* `OTP_DEV_CODE`, rather than the real
 * code being bypassed at the point of comparison. That distinction matters: a
 * bypass is a second path through verification that has to stay disabled in
 * production, and one day will not be. This way there is one path, and the
 * only thing development changes is how the number is chosen.
 */
async function issueCode(
  email: string,
  purpose: OtpPurpose,
  meta: RequestMeta,
): Promise<MailResult> {
  const issued = await repo.countRecentOtps(email, OTP_THROTTLE_WINDOW_MS);
  if (issued >= config.otpMaxPerHour) {
    throw tooManyRequests(
      'Too many codes requested for that address. Try again in an hour.',
      'otp_throttled',
    );
  }

  const code = config.otpDevMode ? config.otpDevCode : randomOtp();

  await repo.insertOtp({
    email,
    purpose,
    codeHash: sha256(code),
    expiresAt: new Date(Date.now() + config.otpTtlMs),
    meta,
  });

  repo.logAuthEvent({ kind: 'otp_issued', email, detail: { purpose }, meta });

  return sendOtpEmail(email, code, purpose);
}

/** Checks a code and spends it. Throws with a message meant to be shown. */
async function consumeCode(
  email: string,
  code: string,
  purpose: OtpPurpose,
  meta: RequestMeta,
): Promise<void> {
  const record = await repo.findLiveOtp(email, purpose);

  if (!record) {
    throw badRequest('No code was requested for that address. Ask for a new one.', 'otp_missing');
  }
  if (record.expires_at.getTime() < Date.now()) {
    await repo.consumeOtp(record.id);
    throw badRequest('That code has expired. Ask for a new one.', 'otp_expired');
  }
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    throw tooManyRequests('Too many attempts. Ask for a new code.', 'otp_attempts');
  }

  if (!safeEqual(sha256(code.trim()), record.code_hash)) {
    const updated = await repo.incrementOtpAttempts(record.id);
    const left = MAX_OTP_ATTEMPTS - (updated?.attempts ?? MAX_OTP_ATTEMPTS);
    repo.logAuthEvent({ kind: 'otp_failed', email, detail: { purpose }, meta });

    throw badRequest(
      left > 0
        ? `That code is not right. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'Too many attempts. Ask for a new code.',
      left > 0 ? 'otp_invalid' : 'otp_attempts',
    );
  }

  await repo.consumeOtp(record.id);
  repo.logAuthEvent({ kind: 'otp_verified', email, detail: { purpose }, meta });
}

/* ── Sessions ───────────────────────────────────────────────────────────── */

async function startSession(user: UserRow, meta: RequestMeta): Promise<SessionResult> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlMs);

  await repo.insertSession({ userId: user.id, tokenHash: sha256(token), expiresAt, meta });
  repo.pruneExpiredSessions();

  return {
    user: await publicUserFor(user),
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/** Resolves the cookie value the proxy forwarded. Null for anything invalid. */
export async function resolveSession(
  token: string,
): Promise<{ user: PublicUser; sessionId: string } | null> {
  const row = await repo.findSessionUser(sha256(token));
  if (!row || row.status !== 'active') return null;

  repo.touchSession(row.session_id);
  return { user: await publicUserFor(row), sessionId: row.session_id };
}

/* ── Register ───────────────────────────────────────────────────────────── */

export interface RegisterResult {
  email: string;
  delivery: MailResult;
}

/**
 * Creates the account and sends a verification code.
 *
 * No session is created here. An unverified account can do nothing, so signing
 * someone in before they have proved the address would only mean deciding, at
 * every later endpoint, whether this particular one tolerates an unverified
 * user. Verification is the step that produces a session.
 */
export async function register(body: RegisterBody, meta: RequestMeta): Promise<RegisterResult> {
  const email = normaliseEmail(body.email);

  const problem = passwordProblem(body.password);
  if (problem) throw badRequest(problem, 'weak_password');

  const existing = await repo.findUserByEmail(email);

  if (existing?.email_verified) {
    /* Registration cannot hide that an address is taken — the account either
       gets created or it does not. Password reset is where enumeration is
       actually prevented; here we say so plainly and point at sign-in. */
    throw conflict('An account already exists for that email. Try signing in.', 'email_taken');
  }

  if (existing) {
    /* The address was claimed but never verified, so nothing is behind it.
       Letting the new password take over is what stops an abandoned sign-up
       locking the real owner of the address out permanently. */
    await repo.updatePasswordHash(existing.id, await hashPassword(body.password));
    const delivery = await issueCode(email, 'verify_email', meta);
    return { email, delivery };
  }

  const user = await withTransaction(async (client) => {
    const created = await repo.insertUser(
      {
        email,
        passwordHash: await hashPassword(body.password),
        avatarColor: avatarColorFor(email),
      },
      client,
    );
    if (!created) throw new Error('User insert returned no row');

    /* Creating an account is the point at which the terms were accepted, and
       the sign-up screen says so. Record it now, not at onboarding, which can
       be abandoned. */
    for (const kind of ['terms', 'privacy'] as const) {
      await repo.insertConsent(
        { userId: created.id, kind, granted: true, version: POLICY_VERSION, source: 'register', meta },
        client,
      );
    }

    return created;
  });

  repo.logAuthEvent({ kind: 'register', userId: user.id, email, meta });

  const delivery = await issueCode(email, 'verify_email', meta);
  return { email, delivery };
}

/* ── Verify ─────────────────────────────────────────────────────────────── */

export async function verifyEmail(
  body: VerifyEmailBody,
  meta: RequestMeta,
): Promise<SessionResult> {
  const email = normaliseEmail(body.email);
  await consumeCode(email, body.code, 'verify_email', meta);

  const user = await repo.findUserByEmail(email);
  if (!user) throw badRequest('No account exists for that address.', 'no_account');
  if (user.status !== 'active') throw forbidden('That account is not active.', 'account_inactive');

  await repo.markEmailVerified(user.id);
  await repo.recordLoginSuccess(user.id);

  /* Re-read so the session carries the verified flag rather than the stale row. */
  const verified = (await repo.findUserById(user.id)) ?? user;
  repo.logAuthEvent({ kind: 'login_success', userId: user.id, email, detail: { via: 'verify' }, meta });

  return startSession(verified, meta);
}

export async function resendCode(
  email: string,
  purpose: OtpPurpose,
  meta: RequestMeta,
): Promise<MailResult> {
  const normalised = normaliseEmail(email);
  const user = await repo.findUserByEmail(normalised);

  /* A reset code must not reveal whether the address is registered. A
     verification code may: you only reach that screen having just created the
     account. */
  if (!user) {
    if (purpose === 'reset_password') {
      return { delivered: true, note: 'If that address has an account, a code is on its way.' };
    }
    throw badRequest('No account exists for that address.', 'no_account');
  }

  if (purpose === 'verify_email' && user.email_verified) {
    throw badRequest('That address is already verified. Sign in instead.', 'already_verified');
  }

  return issueCode(normalised, purpose, meta);
}

/* ── Login ──────────────────────────────────────────────────────────────── */

export type LoginResult =
  | ({ kind: 'session' } & SessionResult)
  | { kind: 'verification-required'; email: string; delivery: MailResult };

export async function login(body: LoginBody, meta: RequestMeta): Promise<LoginResult> {
  const email = normaliseEmail(body.email);
  const user = await repo.findUserByEmail(email);

  /* One message for "no such account" and "wrong password", and comparable
     timing for both, so a caller cannot learn which addresses are registered. */
  const invalid = unauthorized('Those credentials do not match an account.', 'invalid_credentials');

  if (!user) {
    await fakeVerifyDelay();
    repo.logAuthEvent({ kind: 'login_failed', email, detail: { reason: 'no_account' }, meta });
    throw invalid;
  }

  if (user.status !== 'active') {
    repo.logAuthEvent({ kind: 'login_failed', userId: user.id, email, detail: { reason: user.status }, meta });
    throw forbidden('That account has been suspended. Get in touch if this is unexpected.', 'account_inactive');
  }

  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    const minutes = Math.max(1, Math.ceil((user.locked_until.getTime() - Date.now()) / 60_000));
    throw tooManyRequests(
      `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      'account_locked',
    );
  }

  if (!(await verifyPassword(body.password, user.password_hash))) {
    const state = await repo.recordLoginFailure(
      user.id,
      config.maxLoginAttempts,
      config.accountLockMs,
    );
    repo.logAuthEvent({
      kind: state?.locked_until ? 'account_locked' : 'login_failed',
      userId: user.id,
      email,
      detail: { reason: 'bad_password', attempts: state?.failed_login_attempts ?? null },
      meta,
    });
    throw invalid;
  }

  /* The password was right but the address was never proved. Send a fresh code
     and let the client move them to the verification screen — a bare error
     would leave them with a correct password and no way forward. */
  if (!user.email_verified) {
    const delivery = await issueCode(email, 'verify_email', meta);
    return { kind: 'verification-required', email, delivery };
  }

  await repo.recordLoginSuccess(user.id);
  repo.logAuthEvent({ kind: 'login_success', userId: user.id, email, meta });

  const session = await startSession(user, meta);
  return { kind: 'session', ...session };
}

export async function logout(sessionId: string, userId: string, meta: RequestMeta): Promise<void> {
  await repo.revokeSession(sessionId);
  repo.logAuthEvent({ kind: 'logout', userId, meta });
}

/* ── Onboarding ─────────────────────────────────────────────────────────── */

/**
 * Stores the answers and marks the account onboarded.
 *
 * One transaction, because a name without a profile, or a profile without the
 * consent row, is a half-answered questionnaire that nothing will ever ask
 * again — `onboarded_at` is what stops us asking twice.
 */
export async function completeOnboarding(
  userId: string,
  body: OnboardingBody,
  meta: RequestMeta,
): Promise<PublicUser> {
  await withTransaction(async (client) => {
    await repo.markOnboarded(userId, body.fullName, client);

    await repo.upsertProfile(
      userId,
      {
        persona: body.persona,
        roleTitle: body.roleTitle ?? null,
        companyName: body.companyName ?? null,
        companySize: body.companySize ?? null,
        heardFrom: body.heardFrom ?? null,
        heardFromDetail: body.heardFromDetail ?? null,
        primaryGoal: body.primaryGoal ?? null,
      },
      client,
    );

    await repo.insertConsent(
      {
        userId,
        kind: 'product_updates',
        granted: body.productUpdates,
        version: POLICY_VERSION,
        source: 'onboarding',
        meta,
      },
      client,
    );
  });

  repo.logAuthEvent({
    kind: 'onboarding_completed',
    userId,
    detail: { persona: body.persona, heardFrom: body.heardFrom ?? null },
    meta,
  });

  const user = await repo.findUserById(userId);
  if (!user) throw unauthorized();

  /* Nothing depends on this arriving, so it is not awaited. */
  void sendWelcomeEmail(user.email, body.fullName);

  return publicUserFor(user);
}

/* ── Password reset ─────────────────────────────────────────────────────── */

export async function forgotPassword(email: string, meta: RequestMeta): Promise<MailResult> {
  const normalised = normaliseEmail(email);
  const user = await repo.findUserByEmail(normalised);

  /* Always the same answer, whether or not the address is registered. */
  const generic: MailResult = {
    delivered: true,
    note: 'If that address has an account, a code is on its way.',
  };

  if (!user || user.status !== 'active') return generic;

  const sent = await issueCode(normalised, 'reset_password', meta);
  /* When mail is not configured the code comes back in the response, which is
     the only way to test the flow locally — and is why OTP_DEV_MODE refuses to
     run in production. */
  return sent.delivered ? generic : sent;
}

export async function resetPassword(
  body: ResetPasswordBody,
  meta: RequestMeta,
): Promise<SessionResult> {
  const email = normaliseEmail(body.email);

  const problem = passwordProblem(body.password);
  if (problem) throw badRequest(problem, 'weak_password');

  await consumeCode(email, body.code, 'reset_password', meta);

  const user = await repo.findUserByEmail(email);
  if (!user) throw badRequest('No account exists for that address.', 'no_account');
  if (user.status !== 'active') throw forbidden('That account is not active.', 'account_inactive');

  await repo.updatePasswordHash(user.id, await hashPassword(body.password));

  /* Whoever had a session on this account no longer should. If the reset was
     the real owner recovering it, this is what removes the intruder. */
  await repo.revokeAllUserSessions(user.id, null);

  /* Proving control of the mailbox verifies the address as surely as the
     verification code does. */
  if (!user.email_verified) await repo.markEmailVerified(user.id);

  repo.logAuthEvent({ kind: 'password_reset', userId: user.id, email, meta });

  const fresh = (await repo.findUserById(user.id)) ?? user;
  return startSession(fresh, meta);
}

export const getCurrentUser = async (userId: string): Promise<PublicUser | null> => {
  const user = await repo.findUserById(userId);
  return user ? publicUserFor(user) : null;
};
