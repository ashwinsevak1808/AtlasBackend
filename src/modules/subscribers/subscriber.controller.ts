import type { Request, Response } from 'express';
import { requestMeta } from '../../middleware/require-auth.js';
import { successResponse } from '../../utils/api-response.js';
import * as service from './subscriber.service.js';
import type { SubscribeBody, UnsubscribeBody } from './subscriber.schema.js';

/**
 * Joining and leaving the product-updates list.
 *
 * No account is involved and none is created. Phase 1 has no sign-in, and
 * asking someone to make an account to receive an email would be a worse
 * trade than a table with an address in it.
 */

export async function subscribe(req: Request, res: Response) {
  const body = req.body as SubscribeBody;
  const meta = requestMeta(req);

  const result = await service.subscribe(body.email, {
    source: body.source ?? 'landing',
    referrer: body.referrer ?? null,
    utmSource: body.utmSource ?? null,
    utmMedium: body.utmMedium ?? null,
    utmCampaign: body.utmCampaign ?? null,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  /* 200 rather than 201 even for a new row: the browser cannot act on the
     difference, and an address that was already there is a success from the
     point of view of the person who just typed it. */
  return successResponse(
    res,
    result.alreadySubscribed
      ? 'You are already on the list.'
      : 'You are on the list. We will only email about releases.',
    result,
  );
}

export async function unsubscribe(req: Request, res: Response) {
  const body = req.body as UnsubscribeBody;
  await service.unsubscribe({
    ...(body.token ? { token: body.token } : {}),
    ...(body.email ? { email: body.email } : {}),
  });
  return successResponse(res, 'That address will not receive any more email.');
}
