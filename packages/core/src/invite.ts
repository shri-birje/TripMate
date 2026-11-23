/**
 * Rules and helpers for invitation links and join requests (M3.5, approval-based, ADR-059).
 *
 * THE DATABASE IS THE AUTHORITY. Who may create or cancel a link, whether a link is still usable, who may
 * approve a request and every membership rule are enforced inside the database functions. These helpers only
 * shape what is sent and shown, and give friendly checks before a request is made.
 *
 * Using a link NEVER makes anyone a member: it creates a pending request, and only an administrator's approval
 * adds the person.
 *
 * SECRECY: an invitation token is a secret until the link is replaced or expires. It is shown to the
 * administrator once, when the link is created, and is never put into error text, messages or logs by anything
 * in this file.
 */
export const INVITE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export const MIN_EXPIRY_HOURS = 1;
export const DEFAULT_EXPIRY_HOURS = 168; // 7 days
export const MAX_EXPIRY_HOURS = 720; // 30 days
export const MAX_PENDING_REQUESTS = 50;

/** The choices offered to an administrator (the database allows anything between the minimum and maximum). */
export const EXPIRY_CHOICES = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: DEFAULT_EXPIRY_HOURS },
  { label: '30 days', hours: MAX_EXPIRY_HOURS },
] as const;

export const isInviteToken = (value: unknown): value is string => typeof value === 'string' && INVITE_TOKEN_PATTERN.test(value);

/** The address people open: `<origin>/join/<token>`. */
export const inviteLink = (origin: string, token: string): string => `${origin.replace(/\/+$/, '')}/join/${token}`;

/**
 * Finds the token in what a person pasted or opened: the bare 64-character code, or a link ending in /join/<code>
 * (a query string or fragment is ignored). Returns null if there is no valid token. Never throws.
 */
export function tokenFromInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (isInviteToken(text)) return text;
  const match = /\/join\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(text);
  return match && isInviteToken(match[1]) ? match[1] : null;
}

export interface InviteOptions {
  hours: number;
  /** The guest this link is for, or null for the trip's general link. */
  claimMemberId: string | null;
}

export type OptionsCheck = { ok: true; value: InviteOptions } | { ok: false; message: string };

export function validateInviteOptions(options: InviteOptions): OptionsCheck {
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
  if (!whole(options.hours) || options.hours < MIN_EXPIRY_HOURS || options.hours > MAX_EXPIRY_HOURS) {
    return { ok: false, message: 'Choose how long the link should last: from 1 hour to 30 days.' };
  }
  return { ok: true, value: options };
}

// ---- the exact arguments each database function takes (names must match the SQL) ----
export const createInviteRpcArgs = (tripId: string, o: InviteOptions) => ({
  p_trip_id: tripId,
  p_claim_member_id: o.claimMemberId,
  p_expires_in_hours: o.hours,
});
export const getGeneralInviteLinkRpcArgs = (tripId: string) => ({ p_trip_id: tripId });
export const listInvitesRpcArgs = (tripId: string) => ({ p_trip_id: tripId });
export const revokeInviteRpcArgs = (tripId: string, inviteId: string) => ({ p_trip_id: tripId, p_invite_id: inviteId });
export const previewInviteRpcArgs = (token: string) => ({ p_token: token });
export const requestToJoinRpcArgs = (token: string) => ({ p_token: token });
export const listJoinRequestsRpcArgs = (tripId: string) => ({ p_trip_id: tripId });
export const decideJoinRequestRpcArgs = (tripId: string, requestId: string, approve: boolean) => ({
  p_trip_id: tripId,
  p_request_id: requestId,
  p_approve: approve,
});

// ---- links, as the database sends them back ----
export type InviteStatus = 'active' | 'used' | 'expired' | 'revoked';

/** One row of list_trip_invites(): never a token, never a hash. */
export interface InviteRow {
  invite_id: string;
  claim_member_id: string | null;
  claim_name: string | null;
  created_by_name: string;
  expires_at: string;
  use_count: number;
  revoked_at: string | null;
  created_at: string;
  status: string;
  /** True only for the live general link whose token is kept (encrypted) so an admin can copy it again. */
  copyable?: boolean;
}

export interface Invite {
  id: string;
  /** The guest the link is for, or null for the trip's general link. */
  claimName: string | null;
  createdByName: string;
  expiresAt: string;
  /** When the link was made (an ISO moment); shown to the administrator in their own time zone. */
  createdAt: string;
  /** How many join requests were made with it. */
  requestCount: number;
  status: InviteStatus;
  /** The admin can copy this link again (the live general link made after the reusable-link update). */
  copyable: boolean;
}

const STATUSES: readonly string[] = ['active', 'used', 'expired', 'revoked'];

export function inviteFromRow(row: InviteRow): Invite {
  return {
    id: row.invite_id,
    claimName: row.claim_name,
    createdByName: row.created_by_name,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    requestCount: row.use_count,
    status: (STATUSES.includes(row.status) ? row.status : 'expired') as InviteStatus, // anything unknown is treated as unusable
    copyable: row.copyable === true && row.claim_member_id === null && row.status === 'active',
  };
}

