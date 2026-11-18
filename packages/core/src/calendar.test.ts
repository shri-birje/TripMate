import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CALENDAR_MAX_YEAR,
  CALENDAR_MIN_YEAR,
  MONTH_NAMES,
  buildMonthGrid,
  daysInMonth,
  isoFromParts,
  longDateLabel,
  monthLabel,
  partsOfIso,
  shiftMonth,
  shiftYear,
  weekdayOf,
} from './calendar';
import { parseDateInput } from './trip';

describe('the supported years match the date validation', () => {
  it('2000 and 2100 are accepted by the existing validation; 1999 and 2101 are not', () => {
    expect(parseDateInput(`01/01/${CALENDAR_MIN_YEAR}`)).not.toBeNull();
    expect(parseDateInput(`31/12/${CALENDAR_MAX_YEAR}`)).not.toBeNull();
    expect(parseDateInput(`31/12/${CALENDAR_MIN_YEAR - 1}`)).toBeNull();
    expect(parseDateInput(`01/01/${CALENDAR_MAX_YEAR + 1}`)).toBeNull();
  });
});

describe('daysInMonth', () => {
  it('knows every month, and leap years', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2026, m))).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29); // divisible by 400
    expect(daysInMonth(2100, 2)).toBe(28); // divisible by 100 but not 400
    expect(daysInMonth(2027, 2)).toBe(28);
  });
});

describe('weekdayOf (0 = Sunday)', () => {
  it.each([
    ['1970-01-01', 4], // Thursday: the day the counting starts from
    ['2000-01-01', 6], // Saturday
    ['2024-02-29', 4], // Thursday (a leap day)
    ['2026-12-25', 5], // Friday (Christmas 2026)
    ['2026-12-27', 0], // Sunday
    ['2026-11-18', 3], // Wednesday
    ['2100-12-31', 5], // Friday
  ])('%s is weekday %d', (iso, weekday) => {
    expect(weekdayOf(iso)).toBe(weekday);
  });

  it('is null for anything that is not a real day', () => {
    for (const bad of ['', 'x', '2026-02-30', '27/12/2026', '2026-13-01']) expect(weekdayOf(bad)).toBeNull();
  });

  it('agrees with the JavaScript calendar for EVERY day from 2000 to 2100 (an independent check)', () => {
    for (let y = CALENDAR_MIN_YEAR; y <= CALENDAR_MAX_YEAR; y++) {
      for (let m = 1; m <= 12; m++) {
        for (let d = 1; d <= daysInMonth(y, m); d++) {
          expect(weekdayOf(isoFromParts(y, m, d))).toBe(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
        }
      }
    }
  });
});

describe('buildMonthGrid', () => {
  it('December 2026 starts on a Tuesday and has 31 days', () => {
    const weeks = buildMonthGrid(2026, 12);
    expect(weeks[0]!.map((c) => c?.day ?? null)).toEqual([null, null, 1, 2, 3, 4, 5]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
    expect(weeks.at(-1)!.map((c) => c?.day ?? null)).toEqual([27, 28, 29, 30, 31, null, null]);
  });

  it('February 2026 (28 days, starts on a Sunday) is exactly 4 full weeks', () => {
    const weeks = buildMonthGrid(2026, 2);
    expect(weeks).toHaveLength(4);
    expect(weeks[0]![0]!.day).toBe(1);
    expect(weeks.flat().every((c) => c !== null)).toBe(true);
  });

  it('February 2028 has a 29th; February 2027 does not', () => {
    expect(buildMonthGrid(2028, 2).flat().some((c) => c?.day === 29)).toBe(true);
    expect(buildMonthGrid(2027, 2).flat().some((c) => c?.day === 29)).toBe(false);
  });

  it('a month can need 6 rows (March 2026 starts on a Sunday and has 31 days: 5 rows; August 2026 needs 6)', () => {
    expect(buildMonthGrid(2026, 3)).toHaveLength(5);
    expect(buildMonthGrid(2026, 8)).toHaveLength(6);
  });

  it('every row has 7 cells, each day appears exactly once and in order, each is a real date, and the 1st is under the right weekday (property: every month 2000-2100)', () => {
    for (let y = CALENDAR_MIN_YEAR; y <= CALENDAR_MAX_YEAR; y++) {
      for (let m = 1; m <= 12; m++) {
        const weeks = buildMonthGrid(y, m);
        expect(weeks.length).toBeGreaterThanOrEqual(4);
        expect(weeks.length).toBeLessThanOrEqual(6);
        expect(weeks.every((w) => w.length === 7)).toBe(true);
        const days = weeks.flat().filter((c): c is NonNullable<typeof c> => c !== null);
        expect(days.map((c) => c.day)).toEqual(Array.from({ length: daysInMonth(y, m) }, (_, i) => i + 1));
        expect(days.every((c) => parseDateInput(c.iso.split('-').reverse().join('/')) === c.iso)).toBe(true);
        expect(weeks[0]!.findIndex((c) => c?.day === 1)).toBe(weekdayOf(isoFromParts(y, m, 1)));
      }
    }
  });
});

describe('shiftMonth / shiftYear', () => {
  it('moves across year boundaries', () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 6 }, 14)).toEqual({ year: 2027, month: 8 });
    expect(shiftMonth({ year: 2026, month: 6 }, -18)).toEqual({ year: 2024, month: 12 });
    expect(shiftMonth({ year: 2026, month: 6 }, 0)).toEqual({ year: 2026, month: 6 });
  });
  it('stops at the supported years instead of going beyond them', () => {
    expect(shiftMonth({ year: 2000, month: 1 }, -1)).toEqual({ year: 2000, month: 1 });
    expect(shiftMonth({ year: 2100, month: 12 }, 1)).toEqual({ year: 2100, month: 12 });
    expect(shiftYear({ year: 2000, month: 5 }, -1)).toEqual({ year: 2000, month: 1 });
    expect(shiftYear({ year: 2100, month: 5 }, 1)).toEqual({ year: 2100, month: 12 });
  });
  it('shifting a year keeps the month', () => {
    expect(shiftYear({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 12 });
    expect(shiftYear({ year: 2026, month: 3 }, -2)).toEqual({ year: 2024, month: 3 });
  });
  it('going forward then back returns to the start (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2001, max: 2099 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 0, max: 200 }), (y, m, n) => {
        const there = shiftMonth({ year: y, month: m }, n);
        fc.pre(there.year > 2000 && there.year < 2100);
        expect(shiftMonth(there, -n)).toEqual({ year: y, month: m });
      }),
      { numRuns: 1000 },
    );
  });
});

describe('labels and helpers', () => {
  it('names months and days for screen readers', () => {
    expect(monthLabel({ year: 2026, month: 12 })).toBe('December 2026');
    expect(longDateLabel('2026-12-27')).toBe('27 December 2026');
    expect(longDateLabel('2028-02-29')).toBe('29 February 2028');
    expect(longDateLabel('nonsense')).toBe('nonsense');
    expect(MONTH_NAMES).toHaveLength(12);
  });
  it('isoFromParts and partsOfIso are inverses', () => {
    expect(isoFromParts(2026, 1, 5)).toBe('2026-01-05');
    expect(partsOfIso('2026-01-05')).toEqual({ year: 2026, month: 1, day: 5 });
    expect(partsOfIso('2026-02-30')).toBeNull();
    expect(partsOfIso('x')).toBeNull();
  });
});
