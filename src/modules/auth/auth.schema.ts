import { z } from 'zod';

/**
 * The shape of every auth request body.
 *
 * Validation lives here rather than in the controller so that the contract is
 * readable in one file, and so the frontend can be checked against it by
 * reading rather than by trial and error.
 */

const email = z
  .string({ required_error: 'Enter your email address.' })
  .trim()
  .toLowerCase()
  .min(3, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .email('That does not look like an email address.');

const password = z
  .string({ required_error: 'Enter a password.' })
  .min(1, 'Enter a password.')
  .max(200, 'That password is too long.');

const otpCode = z
  .string({ required_error: 'Enter the six-digit code.' })
  .trim()
  .regex(/^\d{6}$/, 'Enter the six-digit code from your email.');

/* Registration asks for three things and no more. Everything else is asked
   after the address is verified, where an abandoned form costs us nothing. */
export const registerSchema = z
  .object({
    email,
    password,
    confirmPassword: z.string({ required_error: 'Confirm your password.' }),
  })
  .refine((body) => body.password === body.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Those passwords do not match.',
  });

export const loginSchema = z.object({
  email,
  password,
});

export const verifyEmailSchema = z.object({
  email,
  code: otpCode,
});

export const resendCodeSchema = z.object({
  email,
  purpose: z.enum(['verify_email', 'reset_password']).default('verify_email'),
});

export const forgotPasswordSchema = z.object({
  email,
});

export const resetPasswordSchema = z
  .object({
    email,
    code: otpCode,
    password,
    confirmPassword: z.string({ required_error: 'Confirm your password.' }),
  })
  .refine((body) => body.password === body.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Those passwords do not match.',
  });

/* The onboarding questions. Only the name and who they are are required — a
   form that refuses to submit until every optional question is answered is how
   you lose the answers to the ones that mattered. */
export const onboardingSchema = z.object({
  fullName: z
    .string({ required_error: 'Tell us what to call you.' })
    .trim()
    .min(2, 'That name is too short.')
    .max(80, 'That name is too long.'),

  persona: z.enum(['student', 'developer', 'freelancer', 'startup', 'company', 'qa', 'other'], {
    required_error: 'Pick the one that fits best.',
  }),

  roleTitle: z.string().trim().max(80).optional(),
  companyName: z.string().trim().max(120).optional(),
  companySize: z.enum(['1', '2-10', '11-50', '51-200', '201-1000', '1000+']).optional(),

  heardFrom: z
    .enum(['search', 'github', 'twitter', 'linkedin', 'youtube', 'reddit', 'friend', 'newsletter', 'event', 'other'])
    .optional(),
  heardFromDetail: z.string().trim().max(160).optional(),

  primaryGoal: z
    .enum(['test-apis', 'document-apis', 'understand-codebase', 'replace-postman', 'evaluating', 'other'])
    .optional(),

  /* Opt-in, so the default is false. A pre-ticked box is not consent. */
  productUpdates: z.boolean().default(false),
});

export type RegisterBody = z.infer<typeof registerSchema>;
export type LoginBody = z.infer<typeof loginSchema>;
export type VerifyEmailBody = z.infer<typeof verifyEmailSchema>;
export type ResendCodeBody = z.infer<typeof resendCodeSchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;
export type OnboardingBody = z.infer<typeof onboardingSchema>;
