import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Platform } from 'react-native';
import { LoadingScreen, SetupScreen } from '../components/StatusScreens';
import { AuthProvider, useAuth } from '../features/auth/AuthProvider';
import { ThemeProfileSync } from '../features/profile/themeSync';
import { pendingInvite } from '../lib/pendingInvite';
import { ThemeProvider, useTheme } from '../theme/ThemeProvider';

/**
 * Root of the app. Wraps every screen in:
 *   QueryClientProvider  data fetching and caching
 *   ThemeProvider        light / dark / system colours
 *   AuthProvider         who is signed in
 * then decides which screens a visitor may see (the route guard).
 */
export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <ThemeProfileSync />
          <RouteGuard />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const SIGNED_OUT_HOME = Platform.OS === 'web' ? '/welcome' : '/sign-in';

/**
 * PROTECTED ROUTES.
 * Signed-in people can only reach the (app) screens; signed-out people can only
 * reach the (auth) screens. Typing a protected address while signed out sends you to
 * sign-in, and opening sign-in while already signed in sends you home.
 *
 * One screen is open to everyone: /join/<token> (an invitation link). A signed-out person who
 * opens it is sent to sign in and, once signed in, is brought back to the same link (the token
 * is kept briefly by lib/pendingInvite, and cleared as soon as it is used or found invalid).
 *
 * (This protects what the app SHOWS. What a person can actually read or change is
 * enforced separately by the database's security rules.)
 */
function RouteGuard() {
  const { state } = useAuth();
  const { colors, scheme } = useTheme();

  if (state.status === 'loading') return <LoadingScreen />;
  if (state.status === 'unconfigured') return <SetupScreen message={state.message} />;

  const signedIn = state.status === 'signedIn';
  const waitingInvite = pendingInvite.peek();
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        {/* Signed out + trying to open an (app) screen  -> go to sign-in */}
        {/* (on the web, a signed-out visitor to the root address lands on the public website; phones go straight to sign-in) */}
        <Stack.Protected guard={signedIn} redirectTo={SIGNED_OUT_HOME}>
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        {/* Signed in + trying to open a sign-in/sign-up screen -> go home (or back to the invitation they were opening) */}
        <Stack.Protected guard={!signedIn} redirectTo={waitingInvite ? `/join/${waitingInvite}` : '/'}>
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
        {/* The public website: only for people who are signed out; a signed-in person is sent to the app, never back here */}
        <Stack.Protected guard={!signedIn} redirectTo="/">
          <Stack.Screen name="(site)" />
        </Stack.Protected>
        {/* Invitation links and the About/Contact/Privacy/Terms/Help placeholder pages: open to everyone */}
        <Stack.Screen name="join/[token]" />
        <Stack.Screen name="info/[page]" />
      </Stack>
    </>
  );
}
