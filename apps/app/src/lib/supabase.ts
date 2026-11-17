import 'react-native-url-polyfill/auto'; // makes web-address handling complete on phones
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';
import { publicEnv } from './env';
import { sessionStorage } from './sessionStorage';
import { readSupabaseConfig } from './supabaseConfig';

/**
 * The one Supabase client for the whole app. It uses the PUBLISHABLE key only.
 * If the settings are missing or unsafe (for example a secret key), no client
 * is created and the app shows a clear setup screen instead.
 */
const config = readSupabaseConfig(publicEnv);

export const supabaseConfigError: string | null = config.ok ? null : config.message;

export const supabase: SupabaseClient | null = config.ok
  ? createClient(config.url, config.key, {
      auth: {
        storage: sessionStorage,
        persistSession: true, // stay signed in after closing the app
        autoRefreshToken: true, // quietly renew the short-lived access token
        detectSessionInUrl: Platform.OS === 'web', // lets the website finish the "confirm your email" link
      },
    })
  : null;

// On phones, background apps cannot refresh tokens reliably: pause while hidden, resume when shown.
if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
}
