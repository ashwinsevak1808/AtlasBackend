/**
 * Row shapes as they come back from Postgres, and the shape we hand to the
 * browser.
 *
 * They are deliberately different types. `UserRow` carries a password hash and
 * a lockout counter; `PublicUser` is what a client is allowed to see. Keeping
 * one type for both is how a hash ends up in a JSON response.
 */

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  avatar_color: string;
  email_verified: boolean;
  email_verified_at: Date | null;
  status: 'active' | 'suspended' | 'deleted';
  onboarded_at: Date | null;
  last_login_at: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProfileRow {
  user_id: string;
  persona: string | null;
  role_title: string | null;
  company_name: string | null;
  company_size: string | null;
  heard_from: string | null;
  heard_from_detail: string | null;
  primary_goal: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export interface OtpRow {
  id: string;
  email: string;
  purpose: OtpPurpose;
  code_hash: string;
  attempts: number;
  consumed_at: Date | null;
  created_at: Date;
  expires_at: Date;
}

export type OtpPurpose = 'verify_email' | 'reset_password';

export type AuthEventKind =
  | 'register'
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'otp_issued'
  | 'otp_verified'
  | 'otp_failed'
  | 'password_reset'
  | 'onboarding_completed'
  | 'account_locked';

/** What the browser is allowed to know about the signed-in person. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  fullName: string | null;
  avatarColor: string;
  initials: string;
  emailVerified: boolean;
  /** False until the onboarding questions are answered. Drives the redirect. */
  onboarded: boolean;
  createdAt: string;
  profile: PublicProfile | null;
  productUpdates: boolean;
}

export interface PublicProfile {
  persona: string | null;
  roleTitle: string | null;
  companyName: string | null;
  companySize: string | null;
  heardFrom: string | null;
  primaryGoal: string | null;
}

/** What request context an authenticated route gets. */
export interface AuthContext {
  user: PublicUser;
  sessionId: string;
}

/** Everything a caller needs after a successful sign-in. */
export interface SessionResult {
  user: PublicUser;
  token: string;
  /** ISO-8601. The proxy turns this into a cookie Max-Age. */
  expiresAt: string;
}

/** Where the request came from. Recorded on sessions, OTPs and audit rows. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}
