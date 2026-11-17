import { z } from 'zod';
import { APP_ENVIRONMENTS } from '@tripmate/core';

/**
 * All configuration comes from environment variables and is validated once at
 * startup. If something is missing or malformed the server refuses to start,
 * instead of failing later in a confusing way.
 */
const EnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVIRONMENTS).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  CORS_ORIGINS: z.string().default('http://localhost:8081'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // Empty strings (from a blank line in .env) are treated as "not set".
  SUPABASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional().or(z.literal('').transform(() => undefined)),
});

export interface AppConfig {
  appEnv: (typeof APP_ENVIRONMENTS)[number];
  port: number;
  corsOrigins: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  version: string;
}

export const API_VERSION = '0.1.0';

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  return {
    appEnv: e.APP_ENV,
    port: e.PORT,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: e.LOG_LEVEL,
    supabaseUrl: e.SUPABASE_URL,
    supabaseServiceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
    version: API_VERSION,
  };
}
