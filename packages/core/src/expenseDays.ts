import { longDateLabel, partsOfIso, weekdayOf } from './calendar';
import { addMinor } from './money';
import { formatDateRange } from './trip';

/**
 * Day-wise organisation of a trip's expenses. A presentation-level summary only: it reads the expenses' own `spentOn` day (never
 * the time they were recorded or edited, never today's date, never the device's time zone) and the trip's start day, and adds
 * up the existing amounts in whole paise. Nothing here changes an expense, a split, a balance or a settlement.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Which day of the trip a calendar day is: the start day is Day 1, the next Day 2, and so on. Calendar-date arithmetic in UTC, so
 * month ends, year ends, leap days and every device time zone give the same answer. A day before the start gives 0 or less.
 * Returns null if either value is not a real calendar day.
 */
export function tripDayNumber(tripStartIso: string, dayIso: string): number | null {
  const a = partsOfIso(tripStartIso);
  const b = partsOfIso(dayIso);
  if (!a || !b) return null;
  const diff = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(diff / MS_PER_DAY) + 1;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "Mon, 28 Jun 2027" for a calendar day (falls back to the text itself if it is not a real day). */
export function dayHeading(iso: string): string {
  const wd = weekdayOf(iso);
  if (wd === null) return iso;
  return `${WEEKDAYS[wd]}, ${formatDateRange(iso, iso)}`;
}

const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** "Wednesday, 25 November 2026" for a calendar day (falls back to the text itself if it is not a real day). */
export function dayHeadingLong(iso: string): string {
  const wd = weekdayOf(iso);
  if (wd === null) return iso;
  return `${WEEKDAYS_LONG[wd]}, ${longDateLabel(iso)}`;
}

export interface ExpenseDayGroup<T> {
  /** The calendar day, `YYYY-MM-DD`. */
  dateIso: string;
  /** Day 1 is the trip's start day. 0 or less means the expense is dated before the trip started; null if the date is unreadable. */
  dayNumber: number | null;
  /** The day's expenses, in the order they were given. */
  expenses: T[];
  /** The sum of their amounts, in paise. */
  totalMinor: number;
}

/**
 * Groups expenses by their `spentOn` day, oldest day first. Only days that have expenses appear. Within a day the input order is
 * kept, so the existing ordering rules still apply. Pass only the expenses that should count (the screen passes the live ones;
 * deleted expenses are kept in their own section and are not in any day's total).
 */
export function groupExpensesByDay<T extends { spentOn: string; amountMinor: number }>(expenses: readonly T[], tripStartIso: string): ExpenseDayGroup<T>[] {
  const byDay = new Map<string, ExpenseDayGroup<T>>();
  for (const e of expenses) {
    let group = byDay.get(e.spentOn);
    if (!group) {
      group = { dateIso: e.spentOn, dayNumber: tripDayNumber(tripStartIso, e.spentOn), expenses: [], totalMinor: 0 };
      byDay.set(e.spentOn, group);
    }
    group.expenses.push(e);
    group.totalMinor = addMinor(group.totalMinor, e.amountMinor);
  }
  // ISO days sort correctly as plain text
  return [...byDay.values()].sort((x, y) => (x.dateIso < y.dateIso ? -1 : x.dateIso > y.dateIso ? 1 : 0));
}
