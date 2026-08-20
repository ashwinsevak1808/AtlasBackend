import { Router } from 'express';
import { authLimiter, otpLimiter } from '../../middleware/rate-limit.js';
import { requireAuth, requireInternalKey } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/async-handler.js';
import * as controller from './auth.controller.js';
import {
  forgotPasswordSchema,
  loginSchema,
  onboardingSchema,
  registerSchema,
  resendCodeSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.schema.js';

/**
 * Mounted at /api/auth.
 *
 *   POST /register          email + password + confirmation → sends a code
 *   POST /verify-email      code → signs in, says where to go next
 *   POST /resend-code       another code for the same address
 *   POST /login             signs in, or asks for verification first
 *   POST /logout            revokes this session
 *   GET  /me                the signed-in user, or 401
 *   POST /onboarding        the questions, answered once
 *   POST /forgot-password   sends a reset code, admits nothing
 *   POST /reset-password    code + new password → signs in
 *
 * The whole router sits behind the internal-key check, so when
 * INTERNAL_API_KEY is set nothing here is reachable except through the
 * frontend's proxy.
 */

const router = Router();

router.use(requireInternalKey);

router.post('/register', authLimiter, validate(registerSchema), asyncHandler(controller.register));
router.post('/login', authLimiter, validate(loginSchema), asyncHandler(controller.login));

router.post('/verify-email', authLimiter, validate(verifyEmailSchema), asyncHandler(controller.verifyEmail));
router.post('/resend-code', otpLimiter, validate(resendCodeSchema), asyncHandler(controller.resendCode));

router.post('/forgot-password', otpLimiter, validate(forgotPasswordSchema), asyncHandler(controller.forgotPassword));
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), asyncHandler(controller.resetPassword));

router.get('/me', requireAuth, asyncHandler(controller.me));
router.post('/logout', requireAuth, asyncHandler(controller.logout));
router.post('/onboarding', requireAuth, validate(onboardingSchema), asyncHandler(controller.onboarding));

export default router;
