import { describe, expect, it } from 'vitest';
import { groupTripsByPhase, tripFromRow, TripCreateSchema, type Trip, type TripRow } from './trip';
import { tripDetailsFromRow, type TripDetailsRow, type TripMemberRow } from './tripDetails';
import {
  archivedTrips,
  isTripAdmin,
  isoToDmy,
  minorToInput,
  setTripArchivedRpcArgs,
  tripToFormValues,
  updateTripRpcArgs,
  validateTripEdit,
  type TripFormValues,
} from './tripEdit';
import { validate } from './validation';

const baseRow: TripRow = {
  id: 't1', name: 'Goa Trip 2026', destination: 'Goa, India', start_date: '2026-12-27', end_date: '2026-12-30',
  description: 'Beach', budget_minor: 6000000, currency: 'INR', cover_image_path: null, status: 'active',
  created_by: 'u1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', version: 3,
};
const trip = tripFromRow(baseRow);

describe('isoToDmy', () => {
  it('turns an ISO day into the way it is typed in India', () => {
    expect(isoToDmy('2026-12-27')).toBe('27/12/2026');
    expect(isoToDmy('2028-02-29')).toBe('29/02/2028');
    expect(isoToDmy('2026-01-05')).toBe('05/01/2026');
  });
  it('gives nothing for anything unreadable', () => {
    for (const bad of ['', 'x', '27/12/2026', '2026-1-5', ' 2026-12-27']) expect(isoToDmy(bad)).toBe('');
  });
});

describe('minorToInput (exact, no floating point)', () => {
  it.each([
    [6_000_000, '60000'], [123_450, '1234.50'], [5, '0.05'], [100, '1'], [0, '0'], [99, '0.99'], [10_050, '100.50'], [Number.MAX_SAFE_INTEGER - 1, '90071992547409.90'],
  ])('%d paise -> %s', (minor, text) => {
    expect(minorToInput(minor)).toBe(text);
  });
});

describe('tripToFormValues and back (round trip)', () => {
  it('pre-fills the form from a trip, dates as DD/MM/YYYY and the budget as typed rupees', () => {
    expect(tripToFormValues(trip)).toEqual({
      name: 'Goa Trip 2026', destination: 'Goa, India', startDate: '27/12/2026', endDate: '30/12/2026', description: 'Beach', budget: '60000',
    });
  });
  it('a trip with no description or budget gives empty text', () => {
    const t = tripFromRow({ ...baseRow, description: null, budget_minor: null });
    expect(tripToFormValues(t)).toMatchObject({ description: '', budget: '' });
  });
  it('submitting the untouched form reproduces the trip exactly (so "no change" really is no change)', () => {
    const r = validateTripEdit(tripToFormValues(trip), trip.currency);
    expect(r).toEqual({
      ok: true,
      data: { name: 'Goa Trip 2026', destination: 'Goa, India', startDate: '2026-12-27', endDate: '2026-12-30', description: 'Beach', budgetMinor: 6000000 },
    });
  });
  it('round-trips awkward budgets (paise) and a one-day trip', () => {
    const t = tripFromRow({ ...baseRow, budget_minor: 123_450, start_date: '2026-12-27', end_date: '2026-12-27', description: null });
    expect(validateTripEdit(tripToFormValues(t), 'INR')).toMatchObject({ ok: true, data: { budgetMinor: 123_450, startDate: '2026-12-27', endDate: '2026-12-27', description: null } });
  });
});

describe('validateTripEdit uses the SAME rules as Create', () => {
  const good: TripFormValues = { name: 'Goa', destination: 'Goa', startDate: '27/12/2026', endDate: '30/12/2026', description: '', budget: '' };

  it('accepts and cleans a valid edit; the output has no currency', () => {
    const r = validateTripEdit({ ...good, name: '  Goa Trip  ', description: '  Fun  ', budget: '60,000' }, 'USD');
    expect(r).toEqual({ ok: true, data: { name: 'Goa Trip', destination: 'Goa', startDate: '2026-12-27', endDate: '2026-12-30', description: 'Fun', budgetMinor: 6_000_000 } });
    if (r.ok) expect(Object.keys(r.data)).not.toContain('currency');
  });

  it('gives exactly the same messages as Create for the same mistakes', () => {
    const bad = { name: '', destination: '', startDate: '30/02/2026', endDate: 'soon', description: 'x'.repeat(501), budget: 'lots' };
    const edit = validateTripEdit(bad, 'INR');
    const create = validate(TripCreateSchema, { ...bad, currency: 'INR' });
    expect(edit.ok).toBe(false);
    expect(create.ok).toBe(false);
    if (!edit.ok && !create.ok) expect(edit.errors).toEqual(create.errors);
  });

  it('reports every problem at once, including the date order', () => {
    const r = validateTripEdit({ ...good, name: '', budget: 'abc', endDate: '26/12/2026' }, 'INR');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['budget', 'endDate', 'name']);
  });

  it('rejects a zero budget but allows removing the budget (blank)', () => {
    expect(validateTripEdit({ ...good, budget: '0' }, 'INR').ok).toBe(false);
    expect(validateTripEdit({ ...good, budget: '' }, 'INR')).toMatchObject({ ok: true, data: { budgetMinor: null } });
  });

  it('a stored currency the app does not list never blocks an edit, and is never sent', () => {
    const r = validateTripEdit(good, 'JPY');
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(r.data)).not.toContain('JPY');
  });

  it('copes with garbage', () => {
    expect(validateTripEdit({} as TripFormValues, 'INR').ok).toBe(false);
    expect(validateTripEdit(null as unknown as TripFormValues, 'INR').ok).toBe(false);
  });
});

