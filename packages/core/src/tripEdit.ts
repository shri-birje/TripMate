import { SUPPORTED_CURRENCIES } from './profile';
import { TripCreateSchema, type Trip, type TripCreateInput } from './trip';
import type { TripDetails } from './tripDetails';
import { validate, type ValidationResult } from './validation';

/**
 * Rules and helpers for editing, archiving and restoring a trip.
 *
 * Editing deliberately REUSES the approved Create rules (the same schema), so a
 * trip can never be saved with details that creating it would have rejected.
 * Currency is not editable: it is passed through only so the Create rules have
 * something valid to check, and it never leaves this file.
 */

/** What an edit may change. No currency, status, creator or id. */
export type TripEditInput = Omit<TripCreateInput, 'currency'>;

/** The form's raw text, exactly as typed. */
export interface TripFormValues {
  name: string;
  destination: string;
  startDate: string; // DD/MM/YYYY while editing
  endDate: string;
  description: string;
  budget: string; // rupees as text, blank = none
}

/** Validates an edit with the same rules as Create. `tripCurrency` is the trip's own, unchanged currency. */
export function validateTripEdit(form: TripFormValues, tripCurrency: string): ValidationResult<TripEditInput> {
  // If the stored currency is not one the Create rules know, use a placeholder: it is discarded below, never saved.
  const probe = (SUPPORTED_CURRENCIES as readonly string[]).includes(tripCurrency) ? tripCurrency : 'INR';
  const result = validate(TripCreateSchema, { ...form, currency: probe });
  if (!result.ok) return result;
  const { currency: _discarded, ...rest } = result.data;
  void _discarded;
  return { ok: true, data: rest };
}

/** The exact argument names of the database function update_trip. */
export function updateTripRpcArgs(tripId: string, expectedVersion: number, edit: TripEditInput) {
  return {
    p_trip_id: tripId,
    p_expected_version: expectedVersion,
    p_name: edit.name,
    p_destination: edit.destination,
    p_start_date: edit.startDate,
    p_end_date: edit.endDate,
    p_description: edit.description,
    p_budget_minor: edit.budgetMinor,
  };
}

/** The exact argument names of the database function set_trip_archived. */
export function setTripArchivedRpcArgs(tripId: string, archived: boolean, expectedVersion: number) {
  return { p_trip_id: tripId, p_archived: archived, p_expected_version: expectedVersion };
}

/** "2026-12-27" -> "27/12/2026" (how dates are typed in India). Anything unreadable gives "". */
export function isoToDmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** Paise to the text a person would type: 6000000 -> "60000", 123450 -> "1234.50". Exact, no floating point. */
export function minorToInput(minor: number): string {
  const whole = Math.floor(minor / 100);
  const paise = minor % 100;
  return paise === 0 ? String(whole) : `${whole}.${String(paise).padStart(2, '0')}`;
}

/** The edit form's starting values for a trip. */
export function tripToFormValues(trip: Trip): TripFormValues {
  return {
    name: trip.name,
    destination: trip.destination,
    startDate: isoToDmy(trip.startDate),
    endDate: isoToDmy(trip.endDate),
    description: trip.description ?? '',
    budget: trip.budgetMinor !== null ? minorToInput(trip.budgetMinor) : '',
  };
}

/** True if the person viewing a trip is one of its CURRENT administrators. (Screens use this to show or hide buttons; the database enforces it.) */
export function isTripAdmin(details: TripDetails, userId: string | null): boolean {
  return userId !== null && details.members.some((m) => m.userId === userId && m.role === 'admin');
}

/** Archived trips, most recent first. These are the trips Home shows in its collapsed "Archived" section. */
export function archivedTrips(trips: readonly Trip[]): Trip[] {
  return trips
    .filter((t) => t.status === 'archived')
    .sort((a, b) => b.startDate.localeCompare(a.startDate) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
