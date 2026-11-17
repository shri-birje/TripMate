import { describe, expect, it } from 'vitest';
import {
  TripCreateSchema,
  createTripRpcArgs,
  formatDateRange,
  groupTripsByPhase,
  parseDateInput,
  tripFromRow,
  tripPhase,
  type Trip,
  type TripListRow,
} from './trip';
import { validate } from './validation';

describe('parseDateInput', () => {
  it.each([
    ['2026-12-27', '2026-12-27'],
    ['27/12/2026', '2026-12-27'],
    ['27-12-2026', '2026-12-27'],
    ['27.12.2026', '2026-12-27'],
    ['3/4/2026', '2026-04-03'], // day first: 3 April, not 4 March
    ['03/04/2026', '2026-04-03'],
    ['2026-1-5', '2026-01-05'],
    ['  27/12/2026  ', '2026-12-27'],
    ['29/02/2028', '2028-02-29'], // leap year
    ['31/12/2100', '2100-12-31'],
    ['01/01/2000', '2000-01-01'],
  ])('reads %j as %s', (text, iso) => {
    expect(parseDateInput(text)).toBe(iso);
  });

  it.each([
    '', '   ', 'tomorrow', '27 Dec 2026', '2026/12/27', '27/12/26', '30/02/2026', '29/02/2027', '31/04/2026',
    '00/01/2026', '01/00/2026', '32/01/2026', '01/13/2026', '27/12/1999', '27/12/2101', '2026-13-01', '2026-02-30', '27//2026', '１２/１２/２０２６',
  ])('rejects %j', (text) => {
    expect(parseDateInput(text)).toBeNull();
  });
});

describe('formatDateRange', () => {
  it('formats the different shapes of range', () => {
    expect(formatDateRange('2026-12-27', '2026-12-27')).toBe('27 Dec 2026');
    expect(formatDateRange('2026-12-27', '2026-12-30')).toBe('27–30 Dec 2026');
    expect(formatDateRange('2026-12-28', '2027-01-02')).toBe('28 Dec 2026 – 2 Jan 2027');
    expect(formatDateRange('2026-03-30', '2026-04-02')).toBe('30 Mar – 2 Apr 2026');
  });
});

describe('tripPhase', () => {
  it('is upcoming before the start, ongoing on the first and last day, completed after', () => {
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-26')).toBe('upcoming');
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-27')).toBe('ongoing');
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-28')).toBe('ongoing');
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-30')).toBe('ongoing');
    expect(tripPhase('2026-12-27', '2026-12-30', '2026-12-31')).toBe('completed');
  });
  it('handles a one-day trip and year boundaries', () => {
    expect(tripPhase('2026-12-27', '2026-12-27', '2026-12-27')).toBe('ongoing');
    expect(tripPhase('2026-12-30', '2027-01-02', '2027-01-01')).toBe('ongoing');
    expect(tripPhase('2026-12-30', '2027-01-02', '2027-01-03')).toBe('completed');
  });
});

