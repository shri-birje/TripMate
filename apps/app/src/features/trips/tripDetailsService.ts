import { isValidTripId, tripDetailsFromRow, type TripDetails, type TripDetailsRow } from '@tripmate/core';

/**
 * Reading one trip's details.
 *
 * WHO MAY SEE A TRIP is decided by the database (row-level security: only
 * active members can read a trip and its members). This code never tries to
 * second-guess that; it only reflects the answer.
 *
 * PRIVACY: the request names its columns explicitly (no "*"), so a column added
 * to the table in future can never be sent to the screen by accident. It asks
 * only for the trip and its CURRENT members' id, name, role and join date. It
 * does not touch profiles, so no email address or UPI ID is ever requested.
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
  maybeSingle(): PromiseLike<{ data: TripDetailsRow | null; error: PgError | null }>;
}

/** Just the slice of Supabase's client we use, so tests can supply a fake. */
export interface TripDetailsClient {
  from(table: 'trips'): { select(columns: string): DetailsQuery };
}

/** Exactly what is asked of the database. Nothing else is ever requested. */
export const TRIP_DETAILS_COLUMNS =
  'id, name, destination, start_date, end_date, description, budget_minor, currency, cover_image_path, status, created_by, created_at, updated_at, version, ' +
  'trip_members(id, user_id, display_name, role, status, joined_at)';

export type TripDetailsErrorKind = 'unavailable' | 'network' | 'setup' | 'unknown';

export const UNAVAILABLE_MESSAGE = "We couldn't open this trip. It may have been removed, or you may not be a member.";
const NETWORK_MESSAGE = "Can't reach the server. Check your internet connection and try again.";
const SETUP_MESSAGE = "Trips aren't set up on the server yet. The database update for trips still needs to be applied.";
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
    reply = await client
      .from('trips')
      .select(TRIP_DETAILS_COLUMNS)
      .eq('id', tripId)
      .eq('trip_members.status', 'active') // only people who are on the trip now
      .maybeSingle();
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' });
  }
  if (reply.error) throw toError(reply.error);
  if (!reply.data) throw unavailable();
  return tripDetailsFromRow(reply.data);
}
