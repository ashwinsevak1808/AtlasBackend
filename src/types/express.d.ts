import type { PublicUser } from '../modules/auth/auth.types.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth` / `optionalAuth`. Absent for a guest. */
      user?: PublicUser;
      /** The session row backing `user`, so logout can revoke exactly this one. */
      sessionId?: string;
    }
  }
}

export {};
