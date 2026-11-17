/**
 * Stores long values in small pieces.
 *
 * Why: phones' secure storage (iOS Keychain / Android Keystore, through
 * expo-secure-store) works best with values under about 2 KB, but a login
 * session (access token + refresh token + user info) can be larger. So we cut
 * the session into chunks of CHUNK_SIZE characters, store each chunk under
 * "<key>.0", "<key>.1", ... and remember how many there are under
 * "<key>.count". Reading puts the pieces back together; if any piece is
 * missing the value is treated as absent (the user simply signs in again)
 * instead of returning a damaged session.
 */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const CHUNK_SIZE = 1800;

export function createChunkedStorage(backend: KeyValueStore, chunkSize = CHUNK_SIZE): KeyValueStore {
  const countKey = (key: string) => `${key}.count`;
  const chunkKey = (key: string, i: number) => `${key}.${i}`;

  async function readCount(key: string): Promise<number | null> {
    const raw = await backend.getItem(countKey(key));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : null;
  }

  async function removeItem(key: string): Promise<void> {
    const count = await readCount(key);
    if (count !== null) {
      for (let i = 0; i < count; i++) await backend.removeItem(chunkKey(key, i));
    }
    await backend.removeItem(countKey(key));
  }

  return {
    async getItem(key) {
      const count = await readCount(key);
      if (count === null) return null;
      let value = '';
      for (let i = 0; i < count; i++) {
        const part = await backend.getItem(chunkKey(key, i));
        if (part === null) return null; // a piece is missing: do not return a half-session
        value += part;
      }
      return value;
    },

    async setItem(key, value) {
      await removeItem(key); // clear any older, possibly longer, value first
      const chunks: string[] = [];
      for (let i = 0; i < value.length; i += chunkSize) chunks.push(value.slice(i, i + chunkSize));
      for (let i = 0; i < chunks.length; i++) await backend.setItem(chunkKey(key, i), chunks[i]!);
      await backend.setItem(countKey(key), String(chunks.length)); // written last: a half-finished write reads as "absent"
    },

    removeItem,
  };
}
