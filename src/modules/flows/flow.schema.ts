import { z } from 'zod';

/** Validation for the flow endpoints. Mirrors `flow.types.ts`. */

const row = z.object({
  id: z.string().default(''),
  key: z.string().default(''),
  value: z.string().default(''),
  enabled: z.boolean().default(true),
});

const auth = z
  .object({
    mode: z.enum(['none', 'bearer', 'basic', 'apiKey']).default('none'),
    token: z.string().default(''),
    username: z.string().default(''),
    password: z.string().default(''),
    keyName: z.string().default(''),
    keyIn: z.enum(['header', 'query']).default('header'),
  })
  .default({});

const request = z.object({
  id: z.string().min(1),
  name: z.string().default('Request'),
  method: z.string().default('GET'),
  url: z.string().default(''),
  queryParams: z.array(row).default([]),
  headers: z.array(row).default([]),
  cookies: z.array(row).default([]),
  bodyType: z
    .enum(['none', 'json', 'xml', 'raw', 'form-data', 'urlencoded', 'graphql'])
    .default('none'),
  body: z.string().default(''),
  formFields: z.array(row).default([]),
  graphqlQuery: z.string().default(''),
  graphqlVariables: z.string().default(''),
  auth,
});

/* A ceiling on every list, because this is the one endpoint that accepts a
   whole object graph from a client and stores it. */
export const definitionSchema = z.object({
  name: z.string().default('Flow'),
  nodes: z.array(z.object({ id: z.string().min(1), requestId: z.string().min(1) })).max(200),
  edges: z
    .array(
      z.object({
        id: z.string().default(''),
        source: z.string().min(1),
        target: z.string().min(1),
        mappings: z
          .array(z.object({ id: z.string().default(''), from: z.string().default(''), to: z.string().default('') }))
          .max(50)
          .default([]),
      }),
    )
    .max(400)
    .default([]),
  requests: z.array(request).max(200),
});

const email = z.string().trim().toLowerCase().email('That is not an email address.');

export const uploadFlowSchema = z.object({
  projectKey: z.string().min(1).max(400),
  clientFlowId: z.string().min(1).max(200),
  name: z.string().trim().min(1, 'Give this flow a name.').max(120),
  definition: definitionSchema,
  environmentId: z.string().uuid().nullable().optional(),
  recipients: z.array(email).max(20).default([]),
});

export const environmentSchema = z.object({
  projectKey: z.string().min(1).max(400),
  name: z.string().trim().min(1).max(80),
  /* Values are opaque to us; only the size is our business. */
  values: z.record(z.string().max(200), z.string().max(8_000)).default({}),
});

export const recipientsSchema = z.object({
  recipients: z.array(email).max(20),
});

export const runSchema = z.object({
  flowId: z.string().uuid(),
});

export type UploadFlowBody = z.infer<typeof uploadFlowSchema>;
export type EnvironmentBody = z.infer<typeof environmentSchema>;
export type RecipientsBody = z.infer<typeof recipientsSchema>;

/**
 * A schedule. `cron` is required for a repeating one, `runAt` for a one-off —
 * refined rather than left to the service so the message names the field.
 */
export const scheduleSchema = z
  .object({
    enabled: z.boolean().default(true),
    kind: z.enum(['cron', 'once']).default('cron'),
    cron: z.string().trim().max(120).nullable().optional(),
    /** ISO-8601 instant, for a one-off. */
    runAt: z.string().datetime({ offset: true }).nullable().optional(),
    /** IANA name. "07:00" means nothing without it. */
    timezone: z.string().trim().min(1).max(64).default('UTC'),
  })
  .refine((body) => body.kind !== 'cron' || Boolean(body.cron?.trim()), {
    path: ['cron'],
    message: 'Choose when this should repeat.',
  })
  .refine((body) => body.kind !== 'once' || Boolean(body.runAt), {
    path: ['runAt'],
    message: 'Pick the date and time to run it.',
  });

export type ScheduleBody = z.infer<typeof scheduleSchema>;
