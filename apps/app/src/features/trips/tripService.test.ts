import { describe, expect, it } from 'vitest';
import type { TripListRow, TripRow } from '@tripmate/core';
import { TripError, createTrip, listTrips, type TripsClient } from './tripService';

const row: TripRow = {
  id: 't1',
  name: 'Goa Trip 2026',
  destination: 'Goa, India',
  start_date: '2026-12-27',
  end_date: '2026-12-30',
  description: null,
  budget_minor: 6000000,
  currency: 'INR',
  cover_image_path: null,
  status: 'active',
  created_by: 'u1',
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
  version: 1,
};

type Reply<T> = { data: T | null; error: { code?: string; message?: string } | null };

/** A fake that records every call so tests can check exactly what was asked of the database. */
function fakeClient(opts: { list?: Reply<TripListRow[]> | (() => Promise<Reply<TripListRow[]>>); create?: Reply<TripRow> | (() => Promise<Reply<TripRow>>) }) {
  const calls: { op: string; args?: unknown }[] = [];
  const run = <T>(r: Reply<T> | (() => Promise<Reply<T>>) | undefined): Promise<Reply<T>> =>
    typeof r === 'function' ? r() : Promise.resolve(r ?? { data: null, error: null });
  const client: TripsClient = {
    from: (table) => ({
      select: (columns) => ({
        order: (column, options) => {
          calls.push({ op: 'select', args: { table, columns, column, options } });
          return run(opts.list);
        },
      }),
    }),
    rpc: (fn, args) => {
      calls.push({ op: 'rpc', args: { fn, args } });
      return run(opts.create);
    },
  };
  return { client, calls };
}

const goodForm = {
  name: ' Goa Trip 2026 ',
  destination: 'Goa, India',
  startDate: '27/12/2026',
  endDate: '30/12/2026',
  description: '',
  budget: '60,000',
  currency: 'INR',
};

describe('listTrips', () => {
  it('asks for trips with their members, newest first, and maps them', async () => {
    const { client, calls } = fakeClient({
      list: { data: [{ ...row, members: [{ id: 'm1', status: 'active' }, { id: 'm2', status: 'removed' }] }], error: null },
    });
    const trips = await listTrips(client);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ id: 't1', name: 'Goa Trip 2026', startDate: '2026-12-27', budgetMinor: 6000000, memberCount: 1 });
    expect(calls).toEqual([
      { op: 'select', args: { table: 'trips', columns: '*, members:trip_members(id, status)', column: 'start_date', options: { ascending: false } } },
    ]);
  });

  it('returns an empty list when the user has no trips', async () => {
    expect(await listTrips(fakeClient({ list: { data: [], error: null } }).client)).toEqual([]);
    expect(await listTrips(fakeClient({ list: { data: null, error: null } }).client)).toEqual([]);
  });

  it('maps failures to friendly errors', async () => {
    await expect(listTrips(fakeClient({ list: { data: null, error: { message: 'Failed to fetch' } } }).client)).rejects.toMatchObject({ kind: 'network' });
    await expect(listTrips(fakeClient({ list: { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } } }).client)).rejects.toMatchObject({ kind: 'setup' });
    await expect(listTrips(fakeClient({ list: { data: null, error: { code: '42501' } } }).client)).rejects.toMatchObject({ kind: 'forbidden' });
    const unknown = await listTrips(fakeClient({ list: { data: null, error: { code: 'XX000', message: 'internal details 10.0.0.5' } } }).client).catch((e) => e);
    expect(unknown).toMatchObject({ kind: 'unknown', message: 'Something went wrong. Please try again.' });
  });

  it('turns a thrown network error into a TripError', async () => {
    const { client } = fakeClient({
      list: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(listTrips(client)).rejects.toMatchObject({ name: 'TripError', kind: 'network' });
  });
});

