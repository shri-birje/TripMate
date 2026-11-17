import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from '@tripmate/core';
import { createApp } from './app';
import { loadConfig } from './config';
import { createDatabaseCheck } from './database';
import { createLogger } from './logger';

const silent = createLogger('error', () => {});

// res.json() is typed as unknown; this gives tests a loose shape to read from.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = async (res: Response) => (await res.json()) as Record<string, any>;

function build(dbStatus: 'ok' | 'not_configured' | 'error' = 'not_configured') {
  const config = loadConfig({ APP_ENV: 'test', CORS_ORIGINS: 'http://localhost:8081' });
  return createApp(config, { logger: silent, checkDatabase: async () => dbStatus });
}

describe('GET /v1/health', () => {
  it('returns 200 and matches the shared contract', async () => {
    const res = await build().request('/v1/health');
    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(await res.json());
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('test');
    expect(body.checks.database).toBe('not_configured');
  });

  it('reports ok when the database is reachable', async () => {
    const res = await build('ok').request('/v1/health');
    expect(res.status).toBe(200);
    expect((await readJson(res)).checks.database).toBe('ok');
  });

  it('returns 503 and "degraded" when the database check fails', async () => {
    const res = await build('error').request('/v1/health');
    expect(res.status).toBe(503);
    expect((await readJson(res)).status).toBe('degraded');
  });

  it('is never cached', async () => {
    const res = await build().request('/v1/health');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('request id and headers', () => {
  it('generates a request id when none is sent', async () => {
    const res = await build().request('/v1/health');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a request id sent by the caller', async () => {
    const res = await build().request('/v1/health', { headers: { 'x-request-id': 'abc-123' } });
    expect(res.headers.get('x-request-id')).toBe('abc-123');
  });

  it('sets security headers', async () => {
    const res = await build().request('/v1/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('CORS', () => {
  it('allows a configured origin', async () => {
    const res = await build().request('/v1/health', { headers: { Origin: 'http://localhost:8081' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:8081');
  });

  it('does not allow an unknown origin', async () => {
    const res = await build().request('/v1/health', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('error handling', () => {
  it('returns the standard error body for unknown routes', async () => {
    const res = await build().request('/v1/nope');
    expect(res.status).toBe(404);
    const body = await readJson(res);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.requestId).toBe('string');
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c.appEnv).toBe('development');
    expect(c.port).toBe(8787);
    expect(c.supabaseUrl).toBeUndefined();
  });

  it('treats blank Supabase values as not set', () => {
    const c = loadConfig({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' });
    expect(c.supabaseUrl).toBeUndefined();
    expect(c.supabaseServiceRoleKey).toBeUndefined();
  });

  it('rejects an invalid environment instead of starting', () => {
    expect(() => loadConfig({ APP_ENV: 'banana' })).toThrow(/Invalid environment configuration/);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
  });
});

describe('createDatabaseCheck', () => {
  const cfg = { supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'secret-key' };

  it('is not_configured without credentials', async () => {
    const check = createDatabaseCheck({ supabaseUrl: undefined, supabaseServiceRoleKey: undefined });
    expect(await check()).toBe('not_configured');
  });

  it('is ok when the database answers 200', async () => {
    const fake = (async () => new Response('{}', { status: 200 })) as typeof fetch;
    expect(await createDatabaseCheck(cfg, fake)()).toBe('ok');
  });

  it('is error on a non-2xx answer or a network failure', async () => {
    const bad = (async () => new Response('no', { status: 500 })) as typeof fetch;
    const down = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await createDatabaseCheck(cfg, bad)()).toBe('error');
    expect(await createDatabaseCheck(cfg, down)()).toBe('error');
  });

  it('never sends the key anywhere except the database request headers', async () => {
    let seenUrl = '';
    const spy = (async (url: string) => {
      seenUrl = url;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await createDatabaseCheck(cfg, spy)();
    expect(seenUrl).not.toContain('secret-key');
  });
});
