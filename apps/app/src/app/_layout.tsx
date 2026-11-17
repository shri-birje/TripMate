import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { LoadingScreen, SetupScreen } from '../components/StatusScreens';
import { AuthProvider, useAuth } from '../features/auth/AuthProvider';
import { ThemeProfileSync } from '../features/profile/themeSync';
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

/**
 * PROTECTED ROUTES.
 * Signed-in people can only reach the (app) screens; signed-out people can only
 * reach the (auth) screens. Typing a protected address while signed out sends you to
 * sign-in, and opening sign-in while already signed in sends you home.
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
  return (
    <>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        {/* Signed out + trying to open an (app) screen  -> go to sign-in */}
        <Stack.Protected guard={signedIn} redirectTo="/sign-in">
          <Stack.Screen name="(app)" />
        </Stack.Protected>
        {/* Signed in + trying to open a sign-in/sign-up screen -> go home */}
        <Stack.Protected guard={!signedIn} redirectTo="/">
          <Stack.Screen name="(auth)" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
