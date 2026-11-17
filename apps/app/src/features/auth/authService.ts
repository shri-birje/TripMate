import { validate, SignInSchema, SignUpSchema } from '@tripmate/core';
import { friendlyAuthError, type AuthErrorLike } from './authErrors';

/**
 * The few things the app does with Supabase Auth, written so they never throw
 * at the screen: every call returns either { ok: true, ... } or a friendly
 * message. Input is validated first, so obviously bad data never leaves the
 * device.
 *
 * `AuthApi` describes just the parts of Supabase's auth client we use, which
 * lets tests supply a fake one.
 */
export interface AuthApi {
  signUp(args: {
    email: string;
    password: string;
    options?: { data?: Record<string, unknown>; emailRedirectTo?: string };
  }): PromiseLike<{ data: { session: unknown | null }; error: AuthErrorLike | null }>;
  signInWithPassword(args: { email: string; password: string }): PromiseLike<{
    data: { session: unknown | null };
    error: AuthErrorLike | null;
  }>;
  signOut(args?: { scope?: 'local' | 'global' | 'others' }): PromiseLike<{ error: AuthErrorLike | null }>;
}

export type AuthResult<T> =
  | { ok: true; outcome: T }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

export type SignUpOutcome = 'signed_in' | 'confirm_email';

async function guarded<T>(run: () => Promise<AuthResult<T>>): Promise<AuthResult<T>> {
  try {
    return await run();
  } catch (e) {
    const err = e as AuthErrorLike;
    return { ok: false, message: friendlyAuthError({ name: err?.name, message: err?.message }) };
  }
}

export function signUpWithEmail(
  api: AuthApi,
  input: unknown,
  emailRedirectTo?: string,
): Promise<AuthResult<SignUpOutcome>> {
  return guarded(async () => {
    const v = validate(SignUpSchema, input);
    if (!v.ok) return { ok: false, message: 'Please fix the highlighted fields.', fieldErrors: v.errors };

    const { data, error } = await api.signUp({
      email: v.data.email,
      password: v.data.password,
      options: {
        data: { display_name: v.data.displayName },
        ...(emailRedirectTo ? { emailRedirectTo } : {}),
      },
    });
    if (error) return { ok: false, message: friendlyAuthError(error) };
    // With email confirmation on, Supabase creates the account but gives no session until the link is clicked.
    // The same answer is returned for an email that is already registered, so this screen never reveals who has an account.
    return { ok: true, outcome: data.session ? 'signed_in' : 'confirm_email' };
  });
}

export function signInWithEmail(api: AuthApi, input: unknown): Promise<AuthResult<'signed_in'>> {
  return guarded(async () => {
    const v = validate(SignInSchema, input);
    if (!v.ok) return { ok: false, message: 'Please fix the highlighted fields.', fieldErrors: v.errors };

    const { data, error } = await api.signInWithPassword({ email: v.data.email, password: v.data.password });
    if (error) return { ok: false, message: friendlyAuthError(error) };
    if (!data.session) return { ok: false, message: friendlyAuthError(null) };
    return { ok: true, outcome: 'signed_in' };
  });
}

/** Signs out this device only (other devices stay signed in). */
export function signOutThisDevice(api: AuthApi): Promise<AuthResult<'signed_out'>> {
  return guarded(async () => {
    const { error } = await api.signOut({ scope: 'local' });
    if (error) return { ok: false, message: friendlyAuthError(error) };
    return { ok: true, outcome: 'signed_out' };
  });
}
