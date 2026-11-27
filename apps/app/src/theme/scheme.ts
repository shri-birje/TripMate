import { isThemePreference } from '@tripmate/core';

/** The only two appearances people can choose. */
export type Scheme = 'light' | 'dark';

export const DEFAULT_SCHEME: Scheme = 'light'; // product rule: Light is the default

/**
 * Turns any stored or account value into Light or Dark.
 *   light / dark -> themselves
 *   system (legacy, still allowed by the database) -> what the phone/browser is set to right now, Light if unknown
 *   anything else (missing, corrupt) -> null (no usable choice)
 */
export function normalizeScheme(value: unknown, systemScheme?: string | null): Scheme | null {
  if (value === 'light' || value === 'dark') return value;
  if (isThemePreference(value)) return systemScheme === 'dark' ? 'dark' : 'light'; // 'system'
  return null;
}

// ---- remembering the choice on this device ---------------------------------

export const THEME_STORAGE_KEY = 'tripmate.theme-preference';

export interface SimpleStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Reads the choice saved on this device. Returns null when there is none (first visit, corrupt value, broken storage).
 * A legacy "system" value is turned into the current Light/Dark.
 */
export async function loadDeviceScheme(store: SimpleStore, systemScheme?: string | null): Promise<Scheme | null> {
  try {
    return normalizeScheme(await store.getItem(THEME_STORAGE_KEY), systemScheme);
  } catch {
    return null;
  }
}

/** Saves the choice. A storage failure must never break the app, so it is swallowed. */
export async function saveDeviceScheme(store: SimpleStore, scheme: Scheme): Promise<void> {
  try {
    await store.setItem(THEME_STORAGE_KEY, scheme);
  } catch {
    /* the choice still applies for this session */
  }
}

/**
 * Which appearance to show when a profile has loaded.
 *   1. a choice made on this device wins (`deviceChoice`)
 *   2. otherwise the account's saved Light/Dark (legacy "system" resolved)
 *   3. otherwise the current one (Light by default)
 */
export function resolveAfterProfile(deviceChoice: Scheme | null, accountValue: unknown, current: Scheme, systemScheme?: string | null): Scheme {
  if (deviceChoice) return deviceChoice;
  return normalizeScheme(accountValue, systemScheme) ?? current;
}
