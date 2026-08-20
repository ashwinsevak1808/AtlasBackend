import nodemailer, { type Transporter } from 'nodemailer';
import { config, env } from '../config/env.js';
import logger from '../utils/logger.js';

/**
 * Outbound email.
 *
 * TODO: no provider is configured. Until SMTP_HOST is set in the environment,
 * every send is written to the server log instead and `delivered` comes back
 * false — which is what lets the sign-up flow be completed end to end with no
 * mailbox involved.
 *
 * To wire a real one, set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS and
 * MAIL_FROM. Nothing else in this file needs to change; Resend, Postmark, SES
 * and Gmail all speak SMTP. If you later want an HTTP API instead, replace the
 * body of `send` and leave the two template functions alone.
 */

export interface MailResult {
  delivered: boolean;
  /** Present only when nothing was actually sent, so the flow stays testable. */
  code?: string;
  /** Shown to the user. Says plainly what did or did not happen. */
  note: string;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.mailConfigured) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT),
    /* 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this wrong is
       the usual cause of a connection that hangs rather than fails. */
    secure: env.SMTP_SECURE ? /^(1|true|yes|on)$/i.test(env.SMTP_SECURE) : Number(env.SMTP_PORT) === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });

  return transporter;
}

async function send(to: string, subject: string, text: string, html: string): Promise<boolean> {
  const transport = getTransporter();
  if (!transport) return false;

  try {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
    return true;
  } catch (err: any) {
    /* A mail provider being down must not fail the request that triggered it.
       The user is told the code was not delivered and can ask for another. */
    logger.error(`Mail send failed to ${to}: ${err.message}`);
    return false;
  }
}

/* ── Templates ──────────────────────────────────────────────────────────── */

const shell = (heading: string, body: string) => `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#0f172a">
  <p style="font-size:20px;font-weight:700;letter-spacing:-0.03em;margin:0 0 28px">
    atlas<span style="color:#10b981;font-weight:400">.api</span>
  </p>
  <h1 style="font-size:18px;font-weight:600;margin:0 0 12px">${heading}</h1>
  ${body}
  <p style="font-size:13px;line-height:1.6;color:#64748b;margin:28px 0 0;padding-top:16px;border-top:1px solid #e2e8f0">
    If you did not ask for this, you can ignore this email — nothing has changed on your account.
  </p>
</div>`;

const codeBlock = (code: string) => `
  <p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;font-weight:600;letter-spacing:0.28em;margin:0 0 16px">${code}</p>`;

/* ── Public API ─────────────────────────────────────────────────────────── */

export type OtpPurpose = 'verify_email' | 'reset_password';

/**
 * Sends a one-time code, or hands it back when there is no transport.
 *
 * The returned `code` is the entire reason the flow works without a mail
 * provider. It is only ever populated when `delivered` is false — see
 * `OTP_DEV_MODE` in the environment config, which refuses to be on in
 * production for exactly this reason.
 */
export async function sendOtpEmail(
  to: string,
  code: string,
  purpose: OtpPurpose,
): Promise<MailResult> {
  const isReset = purpose === 'reset_password';
  const subject = isReset
    ? `Reset your ${config.appName} password`
    : `Verify your ${config.appName} email`;
  const heading = isReset ? 'Reset your password' : 'Confirm your email address';

  const text =
    `Your ${config.appName} code is ${code}. ` +
    `It expires in ${config.otpTtlMinutes} minutes.`;

  const html = shell(
    heading,
    `${codeBlock(code)}
     <p style="font-size:14px;line-height:1.6;color:#475569;margin:0">
       Enter this code to continue. It expires in ${config.otpTtlMinutes} minutes and can only be used once.
     </p>`,
  );

  const delivered = await send(to, subject, text, html);
  if (delivered) return { delivered: true, note: `Sent to ${to}.` };

  logger.info(`[mail:not-configured] ${purpose} code for ${to}: ${code}`);

  return {
    delivered: false,
    code,
    note:
      'No mail provider is configured yet, so the code is shown here and in the ' +
      'server log. Set SMTP_HOST to send it by email.',
  };
}

/**
 * A flow run report.
 *
 * Recipients go in one `to`, not one message each: these are colleagues who
 * asked to watch the same flow, and seeing who else is on it is useful rather
 * than a leak. The body is built by `flow.report.ts`.
 */
export async function sendReportEmail(
  to: string[],
  subject: string,
  html: string,
  text: string,
): Promise<{ delivered: boolean; note: string }> {
  const recipients = [...new Set(to.map((address) => address.trim().toLowerCase()))].filter(Boolean);
  if (recipients.length === 0) return { delivered: false, note: 'No recipients.' };

  const delivered = await send(recipients.join(', '), subject, text, html);

  if (delivered) {
    return { delivered: true, note: `Report sent to ${recipients.length} recipient(s).` };
  }

  logger.info(`[mail:not-configured] report "${subject}" for ${recipients.join(', ')}`);
  return {
    delivered: false,
    note: 'No mail provider is configured, so the report was not emailed. It is saved and can be exported.',
  };
}

/** Sent once, after onboarding. Nothing depends on it arriving. */
export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  const html = shell(
    `Welcome, ${name}`,
    `<p style="font-size:14px;line-height:1.6;color:#475569;margin:0 0 16px">
       Point ${config.appName} at a backend and it will tell you what its API actually is —
       every endpoint, what each one expects, and which tables it touches. Then you can call them.
     </p>
     <p style="font-size:14px;line-height:1.6;color:#475569;margin:0">
       Your source code never leaves your machine.
     </p>`,
  );

  await send(to, `Welcome to ${config.appName}`, `Welcome to ${config.appName}, ${name}.`, html);
}
