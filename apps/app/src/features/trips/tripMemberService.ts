import {
  MAX_ACTIVE_PEOPLE,
  NAME_TAKEN_MESSAGE,
  addGuestRpcArgs,
  isValidTripId,
  leaveTripRpcArgs,
  removeMemberRpcArgs,
  renameGuestRpcArgs,
  setMemberRoleRpcArgs,
  validatePersonName,
  type MemberRole,
} from '@tripmate/core';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';

/**
 * Managing the people on a trip: add a friend, rename a friend, change a role, remove someone, leave.
 *
 * WHO MAY DO WHAT is decided by the database. Each function checks, inside one transaction with the
 * trip locked, who is calling, that they are an active member (and an administrator where needed), that the
 * trip is not archived (except for leaving), and that there is always an administrator left. This code
 * adds friendly checks and messages; it is NOT the only line of defence.
 *
 * `TripMemberClient` describes only the slice of Supabase's client we use, so tests can supply a fake.
 * No request ever carries a user id: the database learns who is calling from the login.
 */
interface PgError {
  code?: string | undefined;
  message?: string | undefined;
}

export type MemberFunction = 'add_guest_member' | 'rename_guest_member' | 'set_member_role' | 'remove_member' | 'leave_trip';

interface MemberChangeRow {
  member_id: string;
  changed: boolean;
}

export interface TripMemberClient {
  rpc(fn: MemberFunction, args: Record<string, unknown>): PromiseLike<{ data: MemberChangeRow[] | MemberChangeRow | null; error: PgError | null }>;
}

export type TripMemberErrorKind =
  | 'invalid' // the name is not allowed
  | 'name_taken' // someone on the trip already has that name
  | 'full' // 50 people already
  | 'conflict' // the person's role was changed by someone else first
  | 'last_admin' // would leave the trip without an administrator
  | 'not_admin' // a member who is not an administrator
  | 'archived' // the trip is archived (read-only)
  | 'not_found' // that person is no longer on this trip
  | 'guest_admin' // a friend without an account cannot be an administrator
  | 'repayment_pending' // M7 (D5): a pending repayment or an open correction request involves the person, so they cannot leave or be removed yet
  | 'balance' // ADR-047: the person still has a balance in the trip's expenses, so they cannot be removed or leave yet
  | 'use_leave' // an administrator cannot remove themselves
  | 'cannot_rename' // only friends added by name can be renamed
  | 'unavailable' // not on the trip / no such trip: the single combined answer
  | 'auth' // sign in again
  | 'network' // connection problem: offer Try again
  | 'setup' // the database update has not been applied
  | 'unknown';

export const MEMBER_MESSAGES = {
  invalid: 'Enter a name of up to 60 characters.',
  name_taken: NAME_TAKEN_MESSAGE,
  full: `This trip already has ${MAX_ACTIVE_PEOPLE} people. Remove someone before adding another.`,
  conflict: 'Someone else changed this person first. Reload to see the latest, then try again.',
  last_admin: 'A trip must always have at least one admin. Make someone else an admin first.',
  last_admin_leave: 'You are the only admin, so you cannot leave yet. Make someone else an admin first.',
  not_admin: 'Only trip admins can do that.',
  archived: "This trip is archived, so people can't be changed. You can still leave it.",
  not_found: 'That person is no longer on this trip. Reload to see the latest.',
  guest_admin: "A friend without an account can't be an admin.",
  balance: "This person still has a balance in the trip's expenses (they paid more or less than their share), so they can't be removed yet. Settle up, or edit or delete the expenses that involve them, until their balance is zero.",
  repayment_pending:
    "A payment (or a correction request) involving this person is still waiting for an answer, so they can't leave or be removed yet. It has to be confirmed, rejected or cancelled first.",
  balance_leave: "You still have a balance in the trip's expenses (you paid more or less than your share), so you can't leave yet. Settle up, or have the expenses that involve you edited, until your balance is zero.",
  use_leave: 'To remove yourself, use Leave trip.',
  cannot_rename: 'Only friends added by name can be renamed.',
  auth: 'Please sign in again to continue.',
  network: "Can't reach the server. Check your internet connection and try again.",
  setup: "Managing people isn't set up on the server yet. The database update for members still needs to be applied.",
  unknown: 'Something went wrong. Please try again.',
} as const;

export class TripMemberError extends Error {
  constructor(
    public readonly kind: TripMemberErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TripMemberError';
  }
}

