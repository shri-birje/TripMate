import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createChunkedStorage, type KeyValueStore } from './chunkedStorage';

/**
 * Where the login session is kept.
 *  - Phone: the operating system's secure storage (Keychain / Keystore),
 *    in small pieces (see chunkedStorage.ts).
 *  - Website: the browser's localStorage. Browsers offer nothing safer for
 *    this; that is why the website will also send strict security headers
 *    (see docs/SECURITY_ARCHITECTURE.md).
 */
const nativeBackend: KeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

const webBackend: KeyValueStore = {
  async getItem(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null; // storage blocked (e.g. private browsing): behave as signed out
    }
  },
  async setItem(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage blocked: the session just will not survive a reload */
    }
  },
  async removeItem(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  },
};

export const sessionStorage: KeyValueStore =
  Platform.OS === 'web' ? webBackend : createChunkedStorage(nativeBackend);
