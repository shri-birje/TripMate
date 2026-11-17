import { describe, expect, it } from 'vitest';
import { classifySupabaseKey, readSupabaseConfig } from './supabaseConfig';

const URL_OK = 'https://abcdefghijklmnop.supabase.co';
const PUBLISHABLE = 'sb_publishable_AbCdEf123456';
const SECRET = 'sb_secret_ZzZzZz987654';

/** Builds a fake (unsigned) JWT with the given role, like the legacy anon/service_role keys. */
function fakeJwt(role: string): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'supabase' })}.signature`;
}

describe('classifySupabaseKey', () => {
  it('recognises each kind of key', () => {
    expect(classifySupabaseKey(PUBLISHABLE)).toBe('publishable');
    expect(classifySupabaseKey(SECRET)).toBe('secret');
    expect(classifySupabaseKey(fakeJwt('anon'))).toBe('legacy_anon');
    expect(classifySupabaseKey(fakeJwt('service_role'))).toBe('service_role');
  });

  it('treats everything else as unknown', () => {
    for (const k of ['', 'hello', 'a.b.c', fakeJwt('authenticated'), 'sb_other_123']) {
      expect(classifySupabaseKey(k)).toBe('unknown');
    }
  });

  it('ignores surrounding whitespace', () => {
    expect(classifySupabaseKey(`  ${PUBLISHABLE}\n`)).toBe('publishable');
  });
});

describe('readSupabaseConfig', () => {
  it('accepts a valid URL and publishable key', () => {
    const r = readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE });
    expect(r).toEqual({ ok: true, url: URL_OK, key: PUBLISHABLE, keyKind: 'publishable' });
  });

  it('accepts a legacy anon key', () => {
    const r = readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: fakeJwt('anon') });
    expect(r.ok && r.keyKind).toBe('legacy_anon');
  });

  it('normalises the URL (trailing slash, path)', () => {
    const r = readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: `${URL_OK}/`, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE });
    expect(r.ok && r.url).toBe(URL_OK);
  });

  it('allows plain http only for a local Supabase', () => {
    for (const u of ['http://localhost:54321', 'http://127.0.0.1:54321']) {
      expect(readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: u, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE }).ok).toBe(true);
    }
    const remoteHttp = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: 'http://abc.supabase.co',
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
    });
    expect(remoteHttp).toMatchObject({ ok: false, reason: 'invalid_url' });
  });

  it('reports missing values with the exact variable name', () => {
    expect(readSupabaseConfig({})).toMatchObject({ ok: false, reason: 'missing_url' });
    expect(readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK })).toMatchObject({ ok: false, reason: 'missing_key' });
    expect(readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '   ' })).toMatchObject({
      ok: false,
      reason: 'missing_key',
    });
  });

  it('rejects a URL that is not a Supabase address', () => {
    for (const u of ['not a url', 'https://evil.example.com', 'ftp://x.supabase.co']) {
      expect(readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: u, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE })).toMatchObject({
        ok: false,
        reason: 'invalid_url',
      });
    }
  });

  it('REFUSES a secret key and a service_role key (never run with these in the frontend)', () => {
    for (const k of [SECRET, fakeJwt('service_role')]) {
      const r = readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: k });
      expect(r).toMatchObject({ ok: false, reason: 'secret_key_in_frontend' });
    }
  });

  it('rejects unrecognised keys', () => {
    expect(readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'nonsense' })).toMatchObject({
      ok: false,
      reason: 'unrecognized_key',
    });
  });

  it('never puts the key into an error message', () => {
    const secretText = SECRET;
    const r = readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: secretText });
    expect(JSON.stringify(r)).not.toContain('ZzZzZz987654');
    const bad = readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: URL_OK, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_wrong_QQQQQQQQ' });
    expect(JSON.stringify(bad)).not.toContain('QQQQQQQQ');
  });
});
