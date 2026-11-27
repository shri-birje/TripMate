import { useCallback, useEffect, useState } from 'react';
import type { Scheme } from '../../theme/scheme';
import { useTheme } from '../../theme/ThemeProvider';
import { useUserId } from '../auth/AuthProvider';
import { useProfile, useUpdateTheme } from './profileApi';

/**
 * Keeps the theme choice in step with the account, with this precedence:
 *
 *  1. A choice made on THIS device (browser or phone) always wins on that device.
 *  2. If the device has no choice yet, the account's saved Light/Dark is used (and then remembered on the device).
 *  3. Otherwise Light.
 *
 * Signing in never changes a theme chosen on the device, and this component never writes to the account: the account is only
 * updated when the person explicitly picks a theme (`useChangeTheme`). An old account value of "system" is turned into
 * Light or Dark by the theme provider.
 *
 * Place <ThemeProfileSync /> once, inside the auth and query providers.
 */
export function ThemeProfileSync() {
  const { adoptAccountTheme } = useTheme();
  const { data: profile } = useProfile();
  const savedTheme = profile?.themePreference;

  useEffect(() => {
    if (savedTheme) adoptAccountTheme(savedTheme);
  }, [savedTheme, adoptAccountTheme]);

  return null;
}

/** Use this from the Appearance controls: changes the theme now and saves it to the account if signed in. */
export function useChangeTheme() {
  const { preference, setPreference } = useTheme();
  const userId = useUserId();
  const { mutate, isPending } = useUpdateTheme();
  const [saveError, setSaveError] = useState<string | null>(null);

  const change = useCallback(
    (next: Scheme) => {
      // Picking an option is an explicit choice even when it is the one already showing (for example Light on a first visit): it is
      // remembered on this device so signing in cannot replace it. Only a real change is written to the account.
      const changed = next !== preference;
      setPreference(next); // instant, and remembered on this device
      setSaveError(null);
      if (userId && changed) {
        mutate(next, {
          onError: () =>
            setSaveError("Theme changed on this device, but we couldn't save it to your account, so it won't follow you to other devices yet."),
        });
      }
    },
    [mutate, preference, setPreference, userId],
  );

  return { preference, change, saving: isPending, saveError };
}
