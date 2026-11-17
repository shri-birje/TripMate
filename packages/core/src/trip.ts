import { z } from 'zod';
import { parseRupees } from './money';
import { SUPPORTED_CURRENCIES } from './profile';

/**
 * Rules and helpers for trips. Used by the app's forms now and by anything
 * else later, so every part of TripMate agrees. The database enforces the same
 * limits on its own as a second line of defence.
 */
export const TRIP_NAME_MAX = 100;
export const TRIP_DESTINATION_MAX = 100;
export const TRIP_DESCRIPTION_MAX = 500;

// ---------------------------------------------------------------------------
// Dates. A trip date is a plain calendar day ("2026-12-27"), with no time zone.
// ---------------------------------------------------------------------------
const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DAY_MONTH_YEAR = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Understands the ways people type dates in India and returns "YYYY-MM-DD",
 * or null if the text is not a real calendar date.
 *   27/12/2026   27-12-2026   27.12.2026   2026-12-27
 * Day comes first in the slash/dash/dot forms (03/04/2026 is 3 April).
 */
export function parseDateInput(input: string): string | null {
  const text = input.trim();
  let year: number;
  let month: number;
  let day: number;

  const iso = ISO_DATE.exec(text);
  const dmy = iso ? null : DAY_MONTH_YEAR.exec(text);
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (dmy) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  } else {
    return null;
  }

  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  // Let the calendar judge: 30 Feb, month 13 and 29 Feb in a non-leap year roll over, which we detect.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** "27 Dec 2026", "27-30 Dec 2026", "28 Dec 2026 - 2 Jan 2027" (inputs are ISO dates). */
export function formatDateRange(startIso: string, endIso: string): string {
  const [sy, sm, sd] = startIso.split('-').map(Number) as [number, number, number];
  const [ey, em, ed] = endIso.split('-').map(Number) as [number, number, number];
  const month = (m: number) => MONTHS[m - 1]!;
  if (startIso === endIso) return `${sd} ${month(sm)} ${sy}`;
  if (sy === ey && sm === em) return `${sd}–${ed} ${month(sm)} ${sy}`;
  if (sy === ey) return `${sd} ${month(sm)} – ${ed} ${month(em)} ${sy}`;
  return `${sd} ${month(sm)} ${sy} – ${ed} ${month(em)} ${ey}`;
}

// ---------------------------------------------------------------------------
// Where a trip is in time. Derived from dates, never stored, so it cannot go stale.
// ---------------------------------------------------------------------------
export type TripPhase = 'upcoming' | 'ongoing' | 'completed';

/** `todayIso` is passed in (not read from the clock) so this stays predictable and testable. ISO dates compare correctly as text. */
export function tripPhase(startDate: string, endDate: string, todayIso: string): TripPhase {
  if (todayIso < startDate) return 'upcoming';
  if (todayIso > endDate) return 'completed';
  return 'ongoing';
}

// ---------------------------------------------------------------------------
// Creating a trip
// ---------------------------------------------------------------------------
const dateField = (what: string) =>
  z
    .string()
    .trim()
    .transform((v) => parseDateInput(v) ?? 'invalid')
    .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: `Enter the ${what} like 27/12/2026` }));

/** Blank = no budget. Otherwise rupee text becomes paise using the approved M1 parser. */
const budgetField = z
  .string()
  .trim()
  .transform((v): number | null | 'invalid' => {
    if (v === '') return null;
    try {
      const paise = parseRupees(v);
      return paise > 0 ? paise : 'invalid';
    } catch {
      return 'invalid';
    }
  })
  .pipe(z.union([z.number().int(), z.null()], { error: 'Enter a budget like 60000 or 60,000.50, or leave it blank' }));

const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * True when the end date is not before the start date, OR when either date is not
 * (yet) readable - those cases already get their own message, so we stay quiet.
 * Written to survive any input, because it runs even when the rest of the form is invalid.
 */
function datesInOrder(t: { startDate?: unknown; endDate?: unknown } | null | undefined): boolean {
  const start = t?.startDate;
  const end = t?.endDate;
  return !(isIsoDate(start) && isIsoDate(end)) || end >= start;
}

