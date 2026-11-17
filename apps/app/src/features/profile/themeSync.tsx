import { useCallback, useEffect, useState } from 'react';
import type { ThemePreference } from '@tripmate/core';
import { useTheme } from '../../theme/ThemeProvider';
import { useUserId } from '../auth/AuthProvider';
import { useProfile, useUpdateTheme } from './profileApi';

/**
 * Keeps the theme choice in step with the account.
 *
 *  - On this device the choice is remembered locally right away (so the app
 *    opens in the right theme with no flash, even offline).
 *  - When signed in, the choice is also saved to the profile, so it follows
 *    the person to their other devices.
 *  - When a profile loads after sign-in, the account's saved choice wins.
 *
 * Place <ThemeProfileSync /> once, inside the auth and query providers.
 */
export function ThemeProfileSync() {
  const { setPreference } = useTheme();
  const { data: profile } = useProfile();
  const savedTheme = profile?.themePreference;

  // Only reacts when the ACCOUNT's value changes (profile loaded / saved), never to local taps,
  // so choosing a theme can never be undone by this effect.
  useEffect(() => {
    if (savedTheme) setPreference(savedTheme);
  }, [savedTheme, setPreference]);

  return null;
}

/** Use this from the Appearance control: changes the theme now and saves it to the account if signed in. */
export function useChangeTheme() {
  const { preference, setPreference } = useTheme();
  const userId = useUserId();
  const { mutate, isPending } = useUpdateTheme();
  const [saveError, setSaveError] = useState<string | null>(null);

  const change = useCallback(
    (next: ThemePreference) => {
      setPreference(next); // instant, and remembered on this device
      setSaveError(null);
      if (userId) {
        mutate(next, {
          onError: () =>
            setSaveError("Theme changed on this device, but we couldn't save it to your account, so it won't follow you to other devices yet."),
        });
      }
    },
    [mutate, setPreference, userId],
  );

  return { preference, change, saving: isPending, saveError };
}
