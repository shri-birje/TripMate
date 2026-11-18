import { describe, expect, it } from 'vitest';
import type { TripDetailsRow, TripMemberRow } from '@tripmate/core';
import {
  TRIP_DETAILS_COLUMNS,
  TripDetailsError,
  UNAVAILABLE_MESSAGE,
  getTripDetails,
  type TripDetailsClient,
} from './tripDetailsService';

const TRIP_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const member = (id: string, over: Partial<TripMemberRow> = {}): TripMemberRow => ({
  id,
  user_id: `user-${id}`,
  display_name: `Person ${id}`,
  role: 'member',
  status: 'active',
  joined_at: '2026-11-18T10:00:00+00:00',
  ...over,
});

const row: TripDetailsRow = {
  id: TRIP_ID,
  name: 'Goa Trip 2026',
  destination: 'Goa, India',
  start_date: '2026-12-27',
  end_date: '2026-12-30',
  description: 'Beach and food',
  budget_minor: 6000000,
  currency: 'INR',
  cover_image_path: null,
  status: 'active',
  created_by: 'user-1',
  created_at: '2026-11-18T00:00:00Z',
  updated_at: '2026-11-18T00:00:00Z',
  version: 1,
  trip_members: [member('1', { role: 'admin', display_name: 'Asha Rao' }), member('2', { display_name: 'Ravi' })],
};

type Reply = { data: TripDetailsRow | null; error: { code?: string; message?: string } | null };

/** A fake that records the exact query so tests can check precisely what was asked of the database. */
function fakeClient(reply: Reply | (() => Promise<Reply>)) {
  const queries: { table: string; columns: string; filters: [string, string][] }[] = [];
  const client: TripDetailsClient = {
    from: (table) => ({
      select: (columns) => {
        const q = { table, columns, filters: [] as [string, string][] };
        queries.push(q);
        const builder = {
          eq(column: string, value: string) {
            q.filters.push([column, value]);
            return builder;
          },
          maybeSingle: () => (typeof reply === 'function' ? reply() : Promise.resolve(reply)),
        };
        return builder;
      },
    }),
  };
  return { client, queries };
}