/** The database's own words first (they are exact), then generic codes. Raw database text is never shown. */
function toError(error: PgError, fn?: MemberFunction): TripMemberError {
  const code = error.code ?? '';
  const text = error.message ?? '';
  const E = (kind: TripMemberErrorKind, message: string) => new TripMemberError(kind, message);
  if (text.includes('trip_not_found')) return E('unavailable', UNAVAILABLE_MESSAGE);
  if (text.includes('not_admin')) return E('not_admin', MEMBER_MESSAGES.not_admin);
  if (text.includes('trip_archived')) return E('archived', MEMBER_MESSAGES.archived);
  if (text.includes('member_not_found')) return E('not_found', MEMBER_MESSAGES.not_found);
  if (text.includes('member_changed')) return E('conflict', MEMBER_MESSAGES.conflict);
  if (text.includes('last_admin')) return E('last_admin', fn === 'leave_trip' ? MEMBER_MESSAGES.last_admin_leave : MEMBER_MESSAGES.last_admin);
  if (text.includes('guest_cannot_be_admin')) return E('guest_admin', MEMBER_MESSAGES.guest_admin);
  if (text.includes('name_taken')) return E('name_taken', MEMBER_MESSAGES.name_taken);
  if (text.includes('trip_full')) return E('full', MEMBER_MESSAGES.full);
  if (text.includes('repayment_pending')) return E('repayment_pending', MEMBER_MESSAGES.repayment_pending);
  if (text.includes('balance_not_settled')) return E('balance', fn === 'leave_trip' ? MEMBER_MESSAGES.balance_leave : MEMBER_MESSAGES.balance);
  if (text.includes('use_leave_instead')) return E('use_leave', MEMBER_MESSAGES.use_leave);
  if (text.includes('cannot_rename')) return E('cannot_rename', MEMBER_MESSAGES.cannot_rename);
  if (text.includes('invalid_request') || code === '23514' || code === '23502') return E('invalid', MEMBER_MESSAGES.invalid);
  if (code === '28000' || text.includes('not_authenticated') || code === '42501') return E('auth', MEMBER_MESSAGES.auth);
  if (['PGRST202', '42883'].includes(code)) return E('setup', MEMBER_MESSAGES.setup);
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(text)) return E('network', MEMBER_MESSAGES.network);
  return E('unknown', MEMBER_MESSAGES.unknown);
}

export interface MemberChange {
  memberId: string;
  /** False when the person was already as asked (a safe repeat): nothing changed. */
  changed: boolean;
}

async function call(client: TripMemberClient, fn: MemberFunction, args: Record<string, unknown>): Promise<MemberChange> {
  let reply: Awaited<ReturnType<TripMemberClient['rpc']>>;
  try {
    reply = await client.rpc(fn, args);
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' }, fn);
  }
  if (reply.error) throw toError(reply.error, fn);
  const first = Array.isArray(reply.data) ? reply.data[0] : reply.data;
  if (!first || typeof first.member_id !== 'string') throw new TripMemberError('unknown', MEMBER_MESSAGES.unknown);
  return { memberId: first.member_id, changed: first.changed === true };
}

const checkTrip = (tripId: unknown) => {
  if (!isValidTripId(tripId)) throw new TripMemberError('unavailable', UNAVAILABLE_MESSAGE);
};
const checkMember = (memberId: unknown) => {
  if (!isValidTripId(memberId)) throw new TripMemberError('not_found', MEMBER_MESSAGES.not_found);
};

function checkName(name: unknown, taken: readonly string[]): string {
  const v = validatePersonName(name, taken);
  if (!v.ok) throw new TripMemberError(v.message === NAME_TAKEN_MESSAGE ? 'name_taken' : 'invalid', v.message);
  return v.name;
}

export interface AddGuestVars {
  tripId: string;
  name: string;
  /** Names of the people currently on the trip, for a friendly "already taken" message (the database checks again). */
  taken: readonly string[];
}

export async function addGuestMember(client: TripMemberClient, vars: AddGuestVars): Promise<MemberChange> {
  checkTrip(vars.tripId);
  const name = checkName(vars.name, vars.taken);
  return call(client, 'add_guest_member', addGuestRpcArgs(vars.tripId, name));
}

export interface RenameGuestVars extends AddGuestVars {
  memberId: string;
}

export async function renameGuestMember(client: TripMemberClient, vars: RenameGuestVars): Promise<MemberChange> {
  checkTrip(vars.tripId);
  checkMember(vars.memberId);
  const name = checkName(vars.name, vars.taken);
  return call(client, 'rename_guest_member', renameGuestRpcArgs(vars.tripId, vars.memberId, name));
}

export interface SetRoleVars {
  tripId: string;
  memberId: string;
  role: MemberRole;
  /** The role the person was SEEN in, so a stale screen cannot overwrite a newer change. */
  expectedRole: MemberRole;
}

export async function setMemberRole(client: TripMemberClient, vars: SetRoleVars): Promise<MemberChange> {
  checkTrip(vars.tripId);
  checkMember(vars.memberId);
  const valid = (r: unknown): r is MemberRole => r === 'admin' || r === 'member';
  if (!valid(vars.role) || !valid(vars.expectedRole)) throw new TripMemberError('unknown', MEMBER_MESSAGES.unknown);
  return call(client, 'set_member_role', setMemberRoleRpcArgs(vars.tripId, vars.memberId, vars.role, vars.expectedRole));
}

export interface RemoveVars {
  tripId: string;
  memberId: string;
}

export async function removeMember(client: TripMemberClient, vars: RemoveVars): Promise<MemberChange> {
  checkTrip(vars.tripId);
  checkMember(vars.memberId);
  return call(client, 'remove_member', removeMemberRpcArgs(vars.tripId, vars.memberId));
}

export async function leaveTrip(client: TripMemberClient, vars: { tripId: string }): Promise<MemberChange> {
  checkTrip(vars.tripId);
  return call(client, 'leave_trip', leaveTripRpcArgs(vars.tripId));
}