describe('RPC argument builders', () => {
  it('update_trip arguments: exactly the approved names, no currency, status or creator', () => {
    const edit = { name: 'A', destination: 'B', startDate: '2026-12-27', endDate: '2026-12-30', description: null, budgetMinor: 5 };
    const args = updateTripRpcArgs('trip-1', 4, edit);
    expect(args).toEqual({ p_trip_id: 'trip-1', p_expected_version: 4, p_name: 'A', p_destination: 'B', p_start_date: '2026-12-27', p_end_date: '2026-12-30', p_description: null, p_budget_minor: 5 });
    expect(Object.keys(args).join(',')).not.toMatch(/currency|status|created_by/);
  });
  it('set_trip_archived arguments', () => {
    expect(setTripArchivedRpcArgs('trip-1', true, 7)).toEqual({ p_trip_id: 'trip-1', p_archived: true, p_expected_version: 7 });
    expect(setTripArchivedRpcArgs('trip-1', false, 8)).toEqual({ p_trip_id: 'trip-1', p_archived: false, p_expected_version: 8 });
  });
});

describe('isTripAdmin', () => {
  const member = (id: string, userId: string | null, role: string, status = 'active'): TripMemberRow => ({
    id, user_id: userId, display_name: `P ${id}`, role, status, joined_at: '2026-11-18T10:00:00+00:00',
  });
  const details = (members: TripMemberRow[]) => tripDetailsFromRow({ ...baseRow, trip_members: members } as TripDetailsRow);

  it('is true only for a current administrator', () => {
    const d = details([member('1', 'u1', 'admin'), member('2', 'u2', 'member')]);
    expect(isTripAdmin(d, 'u1')).toBe(true);
    expect(isTripAdmin(d, 'u2')).toBe(false); // ordinary member
    expect(isTripAdmin(d, 'u3')).toBe(false); // not on the trip
    expect(isTripAdmin(d, null)).toBe(false); // signed out
  });
  it('a former administrator is not an administrator (only current members are kept)', () => {
    const d = details([member('1', 'u1', 'admin', 'left'), member('2', 'u2', 'admin')]);
    expect(isTripAdmin(d, 'u1')).toBe(false);
    expect(isTripAdmin(d, 'u2')).toBe(true);
  });
  it('a guest (no account) can never be matched to a person', () => {
    const d = details([member('1', null, 'admin')]);
    expect(isTripAdmin(d, 'u1')).toBe(false);
  });
});

describe('archivedTrips and the approved Home grouping', () => {
  const mk = (id: string, start: string, status: 'active' | 'archived', name = id): Trip => ({ ...trip, id, name, startDate: start, endDate: start, status });
  const all = [
    mk('a-old', '2026-01-01', 'archived'), mk('a-new', '2026-09-01', 'archived'), mk('live', '2026-12-28', 'active'),
    mk('a-same-b', '2026-05-01', 'archived', 'B'), mk('a-same-a', '2026-05-01', 'archived', 'A'),
  ];

  it('lists exactly the archived trips, most recent first, ties by name', () => {
    expect(archivedTrips(all).map((t) => t.id)).toEqual(['a-new', 'a-same-a', 'a-same-b', 'a-old']);
  });
  it('archived trips never appear in Ongoing, Upcoming or Completed (the approved grouping is unchanged)', () => {
    const g = groupTripsByPhase(all, '2026-12-28');
    const grouped = [...g.ongoing, ...g.upcoming, ...g.completed].map((t) => t.id);
    expect(grouped).toEqual(['live']);
    expect(grouped.some((id) => id.startsWith('a-'))).toBe(false);
  });
  it('every trip is in exactly one place: active groups + archived list = all trips', () => {
    const g = groupTripsByPhase(all, '2026-12-28');
    expect(g.ongoing.length + g.upcoming.length + g.completed.length + archivedTrips(all).length).toBe(all.length);
  });
  it('restoring (status back to active) puts a trip in the group its DATES say', () => {
    const restoredUpcoming = { ...mk('r1', '2027-02-01', 'active') };
    const restoredOngoing = { ...mk('r2', '2026-12-28', 'active') };
    const restoredCompleted = { ...mk('r3', '2026-03-01', 'active') };
    const g = groupTripsByPhase([restoredUpcoming, restoredOngoing, restoredCompleted], '2026-12-28');
    expect(g.upcoming.map((t) => t.id)).toEqual(['r1']);
    expect(g.ongoing.map((t) => t.id)).toEqual(['r2']);
    expect(g.completed.map((t) => t.id)).toEqual(['r3']);
  });
  it('handles empty input', () => {
    expect(archivedTrips([])).toEqual([]);
  });
});
