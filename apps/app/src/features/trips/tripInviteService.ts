import {
  createInviteRpcArgs,
  decideJoinRequestRpcArgs,
  getGeneralInviteLinkRpcArgs,
  inviteFromRow,
  isInviteToken,
  isValidTripId,
  joinRequestFromRow,
  listInvitesRpcArgs,
  listJoinRequestsRpcArgs,
  previewFromRow,
  previewInviteRpcArgs,
  requestToJoinRpcArgs,
  revokeInviteRpcArgs,
  validateInviteOptions,
  type Invite,
  type InviteOptions,
  type InvitePreview,
  type InvitePreviewRow,
  type InviteRow,
  type JoinRequest,
  type JoinRequestRow,
} from '@tripmate/core';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';

/**
 * Invitation links and join requests (approval-based joining, ADR-059).
 *
 *   administrators: make or REPLACE the trip's link (or a friend's claim link), cancel links, see and decide
 *                   join requests;
 *   anyone:         preview a link (even signed out);
 *   signed in:      ask to join with a link. This NEVER makes anyone a member: only an administrator's
 *                   approval does.
 *
 * WHO MAY DO WHAT is decided by the database, inside one transaction with the trip locked. This code adds
 * friendly checks and messages; it is NOT the only line of defence.
 *
 * SECRECY: an invitation token is a secret. Every message below is a fixed sentence: no error, message or value
 * produced here ever contains a token, whatever the database says. Nothing here logs anything.
 *
 * `TripInviteClient` describes only the slice of Supabase's client we use, so tests can supply a fake.
 */
interface PgError {
  code?: string | undefined;
  message?: string | undefined;
}

export type InviteFunction =
  | 'create_invite'
  | 'get_general_invite_link'
  | 'list_trip_invites'
  | 'revoke_invite'
  | 'preview_invite'
  | 'request_to_join'
  | 'list_join_requests'
  | 'decide_join_request';

export interface TripInviteClient {
  rpc(fn: InviteFunction, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: PgError | null }>;
}

export type TripInviteErrorKind =
  | 'invite_exists' // a valid general link already exists: copy it instead
  | 'invalid_link' // unknown, malformed, expired, replaced, cancelled, or the trip is archived: ONE answer for all
  | 'request_used' // this account already used this link (asked, and was answered or has left since)
  | 'claim_pending' // someone else is already waiting to take that friend's place
  | 'claim_conflict' // they were on the trip before and cannot take a friend's place
  | 'claim_unavailable' // the friend's place is gone or already taken
  | 'too_many' // 50 requests are already waiting
  | 'full' // the trip already has 50 people (an approval is refused)
  | 'requester_unavailable' // the person's account is no longer available (an approval is refused)
  | 'not_admin' // a member who is not an administrator
  | 'archived' // the trip is archived (no changes until it is restored)
  | 'unavailable' // not on the trip / no such trip: the single combined answer
  | 'invalid' // the options are not allowed
  | 'not_found' // that friend, link or request is gone
  | 'not_a_guest' // that person has an account already
  | 'profile' // the signed-in account has no profile
  | 'auth' // sign in again
  | 'network' // connection problem: offer Try again
  | 'setup' // the database update has not been applied
  | 'unknown';

export const INVITE_MESSAGES = {
  invite_exists: 'This trip already has an active invitation link. Use Copy link to share it, or revoke it first to make a new one.',
  invalid_link: "This invite link isn't valid. It may have expired, been replaced, or been cancelled. Ask the person who invited you for the current link.",
  request_used: "You've already asked to join with this link. If it wasn't accepted, ask an admin for their new link.",
  claim_pending: 'Someone has already asked to take this place. Ask the admin to check the trip.',
  claim_conflict: 'You were on this trip before, so you cannot take over a friend’s place. Ask an admin for the trip’s general invite link instead.',
  claim_conflict_admin: 'This person was on the trip before, so they cannot take over a friend’s place. Reject the request and send them the trip’s general link.',
  claim_unavailable: 'That friend’s place is no longer available to take over. You can reject this request.',
  too_many: 'This trip already has 50 requests waiting. Ask an admin to answer some of them first.',
  full: 'This trip already has 50 people, the most it can have. Remove someone, then approve again.',
  requester_unavailable: 'This person’s account is no longer available, so they cannot be added. You can reject the request.',
  not_admin: 'Only trip admins can do that.',
  archived: 'This trip is archived. Restore it to change invitations or answer requests.',
  invalid: 'Please check the invite options and try again.',
  not_found: 'That invite, friend or request is no longer there. Reload to see the latest.',
  not_a_guest: 'That person already has an account, so there is nothing to claim.',
  profile: 'Please finish setting up your profile before asking to join.',
  auth: 'Please sign in again to continue.',
  network: "Can't reach the server. Check your internet connection and try again.",
  setup: "Invitations aren't set up on the server yet. The database update for invitations still needs to be applied.",
  unknown: 'Something went wrong. Please try again.',
} as const;

