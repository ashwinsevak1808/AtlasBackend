import type { Request, Response } from 'express';
import { requestMeta } from '../../middleware/require-auth.js';
import { successResponse } from '../../utils/api-response.js';
import { unauthorized } from '../../utils/app-error.js';
import * as service from './auth.service.js';
import type {
  ForgotPasswordBody,
  LoginBody,
  OnboardingBody,
  RegisterBody,
  ResendCodeBody,
  ResetPasswordBody,
  VerifyEmailBody,
} from './auth.schema.js';

/**
 * Request in, response out. No decisions live here.
 *
 * Bodies arrive already parsed by the `validate` middleware, so the casts
 * below are describing what that middleware guaranteed rather than hoping.
 */

const meFrom = (req: Request) => {
  if (!req.user || !req.sessionId) throw unauthorized();
  return { user: req.user, sessionId: req.sessionId };
};

export const register = async (req: Request, res: Response) => {
  const result = await service.register(req.body as RegisterBody, requestMeta(req));
  return successResponse(
    res,
    'Account created. Check your email for the code.',
    { email: result.email, delivery: result.delivery, next: 'verify-email' },
    201,
  );
};

export const verifyEmail = async (req: Request, res: Response) => {
  const session = await service.verifyEmail(req.body as VerifyEmailBody, requestMeta(req));
  return successResponse(res, 'Email verified.', {
    ...session,
    /* Where the client should go. The server knows whether onboarding has
       been answered; making the client work it out from `user.onboarded`
       duplicates the rule in two places. */
    next: session.user.onboarded ? 'app' : 'onboarding',
  });
};

export const resendCode = async (req: Request, res: Response) => {
  const body = req.body as ResendCodeBody;
  const delivery = await service.resendCode(body.email, body.purpose, requestMeta(req));
  return successResponse(res, delivery.note, { delivery });
};

export const login = async (req: Request, res: Response) => {
  const result = await service.login(req.body as LoginBody, requestMeta(req));

  if (result.kind === 'verification-required') {
    return successResponse(res, 'Verify your email address to continue.', {
      email: result.email,
      delivery: result.delivery,
      next: 'verify-email',
    });
  }

  const { kind: _kind, ...session } = result;
  return successResponse(res, 'Signed in.', {
    ...session,
    next: session.user.onboarded ? 'app' : 'onboarding',
  });
};

export const logout = async (req: Request, res: Response) => {
  const { user, sessionId } = meFrom(req);
  await service.logout(sessionId, user.id, requestMeta(req));
  return successResponse(res, 'Signed out.', null);
};

export const me = async (req: Request, res: Response) => {
  const { user } = meFrom(req);
  /* Re-read rather than returning the copy the middleware resolved, so a
     client that just completed onboarding in another tab sees it. */
  const fresh = await service.getCurrentUser(user.id);
  if (!fresh) throw unauthorized();
  return successResponse(res, 'Signed in.', { user: fresh });
};

export const onboarding = async (req: Request, res: Response) => {
  const { user } = meFrom(req);
  const updated = await service.completeOnboarding(
    user.id,
    req.body as OnboardingBody,
    requestMeta(req),
  );
  return successResponse(res, 'Thanks — that is everything.', { user: updated, next: 'app' });
};

export const forgotPassword = async (req: Request, res: Response) => {
  const body = req.body as ForgotPasswordBody;
  const delivery = await service.forgotPassword(body.email, requestMeta(req));
  return successResponse(res, delivery.note, { delivery });
};

export const resetPassword = async (req: Request, res: Response) => {
  const session = await service.resetPassword(req.body as ResetPasswordBody, requestMeta(req));
  return successResponse(res, 'Password changed. Every other device has been signed out.', {
    ...session,
    next: session.user.onboarded ? 'app' : 'onboarding',
  });
};
