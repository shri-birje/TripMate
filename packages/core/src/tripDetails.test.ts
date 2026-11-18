import { afterEach, describe, expect, it } from 'vitest';
import {
  calendarDayNumber,
  daysLabel,
  isValidTripId,
  memberFromRow,
  sortMembers,
  tripDetailsFromRow,
  tripLengthDays,
  type TripDetailsRow,
  type TripMemberRow,
} from './tripDetails';
import { tripPhase } from './trip';

describe('isValidTripId', () => {
  it('accepts ordinary ids in any letter case', () => {
    expect(isValidTripId('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
    expect(isValidTripId('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toBe(true);
  });
  it.each([
    '', ' ', 'new', 'null', 'undefined', '123', '3f2504e0-4f89-11d3-9a0c-0305e82c330', '3f2504e0-4f89-11d3-9a0c-0305e82c33011',
    '3f2504e04f8911d39a0c0305e82c3301', '{3f2504e0-4f89-11d3-9a0c-0305e82c3301}', '3f2504e0-4f89-11d3-9a0c-0305e82c330g',
    "1'; drop table trips;--", '../../etc/passwd', ' 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  ])('rejects %j', (v) => {
    expect(isValidTripId(v)).toBe(false);
  });
  it('rejects non-text input', () => {
    for (const v of [undefined, null, 5, {}, [], ['3f2504e0-4f89-11d3-9a0c-0305e82c3301']]) expect(isValidTripId(v)).toBe(false);
  });
});

describe('calendarDayNumber', () => {
  it('counts whole days since 1970-01-01', () => {
    expect(calendarDayNumber('1970-01-01')).toBe(0);
    expect(calendarDayNumber('1970-01-02')).toBe(1);
    expect(calendarDayNumber('2000-01-01')).toBe(10957);
  });
  it('rejects anything that is not a real calendar day', () => {
    for (const bad of ['', 'x', '2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-12-32', '27/12/2026', '2026-1-5', ' 2026-12-27']) {
      expect(calendarDayNumber(bad)).toBeNull();
    }
    expect(calendarDayNumber('2028-02-29')).not.toBeNull(); // leap day
  });
});

describe('tripLengthDays (inclusive calendar days)', () => {
  it.each([
    ['2026-12-27', '2026-12-27', 1], // starts and ends the same day
    ['2026-12-27', '2026-12-28', 2],
    ['2026-12-27', '2026-12-30', 4], // the Goa example
    ['2026-12-30', '2027-01-02', 4], // across a new year
    ['2026-02-27', '2026-03-02', 4], // across a month end (28-day February)
    ['2028-02-27', '2028-03-02', 5], // across a month end in a leap year (29 February exists)
    ['2028-02-29', '2028-02-29', 1], // the leap day itself
    ['2026-01-01', '2026-12-31', 365],
    ['2028-01-01', '2028-12-31', 366],
    ['2026-03-28', '2026-03-30', 3], // across a European daylight-saving change
    ['2026-03-07', '2026-03-09', 3], // across a US daylight-saving change
    ['2026-10-24', '2026-10-26', 3], // across the end of European daylight saving
    ['2026-10-31', '2026-11-02', 3], // across the end of US daylight saving
  ])('%s to %s is %d days', (start, end, days) => {
    expect(tripLengthDays(start, end)).toBe(days);
  });

  it('is null for unreadable dates or an end before the start', () => {
    expect(tripLengthDays('2026-12-30', '2026-12-27')).toBeNull();
    expect(tripLengthDays('soon', '2026-12-27')).toBeNull();
    expect(tripLengthDays('2026-12-27', '30/12/2026')).toBeNull();
    expect(tripLengthDays('2026-02-30', '2026-03-01')).toBeNull();
  });
});

describe('daysLabel', () => {
  it('uses singular and plural correctly', () => {
    expect(daysLabel(1)).toBe('1 day');
    expect(daysLabel(2)).toBe('2 days');
    expect(daysLabel(365)).toBe('365 days');
  });
});

/**
 * Time zones must not matter. Trip dates are plain calendar days, so changing the computer's
 * time zone (including zones 14 hours ahead and 11 hours behind UTC) must never move a day.
 */
describe('time-zone independence', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata', 'America/Los_Angeles', 'Europe/London', 'UTC'];

  it('really switches the zone in this test environment (so the checks below mean something)', () => {
    process.env.TZ = 'Pacific/Kiritimati';
    const ahead = new Date(2026, 5, 1).getTimezoneOffset();
    process.env.TZ = 'Pacific/Pago_Pago';
    const behind = new Date(2026, 5, 1).getTimezoneOffset();
    expect(ahead).toBe(-840); // UTC+14
    expect(behind).toBe(660); // UTC-11
  });

  it.each(ZONES)('lengths and phases are identical in %s', (zone) => {
    process.env.TZ = zone;
    expect(tripLengthDays('2026-12-27', '2026-12-30')).toBe(4);
    expect(tripLengthDays('2026-03-28', '2026-03-30')).toBe(3);
    expect(tripLengthDays('2028-02-28', '2028-03-01')).toBe(3);
    expect(calendarDayNumber('2026-12-27')).toBe(20814);
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-27')).toBe('ongoing');
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-30')).toBe('ongoing');
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-26')).toBe('upcoming');
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-31')).toBe('completed');
  });
});

describe('trip phase and length agree at the boundaries (calendar days)', () => {
  const start = '2026-12-27';
  const end = '2026-12-30';
  it('a trip that STARTS today is ongoing on its first day and has not been completed', () => {
    expect(tripPhase(start, end, start)).toBe('ongoing');
    expect(tripPhase(start, end, '2026-12-26')).toBe('upcoming'); // the day before
  });
  it('a trip that ENDS today is still ongoing today, and completed from tomorrow', () => {
    expect(tripPhase(start, end, end)).toBe('ongoing');
    expect(tripPhase(start, end, '2026-12-31')).toBe('completed');
  });
  it('a one-day trip is ongoing exactly on its day', () => {
    expect(tripPhase('2026-12-27', '2026-12-27', '2026-12-26')).toBe('upcoming');
    expect(tripPhase('2026-12-27', '2026-12-27', '2026-12-27')).toBe('ongoing');
    expect(tripPhase('2026-12-27', '2026-12-27', '2026-12-28')).toBe('completed');
    expect(tripLengthDays('2026-12-27', '2026-12-27')).toBe(1);
  });
  it('the number of "ongoing" days equals the trip length, for every kind of range', () => {
    const ranges: [string, string][] = [
      ['2026-12-27', '2026-12-27'], ['2026-12-27', '2026-12-30'], ['2026-12-30', '2027-01-02'],
      ['2028-02-27', '2028-03-02'], ['2026-03-28', '2026-03-30'], ['2026-10-31', '2026-11-02'],
    ];
    for (const [s, e] of ranges) {
      let ongoing = 0;
      for (let n = calendarDayNumber(s)! - 3; n <= calendarDayNumber(e)! + 3; n++) {
        const iso = new Date(n * 86_400_000).toISOString().slice(0, 10);
        if (tripPhase(s, e, iso) === 'ongoing') ongoing++;
      }
      expect(ongoing).toBe(tripLengthDays(s, e));
    }
  });
});

const row = (over: Partial<TripMemberRow> & { id: string }): TripMemberRow => ({
  user_id: `user-${over.id}`,
  display_name: `Person ${over.id}`,
  role: 'member',
  status: 'active',
  joined_at: '2026-11-18T10:00:00+00:00',
  ...over,
});

describe('memberFromRow', () => {
  it('maps fields and recognises guests', () => {
    expect(memberFromRow(row({ id: 'a', role: 'admin' }))).toEqual({
      id: 'a', userId: 'user-a', displayName: 'Person a', role: 'admin', status: 'active', joinedAt: '2026-11-18T10:00:00+00:00', isGuest: false,
    });
    expect(memberFromRow(row({ id: 'g', user_id: null })).isGuest).toBe(true);
  });
  it('treats unknown roles as plain members and unknown statuses as active', () => {
    expect(memberFromRow(row({ id: 'x', role: 'owner' })).role).toBe('member');
    expect(memberFromRow(row({ id: 'x', status: 'weird' })).status).toBe('active');
    expect(memberFromRow(row({ id: 'x', status: 'removed' })).status).toBe('removed');
    expect(memberFromRow(row({ id: 'x', status: 'left' })).status).toBe('left');
  });
});

describe('sortMembers', () => {
  it('puts administrators first, then people in join order, then by name', () => {
    const m = [
      row({ id: '1', display_name: 'Zed', joined_at: '2026-11-18T10:00:00+00:00' }),
      row({ id: '2', display_name: 'Amy', role: 'admin', joined_at: '2026-11-18T12:00:00+00:00' }),
      row({ id: '3', display_name: 'Bob', joined_at: '2026-11-18T09:00:00+00:00' }),
      row({ id: '4', display_name: 'Cat', joined_at: '2026-11-18T09:00:00+00:00' }),
    ].map(memberFromRow);
    expect(sortMembers(m).map((x) => x.displayName)).toEqual(['Amy', 'Bob', 'Cat', 'Zed']);
  });
  it('is deterministic whatever order it receives, and does not change the input', () => {
    const m = [row({ id: 'b' }), row({ id: 'a' }), row({ id: 'c', role: 'admin' })].map(memberFromRow);
    const copy = [...m];
    expect(sortMembers(m).map((x) => x.id)).toEqual(sortMembers([...m].reverse()).map((x) => x.id));
    expect(m).toEqual(copy);
  });
  it('copes with an unreadable join time', () => {
    expect(() => sortMembers([row({ id: 'a', joined_at: 'garbage' }), row({ id: 'b' })].map(memberFromRow))).not.toThrow();
  });
});

describe('tripDetailsFromRow', () => {
  const base: TripDetailsRow = {
    id: 't1', name: 'Goa Trip 2026', destination: 'Goa, India', start_date: '2026-12-27', end_date: '2026-12-30',
    description: 'Beach and food', budget_minor: 6000000, currency: 'INR', cover_image_path: null, status: 'active',
    created_by: 'user-1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', version: 1,
    trip_members: [
      row({ id: '2', display_name: 'Ravi', joined_at: '2026-11-18T11:00:00+00:00' }),
      row({ id: '1', display_name: 'Asha Rao', role: 'admin', joined_at: '2026-11-18T10:00:00+00:00' }),
    ],
  };

  it('builds the trip, the sorted people, the creator and the length', () => {
    const d = tripDetailsFromRow(base);
    expect(d.trip).toMatchObject({ id: 't1', name: 'Goa Trip 2026', budgetMinor: 6000000, memberCount: 2 });
    expect(d.members.map((m) => m.displayName)).toEqual(['Asha Rao', 'Ravi']);
    expect(d.admins.map((m) => m.displayName)).toEqual(['Asha Rao']);
    expect(d.creatorName).toBe('Asha Rao');
    expect(d.lengthDays).toBe(4);
  });

  it('shows only CURRENT members, even if the server sent former ones (their names must never appear)', () => {
    const d = tripDetailsFromRow({
      ...base,
      trip_members: [
        ...base.trip_members!,
        row({ id: '3', display_name: 'Removed Rahul', status: 'removed' }),
        row({ id: '4', display_name: 'Departed Dev', status: 'left' }),
      ],
    });
    expect(d.members.map((m) => m.displayName)).toEqual(['Asha Rao', 'Ravi']);
    expect(JSON.stringify(d)).not.toContain('Rahul');
    expect(JSON.stringify(d)).not.toContain('Dev');
    expect(d.trip.memberCount).toBe(2);
  });

  it('leaves the creator unnamed if they are no longer on the trip', () => {
    const d = tripDetailsFromRow({ ...base, trip_members: [row({ id: '2', display_name: 'Ravi' })] });
    expect(d.creatorName).toBeNull();
  });

  it('does not mistake a guest for the creator', () => {
    const d = tripDetailsFromRow({ ...base, created_by: 'user-1', trip_members: [row({ id: '9', user_id: null, display_name: 'Guest' })] });
    expect(d.creatorName).toBeNull();
  });

  it('handles a trip with no member list, an empty one and odd dates', () => {
    expect(tripDetailsFromRow({ ...base, trip_members: undefined })).toMatchObject({ members: [], creatorName: null, trip: { memberCount: null } });
    expect(tripDetailsFromRow({ ...base, trip_members: [] }).trip.memberCount).toBe(0);
    expect(tripDetailsFromRow({ ...base, end_date: '2026-12-01' }).lengthDays).toBeNull();
  });

  it('carries no email addresses, UPI IDs or profile fields', () => {
    const text = JSON.stringify(tripDetailsFromRow(base)).toLowerCase();
    for (const forbidden of ['email', 'upi', 'password', 'phone']) expect(text).not.toContain(forbidden);
  });
});
