import type { Request, Response } from 'express';
import { successResponse } from '../../utils/api-response.js';
import { AppError, badRequest, unauthorized } from '../../utils/app-error.js';
import { env } from '../../config/env.js';
import { safeEqual } from '../../utils/tokens.js';
import * as schedule from './schedule.service.js';
import { encryptionAvailable } from '../../utils/secret-box.js';
import * as service from './flow.service.js';
import type { EnvironmentBody, RecipientsBody, UploadFlowBody } from './flow.schema.js';

/** Request in, response out. Decisions live in the service. */

const requireUser = (req: Request) => {
  if (!req.user) throw unauthorized();
  return req.user;
};

const idParam = (req: Request, name: string): string => {
  const value = req.params[name];
  if (!value) throw badRequest(`Missing ${name}.`, 'missing_id');
  return value;
};

/** Whether this server can hold flows at all, so the UI can say so up front. */
export const capabilities = async (_req: Request, res: Response) =>
  successResponse(res, 'Flow runner status.', {
    serverRuns: encryptionAvailable(),
    reason: encryptionAvailable()
      ? null
      : 'This server has no encryption key configured, so it cannot store flows to run them.',
  });

/* ── Environments ───────────────────────────────────────────────────────── */

export const saveEnvironment = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const environment = await service.saveEnvironment(user.id, req.body as EnvironmentBody);
  return successResponse(res, 'Environment saved.', { environment });
};

export const listEnvironments = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const projectKey = String(req.query.projectKey ?? '');
  if (!projectKey) throw badRequest('Which project?', 'missing_project');
  return successResponse(res, 'Environments.', {
    environments: await service.listEnvironments(user.id, projectKey),
  });
};

export const deleteEnvironment = async (req: Request, res: Response) => {
  const user = requireUser(req);
  await service.deleteEnvironment(user.id, idParam(req, 'id'));
  return successResponse(res, 'Environment deleted.', null);
};

/* ── Flows ──────────────────────────────────────────────────────────────── */

export const uploadFlow = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const flow = await service.uploadFlow(user.id, req.body as UploadFlowBody);
  return successResponse(res, 'Flow saved and ready to run.', { flow }, 201);
};

export const listFlows = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const projectKey = req.query.projectKey ? String(req.query.projectKey) : null;
  return successResponse(res, 'Flows.', { flows: await service.listFlows(user.id, projectKey) });
};

export const deleteFlow = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { hadSchedule } = await service.deleteFlow(user.id, idParam(req, 'id'));
  return successResponse(
    res,
    hadSchedule
      ? 'Flow removed. Its schedule has been cancelled.'
      : 'Flow removed from the server.',
    { hadSchedule },
  );
};

export const setRecipients = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const { recipients } = req.body as RecipientsBody;
  const flow = await service.updateRecipients(user.id, idParam(req, 'id'), recipients);
  return successResponse(res, 'Recipients updated.', { flow });
};

/* ── Runs ───────────────────────────────────────────────────────────────── */

/**
 * Run now, from the workspace.
 *
 * Runs to completion before answering rather than returning a job id. A flow
 * is capped at five minutes by the engine, and the person who pressed the
 * button is watching — handing back an id they then have to poll would be more
 * moving parts for a worse wait. The scheduler will call the same service
 * function without an HTTP request in front of it.
 */
export const runNow = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const outcome = await service.runStoredFlow(user.id, idParam(req, 'id'), 'manual', user.email);
  return successResponse(res, `Run finished: ${outcome.run.status}.`, outcome);
};

export const listRuns = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
  return successResponse(res, 'Runs.', {
    runs: await service.listRuns(user.id, idParam(req, 'id'), limit),
  });
};

export const getRun = async (req: Request, res: Response) => {
  const user = requireUser(req);
  return successResponse(res, 'Run.', await service.getRun(user.id, idParam(req, 'runId')));
};

/**
 * A report as a file.
 *
 * Sends the bytes with a Content-Disposition rather than JSON the client has
 * to reassemble, so "export" is a link the browser saves.
 */
export const exportRun = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const asked = String(req.query.format ?? 'json').toLowerCase();
  const format = (['json', 'csv', 'html'].includes(asked) ? asked : 'json') as service.ExportFormat;

  const file = await service.exportRun(user.id, idParam(req, 'runId'), format);

  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  return res.status(200).send(file.body);
};

/* ── Schedules ──────────────────────────────────────────────────────────── */

export const getSchedule = async (req: Request, res: Response) => {
  const user = requireUser(req);
  return successResponse(res, 'Schedule.', {
    schedule: await schedule.getSchedule(user.id, idParam(req, 'id')),
  });
};

export const saveSchedule = async (req: Request, res: Response) => {
  const user = requireUser(req);
  const saved = await schedule.saveSchedule(
    user.id,
    idParam(req, 'id'),
    req.body as schedule.SaveScheduleBody,
  );
  return successResponse(res, saved.enabled ? `Scheduled. ${saved.description}.` : 'Schedule paused.', {
    schedule: saved,
  });
};

export const deleteSchedule = async (req: Request, res: Response) => {
  const user = requireUser(req);
  await schedule.removeSchedule(user.id, idParam(req, 'id'));
  return successResponse(res, 'Schedule removed.', null);
};

/**
 * Pause a schedule without removing it.
 *
 * Keeps the cron expression and timezone in place so the user can re-enable
 * without re-entering their settings. Use DELETE /:id/schedule when you want
 * to remove the schedule entirely.
 */
export const pauseSchedule = async (req: Request, res: Response) => {
  const user = requireUser(req);
  await service.pauseSchedule(user.id, idParam(req, 'id'));
  return successResponse(res, 'Schedule paused. Your settings are saved — re-enable it any time.', null);
};

/**
 * Runs whatever is due. Called by the platform's scheduler, not a browser.
 *
 * Guarded by a shared secret rather than a session: there is no user behind
 * this request. Without CRON_SECRET set it refuses outright, so an
 * unconfigured deployment cannot leave the endpoint open.
 */
export const tick = async (req: Request, res: Response) => {
  const secret = env.CRON_SECRET;
  if (!secret) {
    throw new AppError(503, 'No CRON_SECRET is configured, so the scheduler is off.', 'cron_unconfigured');
  }

  const presented = req.headers['x-cron-key'];
  const value = Array.isArray(presented) ? presented[0] ?? '' : presented ?? '';
  if (!safeEqual(value, secret)) throw new AppError(403, 'Not the scheduler.', 'bad_cron_key');

  return successResponse(res, 'Tick.', await schedule.tick());
};
