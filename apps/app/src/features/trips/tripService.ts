import {
  TripCreateSchema,
  createTripRpcArgs,
  tripFromRow,
  validate,
  type Trip,
  type TripListRow,
  type TripRow,
} from '@tripmate/core';

/**
 * Listing and creating trips.
 *
 * Who may see or change what is decided by the database (row-level security
 * and the create_trip function). This code adds validation and friendly errors
 * on top; it is not the only line of defence.
 *
 * `TripsClient` describes only the slice of Supabase's client we use, so tests
 * can supply a fake. The real client is passed in through one cast in tripApi.ts.
 */
interface PgError {
  code?: string | undefined;
  message?: string | undefined;
}

export interface TripsClient {
  from(table: 'trips'): {
    select(columns: string): {
      order(column: string, options: { ascending: boolean }): PromiseLike<{ data: TripListRow[] | null; error: PgError | null }>;
    };
  };
  rpc(fn: 'create_trip', args: Record<string, unknown>): PromiseLike<{ data: TripRow | null; error: PgError | null }>;
}

export type TripErrorKind = 'invalid' | 'network' | 'forbidden' | 'auth' | 'profile' | 'setup' | 'unknown';

export class TripError extends Error {
  constructor(
    public readonly kind: TripErrorKind,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'TripError';
  }
}

// Which form field each database rule belongs to, so a server-side rejection lands next to the right input.
const CONSTRAINT_FIELDS: { match: string; field: string; message: string }[] = [
  { match: 'trips_dates_order', field: 'endDate', message: 'The end date must be on or after the start date' },
  { match: 'trips_name_length', field: 'name', message: 'Enter a trip name of up to 100 characters' },
  { match: 'trips_destination_length', field: 'destination', message: 'Enter a destination of up to 100 characters' },
  { match: 'trips_description_length', field: 'description', message: 'The description can be at most 500 characters' },
  { match: 'trips_budget_nonnegative', field: 'budget', message: 'The budget cannot be negative' },
  { match: 'trips_currency_format', field: 'currency', message: 'Choose a currency from the list' },
];

const NETWORK_MESSAGE = "Can't reach the server. Check your internet connection and try again.";
const SETUP_MESSAGE = "Trips aren't set up on the server yet. The database update for trips still needs to be applied.";

function toTripError(error: PgError): TripError {
  const text = error.message ?? '';
  const code = error.code ?? '';

  if (code === '28000' || text.includes('not_authenticated')) return new TripError('auth', 'Please sign in again to continue.');
  if (text.includes('profile_missing')) return new TripError('profile', "We couldn't find your profile. Try signing out and back in.");
  // PGRST202 / PGRST205 / 42883 / 42P01 = the function or table does not exist (migration not applied)
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(code)) return new TripError('setup', SETUP_MESSAGE);
  if (code === '42501') return new TripError('forbidden', "You don't have permission to do that.");
  if (code === '23514' || code === '23502') {
    const hit = CONSTRAINT_FIELDS.find((c) => text.includes(c.match));
    if (hit) return new TripError('invalid', 'Please fix the highlighted field.', { [hit.field]: hit.message });
    return new TripError('invalid', 'Some details are not allowed. Please check them and try again.');
  }
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(text)) return new TripError('network', NETWORK_MESSAGE);
  return new TripError('unknown', 'Something went wrong. Please try again.');
}

function fromThrown(e: unknown): TripError {
  return toTripError({ message: e instanceof Error ? e.message : '' });
}

/** Every trip the signed-in user is an active member of (the database hides all others). */
export async function listTrips(client: TripsClient): Promise<Trip[]> {
  let reply: Awaited<ReturnType<ReturnType<ReturnType<TripsClient['from']>['select']>['order']>>;
  try {
    // "members:trip_members(id,status)" also fetches who is on each trip, so cards can show a head-count.
    reply = await client.from('trips').select('*, members:trip_members(id, status)').order('start_date', { ascending: false });
  } catch (e) {
    throw fromThrown(e);
  }
  if (reply.error) throw toTripError(reply.error);
  return (reply.data ?? []).map(tripFromRow);
}

/** Validates the form, then asks the database to create the trip (the caller becomes its administrator). */
export async function createTrip(client: TripsClient, input: unknown): Promise<Trip> {
  const v = validate(TripCreateSchema, input);
  if (!v.ok) throw new TripError('invalid', 'Please fix the highlighted fields.', v.errors);

  let reply: Awaited<ReturnType<TripsClient['rpc']>>;
  try {
    reply = await client.rpc('create_trip', createTripRpcArgs(v.data));
  } catch (e) {
    throw fromThrown(e);
  }
  if (reply.error) throw toTripError(reply.error);
  if (!reply.data) throw new TripError('unknown', 'Something went wrong. Please try again.');
  return tripFromRow(reply.data);
}
