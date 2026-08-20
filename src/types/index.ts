/**
 * Base API Response Interface
 */
export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T | null;
  errors?: any[];
}

/* The signed-in user, as every route sees it. Defined by the auth module so
   there is one definition rather than a copy here that drifts from it. */
export type { PublicUser, PublicProfile } from '../modules/auth/auth.types.js';
