import { calendarDayNumber } from './tripDetails';

/**
 * Date maths for the calendar picker. Like every trip date, these work on plain calendar
 * days ("2026-12-27") with no time and no time zone: the weekday comes from counting whole
 * days since 1 January 1970 (a Thursday), so it cannot be thrown off by time zones or
 * daylight saving. The existing date functions are used, not changed.
 */
export const CALENDAR_MIN_YEAR = 2000; // the same range the date validation accepts
export const CALENDAR_MAX_YEAR = 2100;

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** Sunday first, as on most Indian wall calendars. */
export const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

const pad2 = (n: number) => String(n).padStart(2, '0');

export interface YearMonth {
  year: number;
  /** 1 to 12. */
  month: number;
}

export interface MonthCell {
  iso: string;
  day: number;
}

export function isoFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** Splits a valid ISO day into numbers, or null if it is not a real calendar day. */
export function partsOfIso(iso: string): { year: number; month: number; day: number } | null {
  if (calendarDayNumber(iso) === null) return null;
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

/** How many days a month has (leap years included). `month` is 1 to 12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Sunday ... 6 = Saturday, or null for an unreadable date. 1 Jan 1970 (day 0) was a Thursday (4). */
export function weekdayOf(iso: string): number | null {
  const n = calendarDayNumber(iso);
  if (n === null) return null;
  return (((n + 4) % 7) + 7) % 7;
}

/**
 * The month as rows of 7 cells, Sunday first. Cells before the 1st and after the last day are null.
 * Always 4 to 6 rows.
 */
export function buildMonthGrid(year: number, month: number): (MonthCell | null)[][] {
  const lead = weekdayOf(isoFromParts(year, month, 1)) ?? 0;
  const total = daysInMonth(year, month);
  const cells: (MonthCell | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= total; day++) cells.push({ iso: isoFromParts(year, month, day), day });
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (MonthCell | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

const clampYearMonth = ({ year, month }: YearMonth): YearMonth => {
  if (year < CALENDAR_MIN_YEAR) return { year: CALENDAR_MIN_YEAR, month: 1 };
  if (year > CALENDAR_MAX_YEAR) return { year: CALENDAR_MAX_YEAR, month: 12 };
  return { year, month };
};

/** Moves forward or back by whole months (negative = back), staying inside the supported years. */
export function shiftMonth(from: YearMonth, deltaMonths: number): YearMonth {
  const index = from.year * 12 + (from.month - 1) + deltaMonths;
  return clampYearMonth({ year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 });
}

/** Moves forward or back by whole years, keeping the month (clamped to the supported years). */
export function shiftYear(from: YearMonth, deltaYears: number): YearMonth {
  return clampYearMonth({ year: from.year + deltaYears, month: from.month });
}

/** "December 2026". */
export function monthLabel({ year, month }: YearMonth): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** "27 December 2026" (used to name each day for screen readers). */
export function longDateLabel(iso: string): string {
  const p = partsOfIso(iso);
  return p ? `${p.day} ${MONTH_NAMES[p.month - 1]} ${p.year}` : iso;
}
