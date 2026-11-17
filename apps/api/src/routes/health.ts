import { Hono } from 'hono';
import { HealthResponseSchema, type HealthResponse } from '@tripmate/core';
import type { AppConfig } from '../config';
import type { DatabaseCheck } from '../database';

/**
 * GET /v1/health
 * Used by uptime monitors and by the app to confirm the API is reachable.
 * Reveals no user data and no secrets. Public (no login needed).
 */
export function healthRoutes(config: AppConfig, checkDatabase: DatabaseCheck) {
  const router = new Hono();

  router.get('/health', async (c) => {
    const database = await checkDatabase();
    const body: HealthResponse = {
      // "not_configured" is normal early in development, so only a real
      // connection failure counts as degraded.
      status: database === 'error' ? 'degraded' : 'ok',
      service: 'tripmate-api',
      version: config.version,
      environment: config.appEnv,
      time: new Date().toISOString(),
      checks: { database },
    };
    // Parse our own output: guarantees the response matches the shared contract.
    const valid = HealthResponseSchema.parse(body);
    c.header('Cache-Control', 'no-store');
    return c.json(valid, database === 'error' ? 503 : 200);
  });

  return router;
}
