import { DEFAULT_THEME_PREFERENCE, isThemePreference, type ThemePreference } from '@tripmate/core';

export type Scheme = 'light' | 'dark';

/**
 * Turns the user's choice into the palette actually shown.
 *   light  -> light
 *   dark   -> dark
 *   system -> whatever the phone/browser is set to (light if unknown)
 */
export function resolveScheme(preference: ThemePreference, systemScheme: string | null | undefined): Scheme {
  if (preference === 'dark') return 'dark';
  if (preference === 'light') return 'light';
  return systemScheme === 'dark' ? 'dark' : 'light';
}

// ---- remembering the choice on this device ---------------------------------

export const THEME_STORAGE_KEY = 'tripmate.theme-preference';

export interface SimpleStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Reads the saved choice. First launch, a missing value, or a corrupt value all give Light (the product default). */
export async function loadThemePreference(store: SimpleStore): Promise<ThemePreference> {
  try {
    const value = await store.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/** Saves the choice. A storage failure must never break the app, so it is swallowed. */
export async function saveThemePreference(store: SimpleStore, preference: ThemePreference): Promise<void> {
  try {
    await store.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* the choice still applies for this session */
  }
}