export class TripInviteError extends Error {
  constructor(
    public readonly kind: TripInviteErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TripInviteError';
  }
}

/** The database's own words first (exact), then generic codes. Only fixed sentences are ever used; raw text is never passed on. */
function toError(error: PgError, fn?: InviteFunction): TripInviteError {
  const code = error.code ?? '';
  const text = error.message ?? '';
  const E = (kind: TripInviteErrorKind, message: string) => new TripInviteError(kind, message);
  if (text.includes('invite_exists')) return E('invite_exists', INVITE_MESSAGES.invite_exists);
  if (text.includes('invite_invalid')) return E('invalid_link', INVITE_MESSAGES.invalid_link);
  if (text.includes('trip_not_found')) return E('unavailable', UNAVAILABLE_MESSAGE);
  if (text.includes('not_admin')) return E('not_admin', INVITE_MESSAGES.not_admin);
  if (text.includes('trip_archived')) return E('archived', INVITE_MESSAGES.archived);
  if (text.includes('request_used')) return E('request_used', INVITE_MESSAGES.request_used);
  if (text.includes('claim_pending')) return E('claim_pending', INVITE_MESSAGES.claim_pending);
  if (text.includes('claim_conflict')) return E('claim_conflict', fn === 'decide_join_request' ? INVITE_MESSAGES.claim_conflict_admin : INVITE_MESSAGES.claim_conflict);
  if (text.includes('claim_unavailable')) return E('claim_unavailable', INVITE_MESSAGES.claim_unavailable);
  if (text.includes('too_many_requests')) return E('too_many', INVITE_MESSAGES.too_many);
  if (text.includes('trip_full')) return E('full', INVITE_MESSAGES.full);
  if (text.includes('requester_unavailable')) return E('requester_unavailable', INVITE_MESSAGES.requester_unavailable);
  if (text.includes('profile_missing')) return E('profile', INVITE_MESSAGES.profile);
  if (text.includes('not_a_guest')) return E('not_a_guest', INVITE_MESSAGES.not_a_guest);
  if (text.includes('member_not_found') || text.includes('invite_not_found') || text.includes('request_not_found')) return E('not_found', INVITE_MESSAGES.not_found);
  if (text.includes('invalid_request') || code === '23514' || code === '23502') return E('invalid', INVITE_MESSAGES.invalid);
  if (code === '28000' || text.includes('not_authenticated') || code === '42501') return E('auth', INVITE_MESSAGES.auth);
  if (['PGRST202', '42883'].includes(code)) return E('setup', INVITE_MESSAGES.setup);
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(text)) return E('network', INVITE_MESSAGES.network);
  return E('unknown', INVITE_MESSAGES.unknown);
}

async function call(client: TripInviteClient, fn: InviteFunction, args: Record<string, unknown>): Promise<unknown[]> {
  let reply: Awaited<ReturnType<TripInviteClient['rpc']>>;
  try {
    reply = await client.rpc(fn, args);
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' }, fn);
  }
  if (reply.error) throw toError(reply.error, fn);
  if (reply.data === null || reply.data === undefined) return [];
  return Array.isArray(reply.data) ? reply.data : [reply.data];
}

const unknown = () => new TripInviteError('unknown', INVITE_MESSAGES.unknown);
const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);
const badTrip = () => new TripInviteError('unavailable', UNAVAILABLE_MESSAGE);
const badId = () => new TripInviteError('not_found', INVITE_MESSAGES.not_found);

export interface CreatedInvite {
  inviteId: string;
  /** The secret token. Shown to the administrator ONCE and never stored or returned again. */
  token: string;
  expiresAt: string;
}

export interface CreateInviteVars {
  tripId: string;
  options: InviteOptions;
}

/** Makes the trip's general link (refused while a valid one exists) or a friend's claim link (replaces that friend's previous one). */
export async function createInvite(client: TripInviteClient, vars: CreateInviteVars): Promise<CreatedInvite> {
  if (!isValidTripId(vars.tripId)) throw badTrip();
  const options = validateInviteOptions(vars.options);
  if (!options.ok) throw new TripInviteError('invalid', options.message);
  if (options.value.claimMemberId !== null && !isValidTripId(options.value.claimMemberId)) throw badId();

  const row = asRecord((await call(client, 'create_invite', createInviteRpcArgs(vars.tripId, options.value)))[0]);
  if (!row || typeof row.invite_id !== 'string' || !isInviteToken(row.token) || typeof row.expires_at !== 'string') throw unknown();
  return { inviteId: row.invite_id, token: row.token, expiresAt: row.expires_at };
}

export interface GeneralLink {
  /** The link's secret token: the SAME one every time while the link is live. Held in memory only, never logged. */
  token: string;
  expiresAt: string;
}

/**
 * Copy link: asks the database for the live general link's original token. Only an active administrator gets
 * it (the database decides); anyone else, or a link that is gone / expired / revoked / made before reusable
 * links, gets nothing, which is shown as "no link to copy".
 */