/** The live general link of a trip, if there is one that has not been cancelled (it may have expired). */
export function currentGeneralInvite(invites: readonly Invite[]): Invite | null {
  return invites.find((i) => i.claimName === null && (i.status === 'active' || i.status === 'expired')) ?? null;
}

/** The live general link that can be copied, or null (none, expired, revoked, made before reusable links, or a friend's link). */
export function copyableGeneralInvite(invites: readonly Invite[]): Invite | null {
  return invites.find((i) => i.claimName === null && i.status === 'active' && i.copyable) ?? null;
}

/** One row of preview_invite(): the few public facts shown before signing in. */
export interface InvitePreviewRow {
  trip_name: string;
  destination: string;
  start_date: string;
  end_date: string;
  inviter_name: string;
  member_count: number;
  is_claim: boolean;
  claim_name: string | null;
}

export interface InvitePreview {
  tripName: string;
  destination: string;
  startDate: string;
  endDate: string;
  inviterName: string;
  memberCount: number;
  /** The friend this link was made for, or null for the general link. */
  claimName: string | null;
}

export function previewFromRow(row: InvitePreviewRow): InvitePreview {
  return {
    tripName: row.trip_name,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    inviterName: row.inviter_name,
    memberCount: row.member_count,
    claimName: row.is_claim ? row.claim_name : null,
  };
}

// ---- join requests, as the database sends them back ----
/** One row of list_join_requests(): a name and a time, never a user id. */
export interface JoinRequestRow {
  request_id: string;
  requester_name: string;
  claim_member_id: string | null;
  claim_name: string | null;
  created_at: string;
}

export interface JoinRequest {
  id: string;
  requesterName: string;
  /** The friend's place this person asks to take over, or null for an ordinary request to join. */
  claimName: string | null;
  createdAt: string;
}

export function joinRequestFromRow(row: JoinRequestRow): JoinRequest {
  return { id: row.request_id, requesterName: row.requester_name, claimName: row.claim_member_id !== null ? row.claim_name : null, createdAt: row.created_at };
}

/** What an administrator is asking themselves when they press Approve. */
export function approveQuestion(r: JoinRequest): { title: string; message: string } {
  return r.claimName
    ? {
        title: `Let ${r.requesterName} take ${r.claimName}'s place?`,
        message: `${r.requesterName} will become ${r.claimName} on this trip, with everything already recorded for ${r.claimName}. Nobody else is added.`,
      }
    : {
        title: `Add ${r.requesterName} to this trip?`,
        message: `${r.requesterName} will become a member: they will see the trip and everyone on it.`,
      };
}

export function rejectQuestion(r: JoinRequest): { title: string; message: string } {
  return {
    title: `Reject ${r.requesterName}'s request?`,
    message: `${r.requesterName} will not be added${r.claimName ? ` and ${r.claimName}'s place stays as it is` : ''}. They cannot ask again with the current link; they would need a new one.`,
  };
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function localMoment(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hours = d.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hour12}:${minutes} ${hours < 12 ? 'am' : 'pm'}`;
}

/**
 * "Created 23 Nov 2026, 10:15 am": when a link was made, in the VIEWER'S own time zone, so an administrator
 * can tell links apart. An unreadable moment says so instead of failing.
 */
export function createdLabel(createdAtIso: string): string {
  const moment = localMoment(createdAtIso);
  return moment ? `Created ${moment}` : 'Created at an unknown time';
}

/** "Asked 23 Nov 2026, 10:15 am", in the viewer's own time zone. */
export function askedLabel(createdAtIso: string): string {
  const moment = localMoment(createdAtIso);
  return moment ? `Asked ${moment}` : 'Asked at an unknown time';
}

/** "Expires in 6 days", "Expires in 3 hours", "Expires in less than an hour" or "Expired". `nowMs` is passed in so this is testable. */
export function expiresInLabel(expiresAtIso: string, nowMs: number): string {
  const at = Date.parse(expiresAtIso);
  if (Number.isNaN(at)) return 'Expired';
  const ms = at - nowMs;
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'Expires in less than an hour';
  if (hours < 24) return `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.max(1, Math.round(ms / 86_400_000)); // nearest day: a link made a moment ago for 7 days reads "7 days"
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * One line describing a link:
 *   "Invitation link · 3 requests so far · Expires in 6 days"
 *   "For Gita · No request yet · Expires in 6 days"
 */
export function inviteSummary(invite: Invite, nowMs: number): string {
  const state =
    invite.status === 'revoked' ? 'Cancelled' : invite.status === 'used' ? 'Used' : invite.status === 'expired' ? 'Expired' : expiresInLabel(invite.expiresAt, nowMs);
  if (invite.claimName) return `For ${invite.claimName} · ${invite.requestCount > 0 ? 'A request was made' : 'No request yet'} · ${state}`;
  const asked = invite.requestCount === 0 ? 'No requests yet' : `${invite.requestCount} ${invite.requestCount === 1 ? 'request' : 'requests'} so far`;
  return `Invitation link · ${asked} · ${state}`;
}
