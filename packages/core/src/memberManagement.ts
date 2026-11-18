import type { TripDetails, TripMember } from './tripDetails';

/**
 * Rules and helpers for managing the people on a trip (M3.4).
 *
 * THE DATABASE IS THE AUTHORITY. Every rule here is enforced again inside the database functions
 * (who may act, the last administrator, archived trips, name uniqueness, the 50-person limit...).
 * These helpers exist so the screens can show only the buttons that can work and give friendly
 * messages before a request is sent; if they were wrong, the database would still refuse.
 */
export const MAX_ACTIVE_PEOPLE = 50;
export const PERSON_NAME_MAX_LENGTH = 60;

/** A name as the database stores it: with ALL surrounding whitespace removed. */
export const cleanPersonName = (raw: string): string => raw.replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '');

/** Two names are "the same person" if they match ignoring case and surrounding whitespace. */
export const samePersonName = (a: string, b: string): boolean => cleanPersonName(a).toLowerCase() === cleanPersonName(b).toLowerCase();

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

export const NAME_EMPTY_MESSAGE = 'Enter a name';
export const NAME_LONG_MESSAGE = `Names can be at most ${PERSON_NAME_MAX_LENGTH} characters`;
export const NAME_TAKEN_MESSAGE = 'Someone on this trip already has that name. Use a different name.';

/**
 * Checks a guest's name. `taken` is the names of the other people currently on the trip.
 * Only the cheap, friendly checks live here: the database makes the final decision.
 */
export function validatePersonName(raw: unknown, taken: readonly string[]): NameCheck {
  if (typeof raw !== 'string') return { ok: false, message: NAME_EMPTY_MESSAGE };
  const name = cleanPersonName(raw);
  if (name.length === 0) return { ok: false, message: NAME_EMPTY_MESSAGE };
  if (name.length > PERSON_NAME_MAX_LENGTH) return { ok: false, message: NAME_LONG_MESSAGE };
  if (taken.some((t) => samePersonName(t, name))) return { ok: false, message: NAME_TAKEN_MESSAGE };
  return { ok: true, name };
}

export type MemberRole = 'admin' | 'member';

// ---- the exact arguments each database function takes (names must match the SQL) ----
export const addGuestRpcArgs = (tripId: string, name: string) => ({ p_trip_id: tripId, p_display_name: name });
export const renameGuestRpcArgs = (tripId: string, memberId: string, name: string) => ({ p_trip_id: tripId, p_member_id: memberId, p_display_name: name });
/** `expectedRole` is the role the person was SEEN in, so a stale screen cannot overwrite a newer change. */
export const setMemberRoleRpcArgs = (tripId: string, memberId: string, role: MemberRole, expectedRole: MemberRole) => ({
  p_trip_id: tripId,
  p_member_id: memberId,
  p_role: role,
  p_expected_role: expectedRole,
});
export const removeMemberRpcArgs = (tripId: string, memberId: string) => ({ p_trip_id: tripId, p_member_id: memberId });
export const leaveTripRpcArgs = (tripId: string) => ({ p_trip_id: tripId });

// ---- what the screen may offer (convenience only) ----
const isMe = (m: TripMember, userId: string | null) => userId !== null && m.userId === userId;

/** Other signed-up administrators besides `exceptId`. A guest never counts. */
const otherAdmins = (details: TripDetails, exceptId: string) => details.members.filter((m) => m.id !== exceptId && m.role === 'admin' && m.userId !== null);

/** True for an active administrator looking at a trip that is not archived (archived trips are read-only). */
export function canManagePeople(details: TripDetails, userId: string | null): boolean {
  if (details.trip.status === 'archived') return false;
  return details.members.some((m) => isMe(m, userId) && m.role === 'admin');
}

export interface MemberActions {
  canMakeAdmin: boolean;
  canRemoveAdminRights: boolean;
  canRemove: boolean;
  canRename: boolean;
  /** Any of the above. */
  any: boolean;
}

/** Which actions to offer an administrator on one person. Nothing is offered to anyone else. */
export function memberActions(details: TripDetails, userId: string | null, member: TripMember): MemberActions {
  const manage = canManagePeople(details, userId);
  const me = isMe(member, userId);
  const canMakeAdmin = manage && member.role === 'member' && !member.isGuest;
  const canRemoveAdminRights = manage && member.role === 'admin' && otherAdmins(details, member.id).length > 0;
  const canRemove = manage && !me;
  const canRename = manage && member.isGuest;
  return { canMakeAdmin, canRemoveAdminRights, canRemove, canRename, any: canMakeAdmin || canRemoveAdminRights || canRemove || canRename };
}

export type AddState = { canAdd: true } | { canAdd: false; reason: 'not_admin' | 'archived' | 'full' };

/** Whether the "add a friend" box should be offered, and if not, why. */
export function addState(details: TripDetails, userId: string | null): AddState {
  if (!details.members.some((m) => isMe(m, userId) && m.role === 'admin')) return { canAdd: false, reason: 'not_admin' };
  if (details.trip.status === 'archived') return { canAdd: false, reason: 'archived' };
  if (details.members.length >= MAX_ACTIVE_PEOPLE) return { canAdd: false, reason: 'full' };
  return { canAdd: true };
}

export type LeaveState = { canLeave: true } | { canLeave: false; reason: 'sole_admin' | 'not_member' };

/** Whether "Leave trip" can work: the only administrator must hand over administration first. */
export function leaveState(details: TripDetails, userId: string | null): LeaveState {
  const me = details.members.find((m) => isMe(m, userId));
  if (!me) return { canLeave: false, reason: 'not_member' };
  if (me.role === 'admin' && otherAdmins(details, me.id).length === 0) return { canLeave: false, reason: 'sole_admin' };
  return { canLeave: true };
}
