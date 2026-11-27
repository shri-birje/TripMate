import { describe, expect, it } from 'vitest';
import { dayHeading, dayHeadingLong, groupExpensesByDay, tripDayNumber } from './expenseDays';

const e = (id: string, spentOn: string, amountMinor: number) => ({ id, spentOn, amountMinor });

describe('tripDayNumber', () => {
  it('the start day is Day 1, then 2, 3, 4', () => {
    expect(tripDayNumber('2027-06-27', '2027-06-27')).toBe(1);
    expect(tripDayNumber('2027-06-27', '2027-06-28')).toBe(2);
    expect(tripDayNumber('2027-06-27', '2027-06-29')).toBe(3);
    expect(tripDayNumber('2027-06-27', '2027-06-30')).toBe(4);
  });
  it('works across a month end', () => {
    expect(tripDayNumber('2027-01-30', '2027-02-02')).toBe(4);
  });
  it('works across a year end', () => {
    expect(tripDayNumber('2026-12-30', '2027-01-02')).toBe(4);
  });
  it('counts 29 February in a leap year and not in a common year', () => {
    expect(tripDayNumber('2028-02-27', '2028-03-01')).toBe(4); // 27, 28, 29, 1 March
    expect(tripDayNumber('2027-02-27', '2027-03-01')).toBe(3); // 27, 28, 1 March
    expect(tripDayNumber('2100-02-27', '2100-03-01')).toBe(3); // 2100 is not a leap year
    expect(tripDayNumber('2000-02-27', '2000-03-01')).toBe(4); // 2000 is
  });
  it('a day before the start is Day 0 or less, and an unreadable day is null', () => {
    expect(tripDayNumber('2027-06-27', '2027-06-26')).toBe(0);
    expect(tripDayNumber('2027-06-27', '2027-06-20')).toBe(-6);
    expect(tripDayNumber('2027-06-27', '2027-02-30')).toBeNull();
    expect(tripDayNumber('nope', '2027-06-27')).toBeNull();
  });
  it('does not depend on the time zone of the machine (pure UTC calendar arithmetic)', () => {
    const before = process.env.TZ;
    try {
      for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Kolkata', 'America/Los_Angeles', 'UTC']) {
        process.env.TZ = tz;
        expect(tripDayNumber('2027-03-13', '2027-03-15')).toBe(3); // spans a US daylight-saving change
        expect(tripDayNumber('2026-10-24', '2026-10-26')).toBe(3); // spans a European one
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('groupExpensesByDay', () => {
  const start = '2027-06-27';
  const list = [
    e('breakfast', '2027-06-27', 30000),
    e('lunch', '2027-06-28', 80000),
    e('fuel', '2027-06-27', 150000),
    e('hotel', '2027-06-27', 300000),
    e('activities', '2027-06-28', 120000),
    e('dinner', '2027-06-29', 150000),
    e('shopping', '2027-06-29', 50000),
  ];
  const groups = groupExpensesByDay(list, start);

  it('makes one group per day that has expenses, oldest first', () => {
    expect(groups.map((g) => [g.dayNumber, g.dateIso])).toEqual([
      [1, '2027-06-27'],
      [2, '2027-06-28'],
      [3, '2027-06-29'],
    ]);
  });
  it('totals each day in paise', () => {
    expect(groups.map((g) => g.totalMinor)).toEqual([480000, 200000, 200000]);
  });
  it('keeps the given order inside a day', () => {
    expect(groups[0]!.expenses.map((x) => x.id)).toEqual(['breakfast', 'fuel', 'hotel']);
    expect(groups[1]!.expenses.map((x) => x.id)).toEqual(['lunch', 'activities']);
  });
  it('does not invent empty days for days without expenses', () => {
    const gap = groupExpensesByDay([e('a', '2027-06-27', 100), e('b', '2027-06-30', 200)], start);
    expect(gap.map((g) => g.dayNumber)).toEqual([1, 4]);
  });
  it('an expense dated earlier than others lands in its own day, whenever it was recorded', () => {
    const withLate = groupExpensesByDay([...list, e('forgotten taxi', '2027-06-27', 70000)], start);
    expect(withLate[0]!.expenses.map((x) => x.id)).toContain('forgotten taxi');
    expect(withLate[0]!.totalMinor).toBe(550000);
  });
  it('editing an expense to another date moves it and refreshes both totals', () => {
    const moved = list.map((x) => (x.id === 'hotel' ? { ...x, spentOn: '2027-06-28' } : x));
    const g = groupExpensesByDay(moved, start);
    expect(g.map((x) => x.totalMinor)).toEqual([180000, 500000, 200000]);
  });
  it('deleting removes it from its day, and the day disappears if it was the last one; restoring brings it back', () => {
    const without = list.filter((x) => x.id !== 'dinner' && x.id !== 'shopping');
    expect(groupExpensesByDay(without, start).map((g) => g.dayNumber)).toEqual([1, 2]);
    expect(groupExpensesByDay(list, start).map((g) => g.dayNumber)).toEqual([1, 2, 3]);
  });
  it('changing the trip start date renumbers the days without touching the expenses', () => {
    const a = groupExpensesByDay(list, '2027-06-27');
    const b = groupExpensesByDay(list, '2027-06-26');
    expect(a.map((g) => g.dayNumber)).toEqual([1, 2, 3]);
    expect(b.map((g) => g.dayNumber)).toEqual([2, 3, 4]);
    expect(b.map((g) => g.totalMinor)).toEqual(a.map((g) => g.totalMinor));
  });
  it('an expense dated before the trip is in a group numbered 0 or less (shown as before the trip)', () => {
    const g = groupExpensesByDay([e('early', '2027-06-25', 500), e('a', '2027-06-27', 100)], start);
    expect(g.map((x) => x.dayNumber)).toEqual([-1, 1]);
  });
  it('works across month and year boundaries and in order', () => {
    const g = groupExpensesByDay([e('c', '2027-01-02', 3), e('a', '2026-12-30', 1), e('b', '2026-12-31', 2)], '2026-12-30');
    expect(g.map((x) => [x.dateIso, x.dayNumber])).toEqual([['2026-12-30', 1], ['2026-12-31', 2], ['2027-01-02', 4]]);
  });
  it('no expenses gives no groups', () => {
    expect(groupExpensesByDay([], start)).toEqual([]);
  });
  it('refuses to add up beyond exact whole numbers instead of drifting', () => {
    expect(() => groupExpensesByDay([e('a', '2027-06-27', Number.MAX_SAFE_INTEGER), e('b', '2027-06-27', 1)], start)).toThrow();
  });
});

describe('dayHeadingLong', () => {
  it('names the full weekday and the full date', () => {
    expect(dayHeadingLong('2026-11-25')).toBe('Wednesday, 25 November 2026');
    expect(dayHeadingLong('2026-11-26')).toBe('Thursday, 26 November 2026');
    expect(dayHeadingLong('2028-02-29')).toBe('Tuesday, 29 February 2028');
  });
  it('shows an unreadable day as written', () => {
    expect(dayHeadingLong('2027-02-30')).toBe('2027-02-30');
  });
});

describe('dayHeading', () => {
  it('names the weekday and the date', () => {
    expect(dayHeading('2027-06-28')).toBe('Mon, 28 Jun 2027');
    expect(dayHeading('2028-02-29')).toBe('Tue, 29 Feb 2028');
  });
  it('shows an unreadable day as written', () => {
    expect(dayHeading('2027-02-30')).toBe('2027-02-30');
  });
});
