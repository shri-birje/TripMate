import { isInviteToken } from '@tripmate/core';

/**
 * Remembers an invitation link across sign-in.
 *
 * A signed-out person who opens a link has to sign in or create an account first (and, for a new account, may
 * leave to confirm an email). This keeps the token for a short while so they can be brought back to the same
 * link afterwards. It is a secret, so it is kept ONLY as long as needed:
 *   - only a well-formed token is ever stored;
 *   - it expires after 1 hour;
 *   - it is cleared as soon as the link has been used or found invalid;
 *   - storage that is unavailable (private window, blocked) simply means it is remembered in memory instead.
 * It is never logged and never sent anywhere.
 */
const KEY = 'tripmate.pending-invite';
export const PENDING_INVITE_MAX_AGE_MS = 60 * 60 * 1000;

export interface PendingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserStorage(): PendingStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function createPendingInvite(storage: PendingStorage | null = browserStorage(), now: () => number = () => Date.now()) {
  let memory: { token: string; at: number } | null = null;

  const readStored = (): { token: string; at: number } | null => {
    if (!storage) return null;
    try {
      const raw = storage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { token?: unknown; at?: unknown };
      return typeof parsed.token === 'string' && typeof parsed.at === 'number' ? { token: parsed.token, at: parsed.at } : null;
    } catch {
      return null;
    }
  };

  const clear = () => {
    memory = null;
    try {
      storage?.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
  };

  return {
    /** Remembers a token (ignored unless it is well-formed). */
    remember(token: unknown) {
      if (!isInviteToken(token)) return;
      memory = { token, at: now() };
      try {
        storage?.setItem(KEY, JSON.stringify(memory));
      } catch {
        /* kept in memory only */
      }
    },
    /** The remembered token, or null if there is none, it is malformed, or it is older than an hour (then it is also cleared). */
    peek(): string | null {
      const entry = readStored() ?? memory;
      if (!entry) return null;
      if (!isInviteToken(entry.token) || now() - entry.at > PENDING_INVITE_MAX_AGE_MS || entry.at > now() + 60_000) {
        clear();
        return null;
      }
      return entry.token;
    },
    clear,
  };
}

export const pendingInvite = createPendingInvite();