describe('getTripDetails: the request', () => {
  it('asks for one trip by id and only its CURRENT members, with an explicit column list', async () => {
    const { client, queries } = fakeClient({ data: row, error: null });
    await getTripDetails(client, TRIP_ID);
    expect(queries).toHaveLength(1);
    expect(queries[0]!.table).toBe('trips');
    expect(queries[0]!.columns).toBe(TRIP_DETAILS_COLUMNS);
    expect(queries[0]!.filters).toEqual([
      ['id', TRIP_ID],
      ['trip_members.status', 'active'],
    ]);
  });

  it('never asks for everything, for other tables, or for private profile data', () => {
    expect(TRIP_DETAILS_COLUMNS).not.toContain('*');
    for (const forbidden of ['email', 'upi', 'profiles', 'password', 'phone', 'auth.users']) {
      expect(TRIP_DETAILS_COLUMNS.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('asks only for the member columns the screen shows (name, role, status, join date, ids)', () => {
    const memberPart = /trip_members\(([^)]*)\)/.exec(TRIP_DETAILS_COLUMNS)![1]!.split(',').map((s) => s.trim());
    expect(memberPart).toEqual(['id', 'user_id', 'display_name', 'role', 'status', 'joined_at']);
  });
});

describe('getTripDetails: the result', () => {
  it('returns the trip, current members (admins first), the creator and the length', async () => {
    const d = await getTripDetails(fakeClient({ data: row, error: null }).client, TRIP_ID);
    expect(d.trip).toMatchObject({ id: TRIP_ID, name: 'Goa Trip 2026', budgetMinor: 6000000, memberCount: 2 });
    expect(d.members.map((m) => m.displayName)).toEqual(['Asha Rao', 'Ravi']);
    expect(d.creatorName).toBe('Asha Rao');
    expect(d.lengthDays).toBe(4);
  });

  it('never shows former members, even if the server wrongly sent them', async () => {
    const withFormer: TripDetailsRow = {
      ...row,
      trip_members: [...row.trip_members!, member('3', { display_name: 'Removed Rahul', status: 'removed' }), member('4', { display_name: 'Departed Dev', status: 'left' })],
    };
    const d = await getTripDetails(fakeClient({ data: withFormer, error: null }).client, TRIP_ID);
    expect(d.members.map((m) => m.displayName)).toEqual(['Asha Rao', 'Ravi']);
    expect(JSON.stringify(d)).not.toMatch(/Rahul|Dev/);
  });
});

describe('getTripDetails: unavailable trips all look identical', () => {
  const kinds = async (fn: () => Promise<unknown>) => (await fn().catch((e) => e)) as TripDetailsError;

  it('a trip the database hides (unknown, not yours, removed, left) gives the combined message', async () => {
    const e = await kinds(() => getTripDetails(fakeClient({ data: null, error: null }).client, TRIP_ID));
    expect(e).toBeInstanceOf(TripDetailsError);
    expect(e.kind).toBe('unavailable');
    expect(e.message).toBe(UNAVAILABLE_MESSAGE);
  });

  it.each([undefined, null, '', 'new', 'abc', '123', "x'; drop table trips;--", '../x', 42, {}, [TRIP_ID]])(
    'a malformed link (%j) gives the SAME error and never contacts the server',
    async (bad) => {
      const { client, queries } = fakeClient({ data: row, error: null });
      const e = await kinds(() => getTripDetails(client, bad));
      expect(e.kind).toBe('unavailable');
      expect(e.message).toBe(UNAVAILABLE_MESSAGE);
      expect(queries).toHaveLength(0);
    },
  );

  it('an "invalid uuid" answer from the database is also the same combined error', async () => {
    const e = await kinds(() => getTripDetails(fakeClient({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } }).client, TRIP_ID));
    expect(e.kind).toBe('unavailable');
    expect(e.message).toBe(UNAVAILABLE_MESSAGE);
  });

  it('the message does not hint at whether the trip exists', () => {
    expect(UNAVAILABLE_MESSAGE).not.toMatch(/denied|forbidden|not found|doesn't exist|does not exist|private|permission/i);
  });
});

describe('getTripDetails: real problems', () => {
  /** Runs the call and returns the error it throws; fails the test if it unexpectedly succeeds. */
  const run = async (reply: Reply | (() => Promise<Reply>)): Promise<TripDetailsError> => {
    try {
      await getTripDetails(fakeClient(reply).client, TRIP_ID);
    } catch (e) {
      if (e instanceof TripDetailsError) return e;
      throw e;
    }
    throw new Error('expected getTripDetails to fail, but it succeeded');
  };

  it('a connection failure is separate, so the screen can offer Try again', async () => {
    expect(await run({ data: null, error: { message: 'Failed to fetch' } })).toMatchObject({ kind: 'network' });
    expect(
      await run(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toMatchObject({ kind: 'network' });
  });

  it('a missing table is reported as a setup problem', async () => {
    for (const code of ['PGRST205', '42P01']) expect(await run({ data: null, error: { code, message: 'x' } })).toMatchObject({ kind: 'setup' });
  });

  it('anything unexpected becomes a generic message and never shows raw database text', async () => {
    const e = await run({ data: null, error: { code: 'XX000', message: 'SELECT * FROM secrets at 10.0.0.5' } });
    expect(e.kind).toBe('unknown');
    expect(e.message).toBe('Something went wrong. Please try again.');
  });

  it('a permission error is NOT shown as "access denied" (it would reveal the trip exists)', async () => {
    const e = await run({ data: null, error: { code: '42501', message: 'permission denied for table trips' } });
    expect(e.kind).toBe('unknown');
    expect(e.message).not.toMatch(/permission|denied/i);
  });
});
