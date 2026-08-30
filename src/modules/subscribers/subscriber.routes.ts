import { Router } from 'express';
import { subscribeLimiter } from '../../middleware/rate-limit.js';
import { requireInternalKey } from '../../middleware/require-auth.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../utils/async-handler.js';
import * as controller from './subscriber.controller.js';
import { subscribeSchema, unsubscribeSchema } from './subscriber.schema.js';

/**
 * Mounted at /api/subscribers.
 *
 *   POST /              email → on the product-updates list
 *   POST /unsubscribe   token or email → off it
 *
 * Behind the internal-key check like the rest, so when INTERNAL_API_KEY is set
 * the only way in is the frontend's own proxy route. That is what stops the
 * list being filled from a script the moment the endpoint is discovered.
 */

const router = Router();

router.use(requireInternalKey);

router.post('/', subscribeLimiter, validate(subscribeSchema), asyncHandler(controller.subscribe));
router.post(
  '/unsubscribe',
  subscribeLimiter,
  validate(unsubscribeSchema),
  asyncHandler(controller.unsubscribe),
);

export default router;
