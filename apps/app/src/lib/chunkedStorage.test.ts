import { describe, expect, it } from 'vitest';
import { createChunkedStorage, type KeyValueStore } from './chunkedStorage';

function memoryBackend() {
  const data = new Map<string, string>();
  const backend: KeyValueStore = {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
  return { data, backend };
}

describe('createChunkedStorage', () => {
  it('stores and returns a short value', async () => {
    const { backend } = memoryBackend();
    const s = createChunkedStorage(backend, 10);
    await s.setItem('k', 'hello');
    expect(await s.getItem('k')).toBe('hello');
  });

  it('splits a long value into pieces no larger than the chunk size and reassembles it exactly', async () => {
    const { backend, data } = memoryBackend();
    const s = createChunkedStorage(backend, 10);
    const value = 'abcdefghij'.repeat(7) + 'xyz'; // 73 chars -> 8 chunks
    await s.setItem('session', value);
    expect(await s.getItem('session')).toBe(value);
    expect(data.get('session.count')).toBe('8');
    for (const [k, v] of data) if (k !== 'session.count') expect(v.length).toBeLessThanOrEqual(10);
  });

  it('round-trips real-looking session JSON with unicode', async () => {
    const { backend } = memoryBackend();
    const s = createChunkedStorage(backend);
    const session = JSON.stringify({ access_token: 'eyJ'.repeat(900), refresh_token: 'r'.repeat(40), user: { name: 'आशा राव 🌴' } });
    await s.setItem('sb-auth-token', session);
    expect(await s.getItem('sb-auth-token')).toBe(session);
  });

  it('returns null when nothing is stored', async () => {
    const { backend } = memoryBackend();
    expect(await createChunkedStorage(backend).getItem('missing')).toBeNull();
  });

  it('replaces an older, longer value without leaving old pieces behind', async () => {
    const { backend, data } = memoryBackend();
    const s = createChunkedStorage(backend, 5);
    await s.setItem('k', 'a'.repeat(50)); // 10 chunks
    await s.setItem('k', 'short'); // 1 chunk
    expect(await s.getItem('k')).toBe('short');
    expect([...data.keys()].sort()).toEqual(['k.0', 'k.count']);
  });

  it('removes every piece', async () => {
    const { backend, data } = memoryBackend();
    const s = createChunkedStorage(backend, 5);
    await s.setItem('k', 'a'.repeat(23));
    await s.removeItem('k');
    expect(data.size).toBe(0);
    expect(await s.getItem('k')).toBeNull();
  });

  it('treats a value with a missing piece as absent instead of returning a damaged session', async () => {
    const { backend, data } = memoryBackend();
    const s = createChunkedStorage(backend, 5);
    await s.setItem('k', 'a'.repeat(23));
    data.delete('k.2');
    expect(await s.getItem('k')).toBeNull();
  });

  it('treats a half-finished write (no count yet) as absent', async () => {
    const { backend, data } = memoryBackend();
    const s = createChunkedStorage(backend, 5);
    data.set('k.0', 'aaaaa'); // pieces exist but the count was never written
    expect(await s.getItem('k')).toBeNull();
  });

  it('ignores a corrupt count', async () => {
    const { backend, data } = memoryBackend();
    const s = createChunkedStorage(backend, 5);
    for (const bad of ['abc', '-1', '1.5', '999999']) {
      data.set('k.count', bad);
      expect(await s.getItem('k')).toBeNull();
    }
  });

  it('keeps different keys separate', async () => {
    const { backend } = memoryBackend();
    const s = createChunkedStorage(backend, 4);
    await s.setItem('a', '1111111111');
    await s.setItem('b', '2222');
    await s.removeItem('a');
    expect(await s.getItem('b')).toBe('2222');
  });
});
