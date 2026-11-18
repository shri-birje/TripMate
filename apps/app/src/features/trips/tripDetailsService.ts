import { isValidTripId, memberRowFromList, tripDetailsFromRow, type MemberListRow, type TripDetails, type TripRow } from '@tripmate/core';

/**
 * Reading one trip's details.
 *
 * WHO MAY SEE A TRIP is decided by the database (row-level security: only
 * active members can read a trip and its members). This code never tries to
 * second-guess that; it only reflects the answer.
 *
 * PRIVACY: the trip request names its columns explicitly (no "*"), so a column added
 * to the table in future can never be sent to the screen by accident. The people come
 * from the database function list_trip_members(), which sends a CURRENT member's id,
 * user id, name, role and dates, but for a FORMER member only a name, a status, dates
 * and a guest flag: their user id and role never reach the browser. No profile is
 * touched, so no email address or UPI ID is ever requested.
 *
 * NOT FOUND vs NO ACCESS: when the database hides a trip it returns nothing,
 * with no error, and it must not say whether the trip exists (otherwise anyone
 * could test which trip ids exist). So an unknown trip, a trip you are not on,
 * a trip you were removed from or left, and a malformed link all produce the
 * SAME error and the SAME message. Only real connection problems differ.
 */
interface PgError {
  code?: string | undefined;
  message?: string | undefined;
}

interface DetailsQuery {
  eq(column: string, value: string): DetailsQuery;
  maybeSingle(): PromiseLike<{ data: TripRow | null; error: PgError | null }>;
}

/** Just the slice of Supabase's client we use, so tests can supply a fake. */
export interface TripDetailsClient {
  from(table: 'trips'): { select(columns: string): DetailsQuery };
  rpc(fn: 'list_trip_members', args: { p_trip_id: string }): PromiseLike<{ data: MemberListRow[] | null; error: PgError | null }>;
}

/** Exactly what is asked of the trips table. Nothing else is ever requested (the people come from list_trip_members). */
export const TRIP_DETAILS_COLUMNS =
  'id, name, destination, start_date, end_date, description, budget_minor, currency, cover_image_path, status, created_by, created_at, updated_at, version';

export type TripDetailsErrorKind = 'unavailable' | 'network' | 'setup' | 'unknown';

export const UNAVAILABLE_MESSAGE = "We couldn't open this trip. It may have been removed, or you may not be a member.";
const NETWORK_MESSAGE = "Can't reach the server. Check your internet connection and try again.";
const SETUP_MESSAGE = "Trips aren't set up on the server yet. The database update for trips still needs to be applied.";
const MEMBERS_SETUP_MESSAGE = "Members aren't set up on the server yet. The database update for members still needs to be applied.";
const UNKNOWN_MESSAGE = 'Something went wrong. Please try again.';

export class TripDetailsError extends Error {
  constructor(public readonly kind: TripDetailsErrorKind, message: string) {
    super(message);
    this.name = 'TripDetailsError';
  }
}

const unavailable = () => new TripDetailsError('unavailable', UNAVAILABLE_MESSAGE);

function toError(error: PgError): TripDetailsError {
  const code = error.code ?? '';
  const text = error.message ?? '';
  if (code === '22P02') return unavailable(); // "invalid input syntax for type uuid": same answer as any other unavailable trip
  if (['PGRST205', '42P01'].includes(code)) return new TripDetailsError('setup', SETUP_MESSAGE);
  if (['PGRST202', '42883'].includes(code)) return new TripDetailsError('setup', MEMBERS_SETUP_MESSAGE); // list_trip_members() is missing
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(text)) return new TripDetailsError('network', NETWORK_MESSAGE);
  return new TripDetailsError('unknown', UNKNOWN_MESSAGE); // raw database text is never shown
}

/**
 * Loads one trip with its current members. Throws a TripDetailsError whose `kind` tells the screen
 * what to show: 'unavailable' (the single combined state), 'network' (offer Try again), 'setup', 'unknown'.
 */
export async function getTripDetails(client: TripDetailsClient, tripId: unknown): Promise<TripDetails> {
  // A malformed link is answered without bothering the server, and exactly like any other unavailable trip.
  if (!isValidTripId(tripId)) throw unavailable();

  let reply: Awaited<ReturnType<DetailsQuery['maybeSingle']>>;
  try {
    reply = await client.from('trips').select(TRIP_DETAILS_COLUMNS).eq('id', tripId).maybeSingle();
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' });
  }
  if (reply.error) throw toError(reply.error);
  if (!reply.data) throw unavailable();

  let people: Awaited<ReturnType<TripDetailsClient['rpc']>>;
  try {
    people = await client.rpc('list_trip_members', { p_trip_id: tripId });
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' });
  }
  if (people.error) throw toError(people.error);
  const rows = people.data ?? [];
  // The trip was visible a moment ago but the database now lists nobody: the person was removed in between.
  if (rows.length === 0) throw unavailable();
  return tripDetailsFromRow({ ...reply.data, trip_members: rows.map(memberRowFromList) });
}
