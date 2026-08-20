import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireInternalKey, requireVerified } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { isProduction } from '../../config/env.js';
import * as controller from './flow.controller.js';
import { environmentSchema, recipientsSchema, scheduleSchema, uploadFlowSchema } from './flow.schema.js';

/**
 * Mounted at /api/flows. Signed in, verified accounts only — this is the
 * feature that holds people's credentials, so an unverified address must not
 * be able to point it anywhere.
 *
 *   GET    /capabilities        can this server run flows at all
 *   POST   /environments        save a variable set (values are sealed)
 *   GET    /environments        list them, names only
 *   DELETE /environments/:id
 *   POST   /                    upload a flow, refused if it cannot run here
 *   GET    /                    list uploaded flows
 *   DELETE /:id                 also cancels any active schedule
 *   PUT    /:id/recipients      who gets the report
 *   POST   /:id/run             run now, answers when it has finished
 *   GET    /:id/runs            history
 *   GET    /:id/schedule        the schedule on this flow, or null
 *   PUT    /:id/schedule        create, edit, pause (enabled:false), re-enable
 *   PATCH  /:id/schedule/pause  pause without touching settings (keeps cron/tz)
 *   DELETE /:id/schedule        remove the schedule row entirely
 *   POST   /tick                the scheduler's knock — no session, x-cron-key
 *   GET    /runs/:runId         one run with its steps
 *   GET    /runs/:runId/export  ?format=json|csv|html
 */

const router = Router();

/**
 * The scheduler's knock, mounted before the session guard.
 *
 * There is no user behind this request — it comes from Cloud Scheduler — so it
 * authenticates with `x-cron-key` instead, checked inside the handler. It has
 * to sit above `requireAuth` or it would be rejected before it got there.
 */
router.post('/tick', asyncHandler(controller.tick));

router.use(requireInternalKey, requireAuth, requireVerified);

/**
 * A run makes real outbound requests on our infrastructure, so it gets a
 * tighter ceiling than an ordinary read. The engine's own five-minute cap
 * bounds one run; this bounds how many someone can start.
 */
const runLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !isProduction,
  message: { success: false, message: 'Too many runs started. Try again shortly.', data: null, errors: [] },
});

router.get('/capabilities', asyncHandler(controller.capabilities));

router.post('/environments', validate(environmentSchema), asyncHandler(controller.saveEnvironment));
router.get('/environments', asyncHandler(controller.listEnvironments));
router.delete('/environments/:id', asyncHandler(controller.deleteEnvironment));

router.post('/', validate(uploadFlowSchema), asyncHandler(controller.uploadFlow));
router.get('/', asyncHandler(controller.listFlows));

/* Before /:id, or "runs" is read as a flow id. */
router.get('/runs/:runId/export', asyncHandler(controller.exportRun));
router.get('/runs/:runId', asyncHandler(controller.getRun));

router.delete('/:id', asyncHandler(controller.deleteFlow));
router.put('/:id/recipients', validate(recipientsSchema), asyncHandler(controller.setRecipients));
router.post('/:id/run', runLimiter, asyncHandler(controller.runNow));
router.get('/:id/runs', asyncHandler(controller.listRuns));

router.get('/:id/schedule', asyncHandler(controller.getSchedule));
router.put('/:id/schedule', validate(scheduleSchema), asyncHandler(controller.saveSchedule));
router.patch('/:id/schedule/pause', asyncHandler(controller.pauseSchedule));
router.delete('/:id/schedule', asyncHandler(controller.deleteSchedule));

export default router;