describe('TripCreateSchema', () => {
  const good = {
    name: 'Goa Trip 2026',
    destination: 'Goa, India',
    startDate: '27/12/2026',
    endDate: '30/12/2026',
    description: '',
    budget: '60,000',
    currency: 'INR',
  };

  it('accepts the example from the product brief and cleans it', () => {
    const r = validate(TripCreateSchema, good);
    expect(r).toEqual({
      ok: true,
      data: {
        name: 'Goa Trip 2026',
        destination: 'Goa, India',
        startDate: '2026-12-27',
        endDate: '2026-12-30',
        description: null,
        budgetMinor: 6_000_000, // Rs 60,000 in paise (via the M1 parser)
        currency: 'INR',
      },
    });
  });

  it('trims text and keeps a real description', () => {
    const r = validate(TripCreateSchema, { ...good, name: '  Goa  ', description: '  Beach and food  ' });
    expect(r).toMatchObject({ ok: true, data: { name: 'Goa', description: 'Beach and food' } });
  });

  it('budget is optional; a blank budget means none', () => {
    for (const blank of ['', '   ']) {
      expect(validate(TripCreateSchema, { ...good, budget: blank })).toMatchObject({ ok: true, data: { budgetMinor: null } });
    }
  });

  it('reads budgets exactly, paise included', () => {
    expect(validate(TripCreateSchema, { ...good, budget: '1,234.50' })).toMatchObject({ ok: true, data: { budgetMinor: 123_450 } });
    expect(validate(TripCreateSchema, { ...good, budget: '₹10000' })).toMatchObject({ ok: true, data: { budgetMinor: 1_000_000 } });
  });

  it.each(['0', 'abc', '-500', '1.234', '1e5', '12 000'])('rejects budget %j with a clear message', (budget) => {
    const r = validate(TripCreateSchema, { ...good, budget });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.budget).toBe('Enter a budget like 60000 or 60,000.50, or leave it blank');
  });

  it('requires an end date on or after the start date (same day is fine)', () => {
    const before = validate(TripCreateSchema, { ...good, endDate: '26/12/2026' });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.errors.endDate).toBe('The end date must be on or after the start date');
    expect(validate(TripCreateSchema, { ...good, endDate: '27/12/2026' }).ok).toBe(true);
  });

  it('reports every problem at once, including the date order when other fields are also wrong', () => {
    const r = validate(TripCreateSchema, { ...good, name: '', budget: 'abc', endDate: '26/12/2026' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['budget', 'endDate', 'name']);
  });

  it('does not invent a date-order error when a date itself is unreadable', () => {
    const r = validate(TripCreateSchema, { ...good, startDate: 'soon', endDate: '26/12/2026' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors)).toEqual(['startDate']);
  });

  it('accepts either date style but rejects impossible dates, per field', () => {
    expect(validate(TripCreateSchema, { ...good, startDate: '2026-12-27', endDate: '2026-12-30' }).ok).toBe(true);
    const r = validate(TripCreateSchema, { ...good, startDate: '30/02/2026', endDate: 'soon' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.startDate).toBe('Enter the start date like 27/12/2026');
      expect(r.errors.endDate).toBe('Enter the end date like 27/12/2026');
    }
  });

  it('rejects blank or over-long names, destinations and descriptions', () => {
    const r = validate(TripCreateSchema, { ...good, name: '   ', destination: '', description: 'x'.repeat(501) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['description', 'destination', 'name']);
    expect(validate(TripCreateSchema, { ...good, name: 'x'.repeat(100), destination: 'y'.repeat(100), description: 'z'.repeat(500) }).ok).toBe(true);
    expect(validate(TripCreateSchema, { ...good, name: 'x'.repeat(101) }).ok).toBe(false);
  });

  it('rejects an unknown currency', () => {
    for (const currency of ['XYZ', 'inr', '', 'RS']) expect(validate(TripCreateSchema, { ...good, currency }).ok).toBe(false);
  });

  it('copes with missing fields and wrong types', () => {
    expect(validate(TripCreateSchema, {}).ok).toBe(false);
    expect(validate(TripCreateSchema, null).ok).toBe(false);
    expect(validate(TripCreateSchema, { ...good, budget: 60000 }).ok).toBe(false);
  });

  it('cannot be used to set who created the trip, its id or status', () => {
    const r = validate(TripCreateSchema, { ...good, created_by: 'someone-else', id: 'x', status: 'archived', createdBy: 'y' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(createTripRpcArgs(r.data)).sort()).toEqual([
      'p_budget_minor', 'p_currency', 'p_description', 'p_destination', 'p_end_date', 'p_name', 'p_start_date',
    ]);
  });

  it('maps to the exact database function arguments', () => {
    const r = validate(TripCreateSchema, good);
    if (!r.ok) throw new Error('expected ok');
    expect(createTripRpcArgs(r.data)).toEqual({
      p_name: 'Goa Trip 2026',
      p_destination: 'Goa, India',
      p_start_date: '2026-12-27',
      p_end_date: '2026-12-30',
      p_description: null,
      p_budget_minor: 6_000_000,
      p_currency: 'INR',
    });
  });
});

describe('tripFromRow', () => {
  const row: TripListRow = {
    id: 't1',
    name: 'Goa',
    destination: 'Goa',
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
    members: [
      { id: 'm1', status: 'active' },
      { id: 'm2', status: 'active' },
      { id: 'm3', status: 'removed' },
    ],
  };

  it('maps fields and counts only people who are still on the trip', () => {
    expect(tripFromRow(row)).toMatchObject({ id: 't1', startDate: '2026-12-27', budgetMinor: 6000000, status: 'active', memberCount: 2 });
  });
  it('reads a budget sent as text, and tolerates none', () => {
    expect(tripFromRow({ ...row, budget_minor: '6000000' }).budgetMinor).toBe(6000000);
    expect(tripFromRow({ ...row, budget_minor: null }).budgetMinor).toBeNull();
  });
  it('member count is null when members were not loaded', () => {
    expect(tripFromRow({ ...row, members: undefined }).memberCount).toBeNull();
    expect(tripFromRow({ ...row, members: null }).memberCount).toBeNull();
  });
  it('trims the fixed-width currency column and treats an unknown status as active', () => {
    expect(tripFromRow({ ...row, currency: 'INR ' }).currency).toBe('INR');
    expect(tripFromRow({ ...row, status: 'weird' }).status).toBe('active');
  });
});

describe('groupTripsByPhase', () => {
  const mk = (id: string, start: string, end: string, status: 'active' | 'archived' = 'active'): Trip =>
    ({ id, name: id, startDate: start, endDate: end, status }) as Trip;
  const today = '2026-12-28';
  const trips = [
    mk('past-old', '2026-01-01', '2026-01-05'),
    mk('past-recent', '2026-11-01', '2026-11-05'),
    mk('now-long', '2026-12-20', '2027-01-10'),
    mk('now-short', '2026-12-27', '2026-12-29'),
    mk('later', '2027-03-01', '2027-03-05'),
    mk('soon', '2027-01-15', '2027-01-20'),
    mk('hidden', '2026-12-27', '2026-12-30', 'archived'),
  ];

  it('sorts trips into ongoing, upcoming and completed, leaving out archived ones', () => {
    const g = groupTripsByPhase(trips, today);
    expect(g.ongoing.map((t) => t.id)).toEqual(['now-short', 'now-long']); // finishing soonest first
    expect(g.upcoming.map((t) => t.id)).toEqual(['soon', 'later']); // starting soonest first
    expect(g.completed.map((t) => t.id)).toEqual(['past-recent', 'past-old']); // most recent first
  });

  it('puts every non-archived trip in exactly one group', () => {
    const g = groupTripsByPhase(trips, today);
    expect(g.ongoing.length + g.upcoming.length + g.completed.length).toBe(6);
  });

  it('handles an empty list', () => {
    expect(groupTripsByPhase([], today)).toEqual({ ongoing: [], upcoming: [], completed: [] });
  });
});
