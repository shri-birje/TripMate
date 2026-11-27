import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, useColorScheme, View } from 'react-native';
import { DEFAULT_SCHEME, loadDeviceScheme, normalizeScheme, saveDeviceScheme, type Scheme, type SimpleStore } from './scheme';
import { darkColors, lightColors, type ColorTokens } from './tokens';

interface ThemeContextValue {
  /** What is showing right now: light or dark. (There is no third "system" option.) */
  scheme: Scheme;
  /** Same as `scheme`; kept so controls can read "what is selected". */
  preference: Scheme;
  colors: ColorTokens;
  /** An explicit choice: changes the theme immediately and remembers it on this device. */
  setPreference: (scheme: Scheme) => void;
  /**
   * The account's saved value arrived (after sign-in). It is used only if this device has no choice of its own, and then it is
   * remembered on the device so it stays put. Never writes to the account.
   */
  adoptAccountTheme: (value: unknown) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children, store = AsyncStorage }: { children: ReactNode; store?: SimpleStore }) {
  const systemScheme = useColorScheme();
  const [scheme, setScheme] = useState<Scheme>(DEFAULT_SCHEME);
  const [ready, setReady] = useState(false);
  // Whether this device has a choice of its own (saved earlier, or made in this session). A ref: it never needs to redraw anything.
  const deviceChoice = useRef(false);
  const systemRef = useRef(systemScheme);
  systemRef.current = systemScheme;

  // Read the saved choice once at start-up. A legacy "system" value becomes Light or Dark here and is saved back as such.
  useEffect(() => {
    let alive = true;
    void loadDeviceScheme(store, systemRef.current).then((saved) => {
      if (!alive) return;
      if (saved) {
        deviceChoice.current = true;
        setScheme(saved);
        void saveDeviceScheme(store, saved);
      }
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [store]);

  const setPreference = useCallback(
    (next: Scheme) => {
      deviceChoice.current = true;
      setScheme(next);
      void saveDeviceScheme(store, next);
    },
    [store],
  );

  const adoptAccountTheme = useCallback(
    (value: unknown) => {
      if (deviceChoice.current) return; // this device's explicit choice takes precedence
      const next = normalizeScheme(value, systemRef.current);
      if (!next) return;
      deviceChoice.current = true; // once established it is kept through sign-out and refresh
      setScheme(next);
      void saveDeviceScheme(store, next);
    },
    [store],
  );

  const colors = scheme === 'dark' ? darkColors : lightColors;
  const value = useMemo(
    () => ({ preference: scheme, scheme, colors, setPreference, adoptAccountTheme }),
    [scheme, colors, setPreference, adoptAccountTheme],
  );

  // Wait for the saved choice before drawing anything, so a Dark-mode user never sees a flash of Light.
  if (!ready) return <View style={[StyleSheet.absoluteFill, { backgroundColor: lightColors.background }]} />;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
