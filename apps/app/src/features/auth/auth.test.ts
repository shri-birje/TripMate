import { describe, expect, it, vi } from 'vitest';
import { friendlyAuthError } from './authErrors';
import { signInWithEmail, signOutThisDevice, signUpWithEmail, type AuthApi } from './authService';

function fakeApi(overrides: Partial<AuthApi> = {}): AuthApi & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { signUp: [], signInWithPassword: [], signOut: [] };
  return {
    calls,
    signUp: async (args) => {
      calls.signUp!.push(args);
      return { data: { session: null }, error: null };
    },
    signInWithPassword: async (args) => {
      calls.signInWithPassword!.push(args);
      return { data: { session: { access_token: 'x' } }, error: null };
    },
    signOut: async (args) => {
      calls.signOut!.push(args);
      return { error: null };
    },
    ...overrides,
  };
}

const goodSignUp = { displayName: ' Asha Rao ', email: ' Asha@Example.com ', password: 'Goa2026trip' };

describe('friendlyAuthError', () => {
  it.each([
    ['invalid_credentials', /don't match/],
    ['email_not_confirmed', /confirm your email/],
    ['user_already_exists', /already exists/],
    ['email_exists', /already exists/],
    ['weak_password', /too easy to guess/],
    ['over_email_send_rate_limit', /wait a few minutes/],
    ['over_request_rate_limit', /wait a minute/],
    ['signup_disabled', /turned off/],
  ])('explains %s in plain words', (code, pattern) => {
    expect(friendlyAuthError({ code, message: 'RAW SERVER TEXT' })).toMatch(pattern);
  });

  it('recognises network failures', () => {
    expect(friendlyAuthError({ name: 'AuthRetryableFetchError', message: 'x' })).toMatch(/Can't reach the server/);
    expect(friendlyAuthError({ message: 'Failed to fetch' })).toMatch(/Can't reach the server/);
    expect(friendlyAuthError({ message: 'Network request failed' })).toMatch(/Can't reach the server/);
    expect(friendlyAuthError({ status: 0 })).toMatch(/Can't reach the server/);
  });

  it('treats an unknown HTTP 429 as rate limiting', () => {
    expect(friendlyAuthError({ status: 429 })).toMatch(/wait a minute/);
  });

  it('never shows raw server text for unknown errors', () => {
    const msg = friendlyAuthError({ code: 'something_new', message: 'SELECT * FROM users failed at 10.0.0.5' });
    expect(msg).toBe('Something went wrong. Please try again.');
    expect(msg).not.toContain('SELECT');
    expect(friendlyAuthError(null)).toBe('Something went wrong. Please try again.');
  });
});

describe('signUpWithEmail', () => {
  it('sends cleaned, validated data and the display name', async () => {
    const api = fakeApi();
    await signUpWithEmail(api, goodSignUp, 'https://app.example.com');
    expect(api.calls.signUp![0]).toEqual({
      email: 'asha@example.com',
      password: 'Goa2026trip',
      options: { data: { display_name: 'Asha Rao' }, emailRedirectTo: 'https://app.example.com' },
    });
  });

  it('says "confirm_email" when no session comes back (email confirmation is on)', async () => {
    expect(await signUpWithEmail(fakeApi(), goodSignUp)).toEqual({ ok: true, outcome: 'confirm_email' });
  });

  it('says "signed_in" when a session comes back (confirmation is off)', async () => {
    const api = fakeApi({ signUp: async () => ({ data: { session: { access_token: 'x' } }, error: null }) });
    expect(await signUpWithEmail(api, goodSignUp)).toEqual({ ok: true, outcome: 'signed_in' });
  });

  it('does not call the server when the input is invalid, and returns per-field messages', async () => {
    const api = fakeApi();
    const r = await signUpWithEmail(api, { displayName: '', email: 'bad', password: 'short' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors ?? {}).sort()).toEqual(['displayName', 'email', 'password']);
    expect(api.calls.signUp).toHaveLength(0);
  });

  it('turns server errors into friendly messages', async () => {
    const api = fakeApi({ signUp: async () => ({ data: { session: null }, error: { code: 'over_email_send_rate_limit' } }) });
    const r = await signUpWithEmail(api, goodSignUp);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/wait a few minutes/) });
  });

  it('never throws, even if the network layer does', async () => {
    const api = fakeApi({
      signUp: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await signUpWithEmail(api, goodSignUp)).toMatchObject({ ok: false, message: expect.stringMatching(/Can't reach the server/) });
  });
});

describe('signInWithEmail', () => {
  it('signs in with cleaned credentials', async () => {
    const api = fakeApi();
    expect(await signInWithEmail(api, { email: ' A@B.co ', password: 'pw' })).toEqual({ ok: true, outcome: 'signed_in' });
    expect(api.calls.signInWithPassword![0]).toEqual({ email: 'a@b.co', password: 'pw' });
  });

  it('wrong password gives a generic message that does not say whether the email exists', async () => {
    const api = fakeApi({ signInWithPassword: async () => ({ data: { session: null }, error: { code: 'invalid_credentials' } }) });
    const r = await signInWithEmail(api, { email: 'a@b.co', password: 'wrong' });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.message).not.toMatch(/no account|not found|exist/i);
  });

  it('does not call the server for blank fields', async () => {
    const api = fakeApi();
    const r = await signInWithEmail(api, { email: '', password: '' });
    expect(r.ok).toBe(false);
    expect(api.calls.signInWithPassword).toHaveLength(0);
  });

  it('treats a response without a session as a failure', async () => {
    const api = fakeApi({ signInWithPassword: async () => ({ data: { session: null }, error: null }) });
    expect((await signInWithEmail(api, { email: 'a@b.co', password: 'pw' })).ok).toBe(false);
  });

  it('never throws', async () => {
    const api = fakeApi({
      signInWithPassword: async () => {
        throw new Error('boom');
      },
    });
    expect((await signInWithEmail(api, { email: 'a@b.co', password: 'pw' })).ok).toBe(false);
  });
});

describe('signOutThisDevice', () => {
  it('signs out this device only', async () => {
    const api = fakeApi();
    expect(await signOutThisDevice(api)).toEqual({ ok: true, outcome: 'signed_out' });
    expect(api.calls.signOut![0]).toEqual({ scope: 'local' });
  });

  it('reports a failure with a friendly message', async () => {
    const api = fakeApi({ signOut: async () => ({ error: { name: 'AuthRetryableFetchError' } }) });
    expect(await signOutThisDevice(api)).toMatchObject({ ok: false, message: expect.stringMatching(/Can't reach the server/) });
  });

  it('never throws', async () => {
    const spy = vi.fn().mockRejectedValue(new Error('x'));
    expect((await signOutThisDevice(fakeApi({ signOut: spy }))).ok).toBe(false);
  });
});
