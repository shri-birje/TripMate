import { tripFromRow, type Trip, type TripRow } from './trip';

/**
 * Rules and helpers for the Trip Details screen.
 *
 * PRIVACY: the screen shows each person's NAME and ROLE only. Nothing here
 * handles email addresses, UPI IDs or profile data. The names come from the
 * trip's own member list (a snapshot taken when the person joined), so the
 * profiles table is never read for other people.
 */

// ---------------------------------------------------------------------------
// Trip links
// ---------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True if the text looks like a trip id. Checked before asking the server, so garbage never reaches it. */
export function isValidTripId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

// ---------------------------------------------------------------------------
// Calendar days. A trip date is a plain calendar day ("2026-12-27") with no
// time and no time zone. Counting days therefore uses pure calendar arithmetic
// (days since 1 Jan 1970 at UTC midnight), which has no daylight-saving hours
// and does not depend on the phone's time zone, so it can never be off by one.
// ---------------------------------------------------------------------------
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Whole days since 1970-01-01 for an ISO calendar day, or null if it is not a real date. */
export function calendarDayNumber(iso: string): number | null {
  const m = ISO_DAY.exec(iso);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return ms / MS_PER_DAY; // exact: UTC midnights are whole multiples of a day
}

/**
 * How many calendar days a trip covers, counting both the first and the last day:
 * 27 Dec to 30 Dec is 4 days; a trip that starts and ends on the same day is 1 day.
 * Returns null if either date is unreadable or the end is before the start.
 */
export function tripLengthDays(startIso: string, endIso: string): number | null {
  const start = calendarDayNumber(startIso);
  const end = calendarDayNumber(endIso);
  if (start === null || end === null || end < start) return null;
  return end - start + 1;
}

/** "1 day", "4 days". */
export function daysLabel(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

// ---------------------------------------------------------------------------
// People on a trip
// ---------------------------------------------------------------------------
/** A member as the database returns it. Only these columns are ever requested. */
export interface TripMemberRow {
  id: string;
  user_id: string | null;
  display_name: string;
  role: string;
  status: string;
  joined_at: string;
}

export interface TripMember {
  id: string;
  /** Empty for a "guest" (a friend without an account). */
  userId: string | null;
  displayName: string;
  role: 'admin' | 'member';
  status: 'active' | 'removed' | 'left';
  joinedAt: string;
  isGuest: boolean;
}

export function memberFromRow(row: TripMemberRow): TripMember {
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role === 'admin' ? 'admin' : 'member',
    status: row.status === 'removed' ? 'removed' : row.status === 'left' ? 'left' : 'active',
    joinedAt: row.joined_at,
    isGuest: row.user_id === null,
  };
}

const joinTime = (m: TripMember) => {
  const t = Date.parse(m.joinedAt);
  return Number.isNaN(t) ? 0 : t;
};

/** Administrators first, then in the order people joined, then by name; fully deterministic. */
export function sortMembers(members: readonly TripMember[]): TripMember[] {
  return [...members].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
    const byJoin = joinTime(a) - joinTime(b);
    if (byJoin !== 0) return byJoin;
    const byName = a.displayName.localeCompare(b.displayName, 'en');
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Trip + people
// ---------------------------------------------------------------------------
/** A trip row together with its (active) members, under the key the database query uses. */
export interface TripDetailsRow extends TripRow {
  trip_members?: TripMemberRow[] | null;
}

export interface TripDetails {
  trip: Trip;
  /** Current members only, administrators first. */
  members: TripMember[];
  admins: TripMember[];
  /** Name of the person who created the trip, if they are still on it; otherwise null. */
  creatorName: string | null;
  /** Calendar days covered, or null if the dates are unreadable. */
  lengthDays: number | null;
}

/**
 * Builds the details view of a trip. Only people whose status is "active" are
 * kept, even if the server were to send others (defence in depth: former
 * members' names are never shown).
 */
export function tripDetailsFromRow(row: TripDetailsRow): TripDetails {
  const members = sortMembers((row.trip_members ?? []).map(memberFromRow).filter((m) => m.status === 'active'));
  const trip = tripFromRow({
    ...row,
    members: row.trip_members ? members.map((m) => ({ id: m.id, status: m.status })) : null,
  });
  const creator = members.find((m) => m.userId !== null && m.userId === row.created_by);
  return {
    trip,
    members,
    admins: members.filter((m) => m.role === 'admin'),
    creatorName: creator ? creator.displayName : null,
    lengthDays: tripLengthDays(row.start_date, row.end_date),
  };
}
