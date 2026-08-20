import { type Request, type Response, type NextFunction } from 'express';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;

/**
 * Wraps async functions to catch errors and pass them to the global error handler
 */
export const asyncHandler = (fn: AsyncRequestHandler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
