import { describe, expect, it } from 'vitest';
import type { TripFormValues, TripRow } from '@tripmate/core';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';
import {
  ARCHIVED_MESSAGE,
  CONFLICT_MESSAGE,
  NOT_ADMIN_MESSAGE,
  TripEditError,
  setTripArchived,
  updateTrip,
  type TripEditClient,
} from './tripEditService';

const TRIP = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const row: TripRow = {
  id: TRIP, name: 'Goa Trip 2026', destination: 'Goa, India', start_date: '2026-12-27', end_date: '2026-12-30',
  description: null, budget_minor: 6000000, currency: 'INR', cover_image_path: null, status: 'active',
  created_by: 'u1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', version: 4,
};

type Reply = { data: TripRow | null; error: { code?: string; message?: string } | null };

/** A fake that records every call so tests can check exactly what was asked of the database. */
function fakeClient(reply: Reply | (() => Promise<Reply>)) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client: TripEditClient = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      return typeof reply === 'function' ? reply() : Promise.resolve(reply);
    },
  };
  return { client, calls };
}

const form: TripFormValues = {
  name: ' Goa Trip (edited) ', destination: 'North Goa', startDate: '28/12/2026', endDate: '31/12/2026', description: '', budget: '70,000',
};
const edit = (over: Partial<Parameters<typeof updateTrip>[1]> = {}) => ({ tripId: TRIP, expectedVersion: 3, currency: 'INR', form, ...over });

async function failure(fn: () => Promise<unknown>): Promise<TripEditError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof TripEditError) return e;
    throw e;
  }
  throw new Error('expected a TripEditError but the call succeeded');
}

describe('updateTrip: the request', () => {
  it('sends the approved arguments only, cleaned, with the version the person started from', async () => {
    const { client, calls } = fakeClient({ data: row, error: null });
    await updateTrip(client, edit());
    expect(calls).toEqual([
      {
        fn: 'update_trip',
        args: {
          p_trip_id: TRIP, p_expected_version: 3, p_name: 'Goa Trip (edited)', p_destination: 'North Goa',
          p_start_date: '2026-12-28', p_end_date: '2026-12-31', p_description: null, p_budget_minor: 7_000_000,
        },
      },
    ]);
  });

  it('never sends currency, status, creator or id (they cannot be changed)', async () => {
    const { client, calls } = fakeClient({ data: row, error: null });
    await updateTrip(client, edit({ currency: 'USD', form: { ...form, currency: 'EUR', status: 'archived', created_by: 'x' } as unknown as TripFormValues }));
    const keys = Object.keys(calls[0]!.args);
    expect(keys.join(',')).not.toMatch(/currency|status|created_by/);
    expect(keys.sort()).toEqual(['p_budget_minor', 'p_description', 'p_destination', 'p_end_date', 'p_expected_version', 'p_name', 'p_start_date', 'p_trip_id']);
  });

  it('returns the updated trip, including its new version', async () => {
    const { client } = fakeClient({ data: { ...row, name: 'Goa Trip (edited)', version: 5 }, error: null });
    expect(await updateTrip(client, edit())).toMatchObject({ name: 'Goa Trip (edited)', version: 5 });
  });

  it('can clear the budget and description (sent as nothing)', async () => {
    const { client, calls } = fakeClient({ data: row, error: null });
    await updateTrip(client, edit({ form: { ...form, budget: '', description: '' } }));
    expect(calls[0]!.args).toMatchObject({ p_budget_minor: null, p_description: null });
  });
});

describe('updateTrip: checks before contacting the server', () => {
  it('invalid input is refused with per-field messages, and the server is not contacted', async () => {
    const { client, calls } = fakeClient({ data: row, error: null });
    const e = await failure(() => updateTrip(client, edit({ form: { ...form, name: '', endDate: '26/12/2026', budget: 'abc' } })));
    expect(e.kind).toBe('invalid');
    expect(Object.keys(e.fieldErrors ?? {}).sort()).toEqual(['budget', 'endDate', 'name']);
    expect(calls).toHaveLength(0);
  });

  it.each(['', 'not-a-uuid', 'new', '../x'])('a malformed trip id (%j) gives the combined "not available" answer without contacting the server', async (id) => {
    const { client, calls } = fakeClient({ data: row, error: null });
    const e = await failure(() => updateTrip(client, edit({ tripId: id })));
    expect(e).toMatchObject({ kind: 'unavailable', message: UNAVAILABLE_MESSAGE });
    expect(calls).toHaveLength(0);
  });

  it.each([0, -1, 1.5, NaN, undefined as unknown as number, '3' as unknown as number])('a bad version (%s) is never sent', async (v) => {
    const { client, calls } = fakeClient({ data: row, error: null });
    await failure(() => updateTrip(client, edit({ expectedVersion: v })));
    expect(calls).toHaveLength(0);
  });
});

