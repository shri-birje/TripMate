import {
  isValidTripId,
  setTripArchivedRpcArgs,
  tripFromRow,
  updateTripRpcArgs,
  validateTripEdit,
  type Trip,
  type TripFormValues,
  type TripRow,
} from '@tripmate/core';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';

/**
 * Editing, archiving and restoring a trip.
 *
 * WHO MAY DO THIS is decided by the database: update_trip() and set_trip_archived()
 * check, inside one transaction, that the caller is an ACTIVE ADMINISTRATOR, that the
 * trip is not archived (for edits), and that the caller is working from the latest
 * version. This code adds validation and friendly messages; it is not the only line of defence.
 *
 * `TripEditClient` describes only the slice of Supabase's client we use, so tests can supply a fake.
 */
interface PgError {
  code?: string | undefined;
  message?: string | undefined;
}

export interface TripEditClient {
  rpc(fn: 'update_trip' | 'set_trip_archived', args: Record<string, unknown>): PromiseLike<{ data: TripRow | null; error: PgError | null }>;
}

export type TripEditErrorKind =
  | 'invalid' // the details are not allowed (fields are highlighted)
  | 'conflict' // someone else changed the trip first
  | 'not_admin' // a member who is not an administrator
  | 'archived' // the trip is archived (read-only)
  | 'unavailable' // not on the trip / no such trip: the single combined answer
  | 'auth' // sign in again
  | 'network' // connection problem: offer Try again
  | 'setup' // the database update has not been applied
  | 'unknown';

export const CONFLICT_MESSAGE = 'This trip was changed by someone else. Reload to see the latest, then try again.';
export const NOT_ADMIN_MESSAGE = 'Only trip admins can do that.';
export const ARCHIVED_MESSAGE = 'This trip is archived. Restore it to make changes.';
const AUTH_MESSAGE = 'Please sign in again to continue.';
const NETWORK_MESSAGE = "Can't reach the server. Check your internet connection and try again.";
const SETUP_MESSAGE = "Editing trips isn't set up on the server yet. The database update for trip editing still needs to be applied.";
const UNKNOWN_MESSAGE = 'Something went wrong. Please try again.';

export class TripEditError extends Error {
  constructor(
    public readonly kind: TripEditErrorKind,
    message: string,
    public readonly fieldErrors?: Record<string, string>,
  ) {
    super(message);
    this.name = 'TripEditError';
  }
}

// Which form field each database rule belongs to, so a rejection lands next to the right input.
const CONSTRAINT_FIELDS: { match: string; field: string; message: string }[] = [
  { match: 'trips_dates_order', field: 'endDate', message: 'The end date must be on or after the start date' },
  { match: 'trips_name_length', field: 'name', message: 'Enter a trip name of up to 100 characters' },
  { match: 'trips_destination_length', field: 'destination', message: 'Enter a destination of up to 100 characters' },
  { match: 'trips_description_length', field: 'description', message: 'The description can be at most 500 characters' },
  { match: 'trips_budget_nonnegative', field: 'budget', message: 'The budget cannot be negative' },
];

function toError(error: PgError): TripEditError {
  const code = error.code ?? '';
  const text = error.message ?? '';
  // The database's own tokens first (they are exact), then generic codes.
  if (text.includes('trip_not_found')) return new TripEditError('unavailable', UNAVAILABLE_MESSAGE);
  if (text.includes('not_admin')) return new TripEditError('not_admin', NOT_ADMIN_MESSAGE);
  if (text.includes('trip_archived')) return new TripEditError('archived', ARCHIVED_MESSAGE);
  if (text.includes('version_conflict')) return new TripEditError('conflict', CONFLICT_MESSAGE);
  if (code === '28000' || text.includes('not_authenticated') || code === '42501') return new TripEditError('auth', AUTH_MESSAGE);
  if (['PGRST202', '42883'].includes(code)) return new TripEditError('setup', SETUP_MESSAGE);
  if (code === '23514' || code === '23502') {
    const hit = CONSTRAINT_FIELDS.find((c) => text.includes(c.match));
    if (hit) return new TripEditError('invalid', 'Please fix the highlighted field.', { [hit.field]: hit.message });
    return new TripEditError('invalid', 'Some details are not allowed. Please check them and try again.');
  }
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(text)) return new TripEditError('network', NETWORK_MESSAGE);
  return new TripEditError('unknown', UNKNOWN_MESSAGE); // raw database text is never shown
}

const fromThrown = (e: unknown) => toError({ message: e instanceof Error ? e.message : '' });
const validVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

export interface UpdateTripVars {
  tripId: string;
  /** The version the person STARTED editing from (not the latest one). The database refuses the edit if the trip has moved on. */
  expectedVersion: number;
  /** The trip's own currency (never changed; only used so the shared rules can check the form). */
  currency: string;
  form: TripFormValues;
}

export async function updateTrip(client: TripEditClient, vars: UpdateTripVars): Promise<Trip> {
  if (!isValidTripId(vars.tripId)) throw new TripEditError('unavailable', UNAVAILABLE_MESSAGE);
  if (!validVersion(vars.expectedVersion)) throw new TripEditError('unknown', UNKNOWN_MESSAGE);

  const v = validateTripEdit(vars.form, vars.currency);
  if (!v.ok) throw new TripEditError('invalid', 'Please fix the highlighted fields.', v.errors);

  let reply: Awaited<ReturnType<TripEditClient['rpc']>>;
  try {
    reply = await client.rpc('update_trip', updateTripRpcArgs(vars.tripId, vars.expectedVersion, v.data));
  } catch (e) {
    throw fromThrown(e);
  }
  if (reply.error) throw toError(reply.error);
  if (!reply.data) throw new TripEditError('unknown', UNKNOWN_MESSAGE);
  return tripFromRow(reply.data);
}

export interface SetArchivedVars {
  tripId: string;
  archived: boolean;
  expectedVersion: number;
}

/** Archives (archived = true) or restores (false) a trip. Safe to repeat. */
export async function setTripArchived(client: TripEditClient, vars: SetArchivedVars): Promise<Trip> {
  if (!isValidTripId(vars.tripId)) throw new TripEditError('unavailable', UNAVAILABLE_MESSAGE);
  if (!validVersion(vars.expectedVersion) || typeof vars.archived !== 'boolean') throw new TripEditError('unknown', UNKNOWN_MESSAGE);

  let reply: Awaited<ReturnType<TripEditClient['rpc']>>;
  try {
    reply = await client.rpc('set_trip_archived', setTripArchivedRpcArgs(vars.tripId, vars.archived, vars.expectedVersion));
  } catch (e) {
    throw fromThrown(e);
  }
  if (reply.error) throw toError(reply.error);
  if (!reply.data) throw new TripEditError('unknown', UNKNOWN_MESSAGE);
  return tripFromRow(reply.data);
}
