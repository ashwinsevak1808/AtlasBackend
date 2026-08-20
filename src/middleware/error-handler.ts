import type { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';
import { errorResponse } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { translateDbError } from '../utils/db-error.js';
import { isProduction } from '../config/env.js';

export const errorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  /* A database failure usually has one obvious fix — run a migration, use the
     pooler host — and burying it under a generic 500 means reading server logs
     to discover a table is missing. Translate the unambiguous ones. */
  const translated = err instanceof AppError ? null : translateDbError(err);

  const isExpected = err instanceof AppError || translated !== null;
  const statusCode = translated?.statusCode ?? err.statusCode ?? 500;

  /* A wrong password is not an incident. Logging a stack trace for every one
     of them buries the failures that do matter. */
  if (translated) {
    /* Still logged in full: the operator needs the original, the caller needs
       the instruction. */
    logger.error(`${statusCode} ${req.method} ${req.originalUrl} — ${translated.message} (${err.code}: ${err.message})`);
  } else if (isExpected) {
    logger.warn(`${statusCode} ${req.method} ${req.originalUrl} — ${err.message}`);
  } else {
    logger.error(`${err.name || 'Error'}: ${err.message}\n${err.stack}`);
  }

  const message = translated
    ? translated.message
    : isExpected || statusCode < 500
      ? err.message
      : 'Something went wrong on our end.';

  /* The previous version returned the error object itself, which put stack
     traces and driver internals into the response body. Anything unexpected
     now says so and nothing more; the detail is in the log. */
  const hasList = err instanceof AppError && Array.isArray(err.details) && err.details.length > 0;

  /* A list of specific problems is flattened into `errors`, one entry each,
     rather than nested one level down inside a single entry. Nesting meant a
     caller reading `errors[0]` got a summary and never found the detail — which
     is how "4 steps cannot run" reached a user with no way to see which four. */
  const details = hasList
    ? (err.details as Record<string, unknown>[]).map((entry) => ({ code: err.code, ...entry }))
    : translated
      ? { code: translated.code }
      : isExpected
      ? { code: err.code, ...(err.details ? { details: err.details } : {}) }
      : isProduction
        ? null
        : { name: err.name, stack: err.stack };

  return errorResponse(res, message, details, statusCode);
};
