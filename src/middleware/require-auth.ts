import type { NextFunction, Request, Response } from 'express';
import { config, env } from '../config/env.js';
import { resolveSession } from '../modules/auth/auth.service.js';
import { asyncHandler } from '../utils/async-handler.js';
import { forbidden, unauthorized } from '../utils/app-error.js';
import { safeEqual } from '../utils/tokens.js';

/**
 * Session handling for routes behind a sign-in.
 *
 * The browser never holds this token — the Next.js proxy keeps it in an
 * httpOnly cookie and forwards it as a bearer header. From this API's point of
 * view every caller is a bearer client, which is why there is no cookie
 * handling here at all.
 */

const bearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
};

/** Rejects the request unless there is a live session. */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const token = bearer(req);
  if (!token) throw unauthorized();

  const session = await resolveSession(token);
  if (!session) throw unauthorized('Your session has expired. Sign in again.', 'session_expired');

  req.user = session.user;
  req.sessionId = session.sessionId;
  next();
});

/**
 * Attaches the user when there is one, and carries on when there is not.
 *
 * For endpoints a guest may also use — most of Atlas, by design.
 */
export const optionalAuth = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (token) {
      const session = await resolveSession(token);
      if (session) {
        req.user = session.user;
        req.sessionId = session.sessionId;
      }
    }
    next();
  },
);

/** Blocks a signed-in but unverified account. Verification issues the session,
 *  so this should never fire — it is here so that stops being true loudly. */
export const requireVerified = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  if (!req.user.emailVerified) {
    return next(forbidden('Verify your email address first.', 'email_not_verified'));
  }
  next();
};

/**
 * Shared secret between the Next.js proxy and this API.
 *
 * CORS governs browsers and nothing else, and this API answers on the public
 * internet. When INTERNAL_API_KEY is set, a caller must also present it —
 * which is the difference between "the auth endpoints are rate-limited" and
 * "the auth endpoints are not reachable except through our frontend".
 *
 * Optional, so local development needs no extra configuration.
 */
export const requireInternalKey = (req: Request, _res: Response, next: NextFunction) => {
  if (!env.INTERNAL_API_KEY) return next();

  const presented = req.headers['x-atlas-key'];
  const value = Array.isArray(presented) ? presented[0] ?? '' : presented ?? '';

  if (!safeEqual(value, env.INTERNAL_API_KEY)) {
    return next(forbidden('This endpoint is not reachable directly.', 'internal_key_required'));
  }
  next();
};

/** Where the request came from, for sessions, codes and the audit trail. */
export const requestMeta = (req: Request) => ({
  ip: (req.headers['x-forwarded-for'] as string | undefined) ?? req.ip ?? null,
  userAgent: req.headers['user-agent'] ?? null,
});

export const sessionMaxAgeSeconds = config.sessionTtlSeconds;
