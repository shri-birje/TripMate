import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { DEFAULT_THEME_PREFERENCE, type ThemePreference } from '@tripmate/core';
import { loadThemePreference, resolveScheme, saveThemePreference, type Scheme, type SimpleStore } from './scheme';
import { darkColors, lightColors, type ColorTokens } from './tokens';

interface ThemeContextValue {
  /** What the user chose: light, dark or system. */
  preference: ThemePreference;
  /** What is actually showing right now: light or dark. */
  scheme: Scheme;
  colors: ColorTokens;
  /** Changes the theme immediately and remembers it on this device. */
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children, store = AsyncStorage }: { children: ReactNode; store?: SimpleStore }) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const [ready, setReady] = useState(false);

  // Read the saved choice once at start-up.
  useEffect(() => {
    let alive = true;
    void loadThemePreference(store).then((saved) => {
      if (!alive) return;
      setPreferenceState(saved);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [store]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next);
      void saveThemePreference(store, next);
    },
    [store],
  );

  const scheme = resolveScheme(preference, systemScheme);
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const value = useMemo(() => ({ preference, scheme, colors, setPreference }), [preference, scheme, colors, setPreference]);

  // Wait for the saved choice before drawing anything, so a Dark-mode user never sees a flash of Light.
  if (!ready) return <View style={[StyleSheet.absoluteFill, { backgroundColor: lightColors.background }]} />;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
