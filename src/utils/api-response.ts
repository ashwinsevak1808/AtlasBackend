import type { Response } from 'express';
import type { ApiResponse } from '../types/index.js';

/**
 * Standard API Response Helper
 */
export const apiResponse = (
  res: Response,
  statusCode: number,
  message: string,
  data: any = null,
  success: boolean = true,
  errors: any = null
): Response => {
  const response: ApiResponse = {
    success,
    message,
    data,
    errors: Array.isArray(errors) ? errors : (errors ? [errors] : []),
  };
  return res.status(statusCode).json(response);
};

export const successResponse = (res: Response, message: string, data: any = null, statusCode: number = 200): Response => {
  return apiResponse(res, statusCode, message, data, true);
};

export const errorResponse = (res: Response, message: string, error: any = null, statusCode: number = 500): Response => {
  return apiResponse(res, statusCode, message, null, false, error);
};
