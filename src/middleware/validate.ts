import { type Request, type Response, type NextFunction } from 'express';
import { type ZodTypeAny } from 'zod';
import { errorResponse } from '../utils/api-response.js';

/**
 * Request validation middleware using Zod
 * @param {ZodTypeAny} schema - Zod schema to validate against
 */
export const validate = (schema: ZodTypeAny) => (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = schema.parse(req.body);
    req.body = parsed;
    next();
  } catch (err: any) {
    if (err.errors) {
      const formattedErrors = err.errors.map((e: any) => ({
        field: e.path.join('.'),
        message: e.message
      }));
      /* The top-level message is what a form renders when it has nowhere to
         put a field-level one. "Validation failed" tells the user nothing;
         the first specific message tells them what to fix. */
      const summary = formattedErrors[0]?.message ?? 'Validation failed';
      return errorResponse(res, summary, formattedErrors, 400);
    }
    return errorResponse(res, err.message || 'Validation failed', err, 400);
  }
};
