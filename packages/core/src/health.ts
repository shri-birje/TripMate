import { z } from 'zod';

/**
 * API contract for GET /v1/health.
 *
 * Defined here (not in the API or the app) so that the server builds its
 * response from this schema and the client validates the response with the
 * same schema. If they ever disagree, tests and type-checking fail.
 */
export const APP_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('tripmate-api'),
  version: z.string(),
  environment: z.enum(APP_ENVIRONMENTS),
  time: z.string().datetime(),
  checks: z.object({
    database: z.enum(['ok', 'not_configured', 'error']),
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];