export async function getGeneralInviteLink(client: TripInviteClient, tripId: string): Promise<GeneralLink | null> {
  if (!isValidTripId(tripId)) throw badTrip();
  const row = asRecord((await call(client, 'get_general_invite_link', getGeneralInviteLinkRpcArgs(tripId)))[0]);
  if (!row) return null;
  if (!isInviteToken(row.token) || typeof row.expires_at !== 'string') throw unknown();
  return { token: row.token, expiresAt: row.expires_at };
}

export async function listInvites(client: TripInviteClient, tripId: string): Promise<Invite[]> {
  if (!isValidTripId(tripId)) throw badTrip();
  const rows = await call(client, 'list_trip_invites', listInvitesRpcArgs(tripId));
  return rows.map((r) => inviteFromRow(r as InviteRow));
}

export interface RevokeVars {
  tripId: string;
  inviteId: string;
}

/** Cancels a link. Requests already made with it stay for an administrator to decide. */
export async function revokeInvite(client: TripInviteClient, vars: RevokeVars): Promise<{ inviteId: string; changed: boolean }> {
  if (!isValidTripId(vars.tripId)) throw badTrip();
  if (!isValidTripId(vars.inviteId)) throw badId();
  const row = asRecord((await call(client, 'revoke_invite', revokeInviteRpcArgs(vars.tripId, vars.inviteId)))[0]);
  if (!row || typeof row.invite_id !== 'string') throw unknown();
  return { inviteId: row.invite_id, changed: row.changed === true };
}

/**
 * What a link is for, before anyone signs in. A malformed token is refused without contacting the server, and
 * an empty answer (unknown, expired, replaced, cancelled, archived trip) is the SAME "not valid" error.
 */
export async function previewInvite(client: TripInviteClient, token: unknown): Promise<InvitePreview> {
  if (!isInviteToken(token)) throw new TripInviteError('invalid_link', INVITE_MESSAGES.invalid_link);
  const rows = await call(client, 'preview_invite', previewInviteRpcArgs(token));
  const row = asRecord(rows[0]);
  if (!row) throw new TripInviteError('invalid_link', INVITE_MESSAGES.invalid_link);
  return previewFromRow(row as unknown as InvitePreviewRow);
}

export type RequestOutcome = 'requested' | 'already_requested' | 'already_member';

export interface RequestResult {
  tripId: string;
  /** The request's id; empty when the person is already a member (no request is made). */
  requestId: string | null;
  outcome: RequestOutcome;
}

const REQUEST_OUTCOMES: readonly string[] = ['requested', 'already_requested', 'already_member'];

/** Asks to join the trip (or to take a friend's place). The person does NOT become a member: an administrator must approve. */
export async function requestToJoin(client: TripInviteClient, token: unknown): Promise<RequestResult> {
  if (!isInviteToken(token)) throw new TripInviteError('invalid_link', INVITE_MESSAGES.invalid_link);
  const row = asRecord((await call(client, 'request_to_join', requestToJoinRpcArgs(token)))[0]);
  if (!row || typeof row.trip_id !== 'string' || typeof row.outcome !== 'string' || !REQUEST_OUTCOMES.includes(row.outcome)) throw unknown();
  if (row.outcome !== 'already_member' && typeof row.request_id !== 'string') throw unknown();
  return { tripId: row.trip_id, requestId: typeof row.request_id === 'string' ? row.request_id : null, outcome: row.outcome as RequestOutcome };
}

/** The requests waiting for an administrator's decision (names and times only). */
export async function listJoinRequests(client: TripInviteClient, tripId: string): Promise<JoinRequest[]> {
  if (!isValidTripId(tripId)) throw badTrip();
  const rows = await call(client, 'list_join_requests', listJoinRequestsRpcArgs(tripId));
  return rows.map((r) => joinRequestFromRow(r as JoinRequestRow));
}

export type DecideOutcome = 'approved' | 'rejected' | 'already_decided' | 'already_member';

export interface Decided {
  requestId: string;
  outcome: DecideOutcome;
  memberId: string | null;
}

export interface DecideVars {
  tripId: string;
  requestId: string;
  approve: boolean;
}

const DECIDE_OUTCOMES: readonly string[] = ['approved', 'rejected', 'already_decided', 'already_member'];

/** An administrator approves or rejects a waiting request. Only approval adds the person. */
export async function decideJoinRequest(client: TripInviteClient, vars: DecideVars): Promise<Decided> {
  if (!isValidTripId(vars.tripId)) throw badTrip();
  if (!isValidTripId(vars.requestId)) throw badId();
  if (typeof vars.approve !== 'boolean') throw unknown();
  const row = asRecord((await call(client, 'decide_join_request', decideJoinRequestRpcArgs(vars.tripId, vars.requestId, vars.approve)))[0]);
  if (!row || typeof row.request_id !== 'string' || typeof row.outcome !== 'string' || !DECIDE_OUTCOMES.includes(row.outcome)) throw unknown();
  return { requestId: row.request_id, outcome: row.outcome as DecideOutcome, memberId: typeof row.member_id === 'string' ? row.member_id : null };
}