describe('createTrip', () => {
  it('validates, then calls create_trip with cleaned arguments and nothing else', async () => {
    const { client, calls } = fakeClient({ create: { data: row, error: null } });
    const trip = await createTrip(client, goodForm);
    expect(trip).toMatchObject({ id: 't1', name: 'Goa Trip 2026' });
    expect(calls).toEqual([
      {
        op: 'rpc',
        args: {
          fn: 'create_trip',
          args: {
            p_name: 'Goa Trip 2026',
            p_destination: 'Goa, India',
            p_start_date: '2026-12-27',
            p_end_date: '2026-12-30',
            p_description: null,
            p_budget_minor: 6000000, // Rs 60,000 as whole paise
            p_currency: 'INR',
          },
        },
      },
    ]);
  });

  it('cannot be used to choose the creator, id or status', async () => {
    const { client, calls } = fakeClient({ create: { data: row, error: null } });
    await createTrip(client, { ...goodForm, created_by: 'someone-else', id: 'x', status: 'archived' });
    const sent = Object.keys((calls[0]!.args as { args: object }).args).sort();
    expect(sent).toEqual(['p_budget_minor', 'p_currency', 'p_description', 'p_destination', 'p_end_date', 'p_name', 'p_start_date']);
  });

  it('rejects invalid input without calling the database, with per-field messages', async () => {
    const { client, calls } = fakeClient({ create: { data: row, error: null } });
    const err = await createTrip(client, { ...goodForm, name: '', endDate: '26/12/2026', budget: 'abc' }).catch((e) => e);
    expect(err).toBeInstanceOf(TripError);
    expect(err.kind).toBe('invalid');
    expect(Object.keys(err.fieldErrors).sort()).toEqual(['budget', 'endDate', 'name']);
    expect(calls).toHaveLength(0);
  });

  it('maps a database rule violation to the right field', async () => {
    const { client } = fakeClient({
      create: { data: null, error: { code: '23514', message: 'new row for relation "trips" violates check constraint "trips_dates_order"' } },
    });
    const err = await createTrip(client, goodForm).catch((e) => e);
    expect(err).toMatchObject({ kind: 'invalid', fieldErrors: { endDate: 'The end date must be on or after the start date' } });
    expect(err.message).not.toContain('constraint');
  });

  it('gives a clear message when the database update has not been applied yet', async () => {
    for (const code of ['PGRST202', '42883']) {
      const { client } = fakeClient({ create: { data: null, error: { code, message: 'Could not find the function public.create_trip' } } });
      const err = await createTrip(client, goodForm).catch((e) => e);
      expect(err).toMatchObject({ kind: 'setup' });
      expect(err.message).toMatch(/database update/);
    }
  });

  it('explains sign-in and profile problems', async () => {
    const auth = fakeClient({ create: { data: null, error: { code: '28000', message: 'not_authenticated' } } });
    await expect(createTrip(auth.client, goodForm)).rejects.toMatchObject({ kind: 'auth' });
    const profile = fakeClient({ create: { data: null, error: { code: 'P0001', message: 'profile_missing' } } });
    await expect(createTrip(profile.client, goodForm)).rejects.toMatchObject({ kind: 'profile' });
  });

  it('maps network failures, thrown or returned', async () => {
    const returned = fakeClient({ create: { data: null, error: { message: 'Failed to fetch' } } });
    await expect(createTrip(returned.client, goodForm)).rejects.toMatchObject({ kind: 'network' });
    const thrown = fakeClient({
      create: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(createTrip(thrown.client, goodForm)).rejects.toMatchObject({ kind: 'network' });
  });

  it('never shows raw database text for unexpected errors', async () => {
    const { client } = fakeClient({ create: { data: null, error: { code: 'XX000', message: 'SELECT secret FROM somewhere' } } });
    const err = await createTrip(client, goodForm).catch((e) => e);
    expect(err.message).toBe('Something went wrong. Please try again.');
  });

  it('treats an empty reply as a failure', async () => {
    const { client } = fakeClient({ create: { data: null, error: null } });
    await expect(createTrip(client, goodForm)).rejects.toMatchObject({ kind: 'unknown' });
  });
});