describe('updateTrip: what the database can say, in plain words', () => {
  const run = (reply: Reply | (() => Promise<Reply>)) => failure(() => updateTrip(fakeClient(reply).client, edit()));
  const dbError = (message: string, code = 'P0001'): Reply => ({ data: null, error: { code, message } });

  it('someone else changed the trip first: a conflict, with Reload advice', async () => {
    expect(await run(dbError('version_conflict'))).toMatchObject({ kind: 'conflict', message: CONFLICT_MESSAGE });
  });
  it('not an administrator', async () => {
    expect(await run(dbError('not_admin'))).toMatchObject({ kind: 'not_admin', message: NOT_ADMIN_MESSAGE });
  });
  it('archived trip', async () => {
    expect(await run(dbError('trip_archived'))).toMatchObject({ kind: 'archived', message: ARCHIVED_MESSAGE });
  });
  it('not on the trip / no such trip: the SAME combined message as the details page', async () => {
    expect(await run(dbError('trip_not_found'))).toMatchObject({ kind: 'unavailable', message: UNAVAILABLE_MESSAGE });
  });
  it('signed out or expired login', async () => {
    expect(await run(dbError('not_authenticated', '28000'))).toMatchObject({ kind: 'auth' });
    expect(await run(dbError('permission denied for function update_trip', '42501'))).toMatchObject({ kind: 'auth' });
  });
  it('a database rule violation lands on the right field in plain words', async () => {
    const e = await run(dbError('new row for relation "trips" violates check constraint "trips_dates_order"', '23514'));
    expect(e).toMatchObject({ kind: 'invalid', fieldErrors: { endDate: 'The end date must be on or after the start date' } });
    expect(e.message).not.toContain('constraint');
  });
  it('a missing database update is explained', async () => {
    for (const code of ['PGRST202', '42883']) expect(await run(dbError('Could not find the function public.update_trip', code))).toMatchObject({ kind: 'setup' });
  });
  it('connection failures (returned or thrown) are separate so the screen can offer Try again', async () => {
    expect(await run(dbError('Failed to fetch', ''))).toMatchObject({ kind: 'network' });
    expect(await run(async () => { throw new TypeError('Failed to fetch'); })).toMatchObject({ kind: 'network' });
  });
  it('anything unexpected is generic and never shows raw database text', async () => {
    const e = await run(dbError('SELECT secret FROM somewhere at 10.0.0.5', 'XX000'));
    expect(e).toMatchObject({ kind: 'unknown', message: 'Something went wrong. Please try again.' });
  });
  it('an empty reply is a failure, not a success', async () => {
    expect(await run({ data: null, error: null })).toMatchObject({ kind: 'unknown' });
  });
});

describe('setTripArchived', () => {
  it('archive: sends exactly the trip, "true" and the version', async () => {
    const { client, calls } = fakeClient({ data: { ...row, status: 'archived', version: 5 }, error: null });
    const t = await setTripArchived(client, { tripId: TRIP, archived: true, expectedVersion: 4 });
    expect(calls).toEqual([{ fn: 'set_trip_archived', args: { p_trip_id: TRIP, p_archived: true, p_expected_version: 4 } }]);
    expect(t).toMatchObject({ status: 'archived', version: 5 });
  });

  it('restore: sends "false" and nothing else about the trip', async () => {
    const { client, calls } = fakeClient({ data: { ...row, status: 'active' }, error: null });
    await setTripArchived(client, { tripId: TRIP, archived: false, expectedVersion: 5 });
    expect(calls[0]!.args).toEqual({ p_trip_id: TRIP, p_archived: false, p_expected_version: 5 });
    expect(Object.keys(calls[0]!.args).join(',')).not.toMatch(/name|destination|date|budget|currency/);
  });

  it('refuses a malformed id, a bad version or a non-boolean without contacting the server', async () => {
    const { client, calls } = fakeClient({ data: row, error: null });
    await failure(() => setTripArchived(client, { tripId: 'nope', archived: true, expectedVersion: 1 }));
    await failure(() => setTripArchived(client, { tripId: TRIP, archived: true, expectedVersion: 0 }));
    await failure(() => setTripArchived(client, { tripId: TRIP, archived: 'yes' as unknown as boolean, expectedVersion: 1 }));
    expect(calls).toHaveLength(0);
  });

  it('maps the same database answers as editing', async () => {
    const cases: [string, string, string][] = [
      ['version_conflict', 'conflict', CONFLICT_MESSAGE], ['not_admin', 'not_admin', NOT_ADMIN_MESSAGE], ['trip_not_found', 'unavailable', UNAVAILABLE_MESSAGE],
    ];
    for (const [message, kind, text] of cases) {
      const e = await failure(() => setTripArchived(fakeClient({ data: null, error: { code: 'P0001', message } }).client, { tripId: TRIP, archived: true, expectedVersion: 1 }));
      expect(e).toMatchObject({ kind, message: text });
    }
  });

  it('connection failures are separate; unexpected errors are generic', async () => {
    const net = await failure(() => setTripArchived(fakeClient(async () => { throw new TypeError('Failed to fetch'); }).client, { tripId: TRIP, archived: true, expectedVersion: 1 }));
    expect(net.kind).toBe('network');
    const odd = await failure(() => setTripArchived(fakeClient({ data: null, error: { code: 'XX000', message: 'internal 10.0.0.5' } }).client, { tripId: TRIP, archived: true, expectedVersion: 1 }));
    expect(odd.message).toBe('Something went wrong. Please try again.');
  });
});