export const TripCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { error: 'Enter a trip name' })
      .max(TRIP_NAME_MAX, { error: `Trip name can be at most ${TRIP_NAME_MAX} characters` }),
    destination: z
      .string()
      .trim()
      .min(1, { error: 'Enter a destination' })
      .max(TRIP_DESTINATION_MAX, { error: `Destination can be at most ${TRIP_DESTINATION_MAX} characters` }),
    startDate: dateField('start date'),
    endDate: dateField('end date'),
    description: z
      .string()
      .trim()
      .max(TRIP_DESCRIPTION_MAX, { error: `Description can be at most ${TRIP_DESCRIPTION_MAX} characters` })
      .transform((v) => (v === '' ? null : v)),
    budget: budgetField,
    currency: z.enum(SUPPORTED_CURRENCIES, { error: 'Choose a currency from the list' }),
  })
  .refine((t) => datesInOrder(t), {
    path: ['endDate'],
    error: 'The end date must be on or after the start date',
    // By default Zod skips whole-form checks when any single field already failed. Run this one regardless so
    // the person sees every problem at once. (It safely does nothing while either date is itself invalid.)
    when: () => true,
  })
  .transform(({ budget, ...rest }) => ({ ...rest, budgetMinor: budget }));

export type TripCreateInput = z.infer<typeof TripCreateSchema>;

/** The exact argument names of the database function create_trip. */
export function createTripRpcArgs(t: TripCreateInput) {
  return {
    p_name: t.name,
    p_destination: t.destination,
    p_start_date: t.startDate,
    p_end_date: t.endDate,
    p_description: t.description,
    p_budget_minor: t.budgetMinor,
    p_currency: t.currency,
  };
}

// ---------------------------------------------------------------------------
// Trips as the database returns them, and as the app uses them
// ---------------------------------------------------------------------------
export interface TripRow {
  id: string;
  name: string;
  destination: string;
  start_date: string;
  end_date: string;
  description: string | null;
  budget_minor: number | string | null;
  currency: string;
  cover_image_path: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
}

/** A trip row together with the people on it (used by the trips list). */
export interface TripListRow extends TripRow {
  members?: { id: string; status: string }[] | null;
}

export interface Trip {
  id: string;
  name: string;
  destination: string;
  startDate: string;
  endDate: string;
  description: string | null;
  budgetMinor: number | null;
  currency: string;
  coverImagePath: string | null;
  status: 'active' | 'archived';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** People currently on the trip, or null when the member list was not loaded. */
  memberCount: number | null;
}

export function tripFromRow(row: TripListRow): Trip {
  const budget = row.budget_minor === null || row.budget_minor === undefined ? null : Number(row.budget_minor);
  return {
    id: row.id,
    name: row.name,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    description: row.description,
    budgetMinor: budget !== null && Number.isSafeInteger(budget) ? budget : null,
    currency: row.currency.trim(),
    coverImagePath: row.cover_image_path,
    status: row.status === 'archived' ? 'archived' : 'active',
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    memberCount: row.members ? row.members.filter((m) => m.status === 'active').length : null,
  };
}

export interface TripsByPhase {
  ongoing: Trip[];
  upcoming: Trip[];
  completed: Trip[];
}

/** Sorts trips into Ongoing / Upcoming / Completed for the Home screen. Archived trips are left out. */
export function groupTripsByPhase(trips: readonly Trip[], todayIso: string): TripsByPhase {
  const groups: TripsByPhase = { ongoing: [], upcoming: [], completed: [] };
  for (const t of trips) {
    if (t.status === 'archived') continue;
    groups[tripPhase(t.startDate, t.endDate, todayIso)].push(t);
  }
  groups.ongoing.sort((a, b) => a.endDate.localeCompare(b.endDate) || a.name.localeCompare(b.name)); // finishing soonest first
  groups.upcoming.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name)); // starting soonest first
  groups.completed.sort((a, b) => b.startDate.localeCompare(a.startDate) || a.name.localeCompare(b.name)); // most recent first
  return groups;
}
