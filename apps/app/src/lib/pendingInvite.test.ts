import { describe, expect, it } from 'vitest';
import { PENDING_INVITE_MAX_AGE_MS, createPendingInvite, type PendingStorage } from './pendingInvite';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function memoryStorage(): PendingStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
const brokenStorage: PendingStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
};

describe('remembering an invitation across sign-in', () => {
  it('remembers a token and gives it back, then forgets it when cleared', () => {
    const p = createPendingInvite(memoryStorage());
    expect(p.peek()).toBeNull();
    p.remember(TOKEN);
    expect(p.peek()).toBe(TOKEN);
    expect(p.peek()).toBe(TOKEN); // peeking does not use it up
    p.clear();
    expect(p.peek()).toBeNull();
  });

  it('only ever stores a well-formed token', () => {
    const storage = memoryStorage();
    const p = createPendingInvite(storage);
    for (const bad of ['', 'abc', TOKEN.toUpperCase(), `${TOKEN}0`, "' or 1=1 --", null, undefined, 5, {}]) p.remember(bad);
    expect(storage.data.size).toBe(0);
    expect(p.peek()).toBeNull();
  });

  it('expires after an hour and is then cleared from storage', () => {
    let clock = 1_000_000;
    const storage = memoryStorage();
    const p = createPendingInvite(storage, () => clock);
    p.remember(TOKEN);
    clock += PENDING_INVITE_MAX_AGE_MS - 1;
    expect(p.peek()).toBe(TOKEN);
    clock += 2;
    expect(p.peek()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('ignores damaged or tampered stored values', () => {
    const storage = memoryStorage();
    const p = createPendingInvite(storage);
    for (const raw of ['not json', '{}', '{"token":5,"at":1}', JSON.stringify({ token: 'short', at: Date.now() }), JSON.stringify({ token: TOKEN, at: Date.now() + 10 * 60 * 60 * 1000 })]) {
      storage.data.set('tripmate.pending-invite', raw);
      expect(p.peek(), raw).toBeNull();
    }
  });

  it('falls back to memory when storage is blocked, and never throws', () => {
    const p = createPendingInvite(brokenStorage);
    expect(() => p.remember(TOKEN)).not.toThrow();
    expect(p.peek()).toBe(TOKEN);
    expect(() => p.clear()).not.toThrow();
    expect(p.peek()).toBeNull();
  });

  it('works with no storage at all', () => {
    const p = createPendingInvite(null);
    p.remember(TOKEN);
    expect(p.peek()).toBe(TOKEN);
    p.clear();
    expect(p.peek()).toBeNull();
  });
});
