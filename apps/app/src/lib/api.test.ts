import { describe, expect, it } from 'vitest';
import { ApiError, fetchHealth } from './api';
import { getApiBaseUrl } from './config';

const validBody = {
  status: 'ok',
  service: 'tripmate-api',
  version: '0.1.0',
  environment: 'development',
  time: '2026-11-17T10:00:00.000Z',
  checks: { database: 'not_configured' },
};

const respond = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe('fetchHealth', () => {
  it('returns the parsed health response', async () => {
    const h = await fetchHealth({ baseUrl: 'http://x', fetchImpl: respond(validBody) });
    expect(h.status).toBe('ok');
  });

  it('calls /v1/health on the configured base URL', async () => {
    let url = '';
    const spy = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(validBody));
    }) as unknown as typeof fetch;
    await fetchHealth({ baseUrl: 'http://api.test', fetchImpl: spy });
    expect(url).toBe('http://api.test/v1/health');
  });

  it('accepts a degraded 503 that has a valid body', async () => {
    const body = { ...validBody, status: 'degraded', checks: { database: 'error' } };
    const h = await fetchHealth({ baseUrl: 'http://x', fetchImpl: respond(body, 503) });
    expect(h.status).toBe('degraded');
  });

  it('rejects a body that does not match the shared contract', async () => {
    await expect(
      fetchHealth({ baseUrl: 'http://x', fetchImpl: respond({ hello: 'world' }) }),
    ).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('reports a network failure', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(fetchHealth({ baseUrl: 'http://x', fetchImpl: down })).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('reports a timeout', async () => {
    const slow = (async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    }) as typeof fetch;
    const err = await fetchHealth({ baseUrl: 'http://x', fetchImpl: slow }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('timeout');
  });

  it('reports unreadable (non-JSON) responses', async () => {
    const html = (async () => new Response('<html>oops</html>', { status: 502 })) as typeof fetch;
    await expect(fetchHealth({ baseUrl: 'http://x', fetchImpl: html })).rejects.toMatchObject({
      kind: 'bad_response',
    });
  });
});

describe('getApiBaseUrl', () => {
  it('defaults to localhost', () => {
    expect(getApiBaseUrl({})).toBe('http://localhost:8787');
  });
  it('uses the env value and strips trailing slashes', () => {
    expect(getApiBaseUrl({ EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com//' })).toBe(
      'https://api.example.com',
    );
  });
  it('ignores a blank value', () => {
    expect(getApiBaseUrl({ EXPO_PUBLIC_API_BASE_URL: '  ' })).toBe('http://localhost:8787');
  });
});
