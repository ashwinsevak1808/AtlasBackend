/**
 * An error with an HTTP status on it.
 *
 * The global error handler already reads `statusCode`; this gives callers a
 * way to set one deliberately instead of every failure becoming a 500. Throw
 * it from a service, let the async handler catch it, and the response shape is
 * the same as everywhere else.
 *
 * `code` is a stable machine-readable string the frontend can branch on —
 * message text is for people and will be reworded.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;
  /** Marks a failure we anticipated, so the handler need not log a stack for it. */
  readonly expected = true;

  constructor(statusCode: number, message: string, code = 'error', details: unknown = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new AppError(400, message, code, details ?? null);

export const unauthorized = (message = 'Sign in to continue.', code = 'unauthorized') =>
  new AppError(401, message, code);

export const forbidden = (message = 'You do not have access to that.', code = 'forbidden') =>
  new AppError(403, message, code);

export const notFound = (message = 'Not found.', code = 'not_found') =>
  new AppError(404, message, code);

export const conflict = (message: string, code = 'conflict') =>
  new AppError(409, message, code);

export const tooManyRequests = (message: string, code = 'rate_limited') =>
  new AppError(429, message, code);
