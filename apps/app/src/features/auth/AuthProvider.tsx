import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { supabase, supabaseConfigError } from '../../lib/supabase';
import {
  signInWithEmail,
  signOutThisDevice,
  signUpWithEmail,
  type AuthResult,
  type SignUpOutcome,
} from './authService';

/**
 * Who is signed in, for the whole app.
 *
 *   loading       checking whether a saved session exists
 *   unconfigured  Supabase settings missing or unsafe (setup screen is shown)
 *   signedOut     nobody signed in
 *   signedIn      a user is signed in
 *
 * The route guard (app/_layout.tsx) shows the signed-in screens only for
 * `signedIn` and the sign-in screens only for `signedOut`.
 */
export type AuthState =
  | { status: 'loading' }
  | { status: 'unconfigured'; message: string }
  | { status: 'signedOut' }
  | { status: 'signedIn'; userId: string; email: string | null };

interface AuthContextValue {
  state: AuthState;
  signUp: (input: unknown) => Promise<AuthResult<SignUpOutcome>>;
  signIn: (input: unknown) => Promise<AuthResult<'signed_in'>>;
  signOut: () => Promise<AuthResult<'signed_out'>>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const NOT_CONFIGURED: AuthResult<never> = {
  ok: false,
  message: "The app isn't connected to its server yet. Please try again later.",
};

function stateFromSession(session: Session | null): AuthState {
  return session ? { status: 'signedIn', userId: session.user.id, email: session.user.email ?? null } : { status: 'signedOut' };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>(
    supabase ? { status: 'loading' } : { status: 'unconfigured', message: supabaseConfigError ?? 'Supabase is not configured.' },
  );

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    const apply = (session: Session | null) => {
      if (alive) setState(stateFromSession(session));
    };

    // 1. Is there a saved session from last time?
    supabase.auth
      .getSession()
      .then(({ data }) => apply(data.session))
      .catch(() => apply(null)); // unreadable saved session: treat as signed out

    // 2. Stay up to date: sign-in, sign-out, token renewal, email-confirmation links.
    //    (Only set state in here; calling more Supabase functions inside this callback can deadlock.)
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') queryClient.clear(); // never leave one person's data in memory for the next
      apply(session);
    });
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient]);

  const signUp = useCallback(async (input: unknown) => {
    if (!supabase) return NOT_CONFIGURED;
    // After clicking the email link the person should land back on this website.
    const redirect = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : undefined;
    return signUpWithEmail(supabase.auth, input, redirect);
  }, []);

  const signIn = useCallback(async (input: unknown) => {
    if (!supabase) return NOT_CONFIGURED;
    return signInWithEmail(supabase.auth, input);
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return NOT_CONFIGURED;
    const result = await signOutThisDevice(supabase.auth);
    if (result.ok) queryClient.clear();
    return result;
  }, [queryClient]);

  const value = useMemo(() => ({ state, signUp, signIn, signOut }), [state, signUp, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The signed-in user's id, or null. */
export function useUserId(): string | null {
  const { state } = useAuth();
  return state.status === 'signedIn' ? state.userId : null;
}
