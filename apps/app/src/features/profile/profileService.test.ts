import { describe, expect, it } from 'vitest';
import type { ProfileRow } from '@tripmate/core';
import { ProfileError, fetchProfile, updateProfileDetails, updateThemePreference, type ProfilesClient } from './profileService';

const row: ProfileRow = {
  id: 'user-1',
  display_name: 'Asha',
  upi_id: null,
  avatar_path: null,
  preferred_currency: 'INR',
  theme_preference: 'light',
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
};

type Reply = { data: ProfileRow | null; error: { code?: string; message?: string } | null };

/** A fake that records every query so tests can check exactly what was asked of the database. */
function fakeClient(reply: Reply | (() => Promise<Reply>)) {
  const log: { op: string; table?: string; columns?: string; values?: unknown; col?: string; val?: string }[] = [];
  const next = () => (typeof reply === 'function' ? reply() : Promise.resolve(reply));
  const client: ProfilesClient = {
    from: (table) => ({
      select: (columns) => ({
        eq: (col, val) => ({
          maybeSingle: () => {
            log.push({ op: 'select', table, columns, col, val });
            return next();
          },
        }),
      }),
      update: (values) => ({
        eq: (col, val) => ({
          select: () => ({
            maybeSingle: () => {
              log.push({ op: 'update', table, values, col, val });
              return next();
            },
          }),
        }),
      }),
    }),
  };
  return { client, log };
}

describe('fetchProfile', () => {
  it('asks only for this user\'s row and maps it', async () => {
    const { client, log } = fakeClient({ data: row, error: null });
    const p = await fetchProfile(client, 'user-1');
    expect(p).toMatchObject({ id: 'user-1', displayName: 'Asha', themePreference: 'light', preferredCurrency: 'INR' });
    expect(log).toEqual([{ op: 'select', table: 'profiles', columns: '*', col: 'id', val: 'user-1' }]);
  });

  it('reports a missing profile clearly', async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(fetchProfile(client, 'u')).rejects.toMatchObject({ name: 'ProfileError', kind: 'not_found' });
  });

  it('maps database and network errors to friendly kinds', async () => {
    await expect(fetchProfile(fakeClient({ data: null, error: { code: '42501' } }).client, 'u')).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(fetchProfile(fakeClient({ data: null, error: { message: 'Failed to fetch' } }).client, 'u')).rejects.toMatchObject({ kind: 'network' });
    await expect(fetchProfile(fakeClient({ data: null, error: { code: 'XX000', message: 'internal details here' } }).client, 'u')).rejects.toMatchObject({
      kind: 'unknown',
      message: 'Something went wrong. Please try again.',
    });
  });

  it('turns a thrown network error into a ProfileError', async () => {
    const { client } = fakeClient(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchProfile(client, 'u')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('updateProfileDetails', () => {
  const input = { displayName: '  Asha Rao ', upiId: '', preferredCurrency: 'USD' };

  it('sends only the editable form columns, cleaned', async () => {
    const { client, log } = fakeClient({ data: { ...row, display_name: 'Asha Rao', preferred_currency: 'USD' }, error: null });
    const p = await updateProfileDetails(client, 'user-1', input);
    expect(log[0]).toMatchObject({
      op: 'update',
      values: { display_name: 'Asha Rao', upi_id: null, preferred_currency: 'USD' },
      col: 'id',
      val: 'user-1',
    });
    expect(Object.keys(log[0]!.values as object).sort()).toEqual(['display_name', 'preferred_currency', 'upi_id']);
    expect(p.displayName).toBe('Asha Rao');
  });

  it('cannot be tricked into sending id, theme or other columns', async () => {
    const { client, log } = fakeClient({ data: row, error: null });
    await updateProfileDetails(client, 'user-1', { ...input, id: 'someone-else', created_at: 'x', themePreference: 'dark', deleted_at: 'x' });
    expect(Object.keys(log[0]!.values as object).sort()).toEqual(['display_name', 'preferred_currency', 'upi_id']);
  });

  it('rejects invalid input without touching the database, with per-field messages', async () => {
    const { client, log } = fakeClient({ data: row, error: null });
    const err = await updateProfileDetails(client, 'u', { displayName: '', upiId: 'nope', preferredCurrency: 'XYZ' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProfileError);
    expect(err.kind).toBe('invalid');
    expect(Object.keys(err.fieldErrors).sort()).toEqual(['displayName', 'preferredCurrency', 'upiId']);
    expect(log).toHaveLength(0);
  });

  it('reports "not found" when the database changed no row (not your profile, or none exists)', async () => {
    const { client } = fakeClient({ data: null, error: null });
    await expect(updateProfileDetails(client, 'u', input)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('maps a database rule violation to a friendly error', async () => {
    const { client } = fakeClient({ data: null, error: { code: '23514', message: 'violates check constraint "profiles_upi_id_format"' } });
    const err = await updateProfileDetails(client, 'u', input).catch((e) => e);
    expect(err.kind).toBe('invalid');
    expect(err.message).not.toContain('constraint');
  });
});

describe('updateThemePreference', () => {
  it.each(['light', 'dark', 'system'] as const)('saves %s and only that column', async (theme) => {
    const { client, log } = fakeClient({ data: { ...row, theme_preference: theme }, error: null });
    const p = await updateThemePreference(client, 'user-1', theme);
    expect(log[0]).toMatchObject({ op: 'update', values: { theme_preference: theme }, val: 'user-1' });
    expect(p.themePreference).toBe(theme);
  });

  it('rejects an unknown theme without calling the database', async () => {
    const { client, log } = fakeClient({ data: row, error: null });
    await expect(updateThemePreference(client, 'u', 'neon' as never)).rejects.toMatchObject({ kind: 'invalid' });
    expect(log).toHaveLength(0);
  });

  it('surfaces a failed save so the app can say "saved on this device only"', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'Failed to fetch' } });
    await expect(updateThemePreference(client, 'u', 'dark')).rejects.toMatchObject({ kind: 'network' });
  });
});
