import {
  OVERRIDE_REASON_MIN,
  REVERSAL_REASON_MAX,
  REPAYMENT_NOTE_MAX,
  cancelRepaymentRpcArgs,
  checkRepaymentInput,
  cleanNote,
  confirmRepaymentRpcArgs,
  createRepaymentRpcArgs,
  decideOverrideRpcArgs,
  isRepaymentState,
  isReversalState,
  isValidTripId,
  proposeOverrideRpcArgs,
  rejectRepaymentRpcArgs,
  remindReversalRpcArgs,
  repaymentEventsFromRows,
  repaymentsFromRows,
  requestReversalRpcArgs,
  respondReversalRpcArgs,
  reversalsFromRows,
  withdrawReversalRpcArgs,
  type OverrideDecision,
  type Repayment,
  type RepaymentEvent,
  type RepaymentEventRowRecord,
  type RepaymentMethod,
  type RepaymentReversal,
  type RepaymentRowRecord,
  type RepaymentState,
  type ReversalDecision,
  type ReversalRowRecord,
  type ReversalState,
} from '@tripmate/core';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';

/**
 * Repayments and reversals: the app's service layer (M7, ADR-066; the database is migration #12).
 *
 * POSTGRESQL IS THE AUTHORITY.
 *   - Every write goes through ONE of ten database functions. This file never writes a repayment, reversal or history table: the app has
 *     no right to, and there is no client path around the database's state machine.
 *   - The app sends NO balance, NO capacity, NO "who am I": the signed-in person is taken from the login inside the database function. The
 *     only identities named are the payer and receiver of a repayment and, for a reversal made on behalf of a guest, the represented party.
 *   - Whether something may happen (who may record, confirm, reject, cancel; the guest-proxy rules; capacity; archived trips; former
 *     members; the 14-day override) is decided by the database. The friendly checks here only spare a round trip and give a clear sentence.
 *
 * IDENTITIES. Rows keep the AUTHENTICATED ACTOR (`createdBy`, `requestedBy`, `decidedBy`, an event's `actorMemberId`) apart from the
 * REPRESENTED PARTICIPANT (`requestedFor`, an event's `representedMemberId`), so a screen can say "Asha, for Gita".
 *
 * RETRIES AND STALE SCREENS
 *   - Recording a repayment and requesting a reversal: the caller makes ONE id when the form opens and sends the same id on every try. A try
 *     that fails with a connection problem has an UNKNOWN result; trying again with the same id is safe, because the database answers
 *     "already saved" (`created = false`) for the same content and never makes a second one.
 *   - Confirming, rejecting, cancelling, answering, withdrawing and deciding send the version the person was looking at. A stale one is
 *     refused ('conflict') and nothing changes. Repeating the SAME action by the SAME person with the version they last saw is a safe no-op
 *     (`changed = false`).
 *
 * SECRECY: every message below is a fixed sentence. No raw database text, id or amount from an error is put into a message (the one number
 * the database offers, the most that could be recorded, is read separately as `maxMinor`). Nothing here logs anything.
 *
 * `RepaymentClient` describes only the slice of Supabase's client we use, so tests can supply a fake.
 */
interface PgError {
  code?: string | undefined;
  message?: string | undefined;
  details?: string | undefined;
}

type Reply<T> = PromiseLike<{ data: T | null; error: PgError | null }>;

interface ReadQuery<T> extends PromiseLike<{ data: T[] | null; error: PgError | null }> {
  eq(column: string, value: string): ReadQuery<T>;
  order(column: string, options?: { ascending?: boolean }): ReadQuery<T>;
}

export type RepaymentFunction =
  | 'create_repayment'
  | 'confirm_repayment'
  | 'reject_repayment'
  | 'cancel_repayment'
  | 'request_reversal'
  | 'respond_reversal'
  | 'withdraw_reversal'
  | 'remind_reversal'
  | 'propose_override'
  | 'decide_override';

export interface RepaymentClient {
  rpc(fn: RepaymentFunction, args: Record<string, unknown>): Reply<unknown>;
  from(table: 'repayments'): { select(columns: string): ReadQuery<RepaymentRowRecord> };
  from(table: 'repayment_reversals'): { select(columns: string): ReadQuery<ReversalRowRecord> };
  from(table: 'repayment_events'): { select(columns: string): ReadQuery<RepaymentEventRowRecord> };
}

/** Exactly what is asked of each table. No "*": a column added later can never reach a screen by accident. */
export const REPAYMENT_COLUMNS = 'id, trip_id, from_member_id, to_member_id, amount_minor, method, note, status, created_by, created_at, decided_by, decided_at, decision_note, version';
export const REVERSAL_COLUMNS =
  'id, trip_id, repayment_id, status, requested_by, requested_for, requested_at, reason, override_proposed_by, override_category, override_reason, override_proposed_at, decided_by, decided_at, decision_note, is_override, version';
export const REPAYMENT_EVENT_COLUMNS = 'id, repayment_id, reversal_id, action, from_status, to_status, actor_member_id, represented_member_id, reason, acted_at';

export type RepaymentErrorKind =
  | 'invalid' // the details are not acceptable (checked here first, and by the database)
  | 'exceeds' // more than the payer still owes or the receiver is still owed (counting payments already waiting)
  | 'conflict' // someone else changed it first (stale version)
  | 'taken' // this id belongs to a DIFFERENT repayment or request: start a new one
  | 'not_found' // the repayment is gone
  | 'not_pending' // the repayment was already answered
  | 'not_confirmed' // only a confirmed repayment can have a correction requested
  | 'reversal_not_found'
  | 'reversal_not_open' // the correction request was already answered
  | 'reversal_open' // a correction is already requested for this repayment
  | 'reversal_applied' // this repayment was already corrected
  | 'reason_required' // a reason is missing or the wrong length
  | 'reminder_too_soon' // one reminder per 24 hours
  | 'override_not_eligible'
  | 'override_too_early' // the request has not been open for 14 days
  | 'override_no_evidence' // the two reminders are missing
  | 'proposer_cannot_approve' // one admin never approves their own override
  | 'party_cannot_act' // a payer, recorder, requester or other participant cannot act here
  | 'not_allowed' // not the right person for this
  | 'not_admin' // only admins
  | 'member_inactive' // someone involved has left the trip
  | 'archived' // the trip is archived (new items and reminders are refused; open ones can still be answered)
  | 'former_member' // the change would leave someone who left the trip with a balance (rule I-1)
  | 'state' // not possible in the current state
  | 'unavailable' // not on the trip / no such trip: the single combined answer
  | 'auth' // sign in again
  | 'network' // connection problem: the result of a write is UNKNOWN, retrying is safe
  | 'setup' // the database update has not been applied
  | 'unknown';

export const REPAYMENT_MESSAGES: Record<RepaymentErrorKind, string> = {
  invalid: 'Please check the payment details and try again.',
  exceeds: "That is more than can be recorded. A payment can't be more than the payer still owes or the receiver is still owed, counting payments already waiting to be confirmed.",
  conflict: 'Someone else changed this first. Reload to see the latest, then try again.',
  taken: 'This could not be saved because its id is already used by something different. Start again.',
  not_found: 'That payment is no longer there. Reload to see the latest.',
  not_pending: "This payment has already been answered, so it can't be changed now.",
  not_confirmed: 'Only a confirmed payment can have a correction requested.',
  reversal_not_found: 'That correction request is no longer there. Reload to see the latest.',
  reversal_not_open: 'This correction request has already been answered.',
  reversal_open: 'A correction is already requested for this payment.',
  reversal_applied: 'This payment has already been corrected.',
  reason_required: 'Please give a reason. An admin override needs one of at least 20 characters.',
  reminder_too_soon: 'A reminder was already sent in the last 24 hours.',
  override_not_eligible: "An admin override isn't available for this correction.",
  override_too_early: 'An admin override needs the request to have been open for at least 14 days.',
  override_no_evidence: 'Before an admin override, the requester must have sent two reminders: the first after 7 days and the second at least a day later.',
  proposer_cannot_approve: 'A different admin has to approve this override, because you proposed it.',
  party_cannot_act: "You can't do this because you are, or acted for, one of the people involved.",
  not_allowed: "You can't do this for this payment.",
  not_admin: 'Only trip admins can do that.',
  member_inactive: "Someone involved has left the trip, so a payment between them can't be recorded.",
  archived: "This trip is archived. New payments, reminders and corrections can't be started, but ones already open can still be answered.",
  former_member: "This would leave someone who has left the trip with an unsettled balance, so it can't be done.",
  state: "This can't be done in the current state of the payment.",
  unavailable: UNAVAILABLE_MESSAGE,
  auth: 'Please sign in again to continue.',
  network: "Can't reach the server. Check your internet connection and try again.",
  setup: "Payments aren't set up on the server yet. The database update for repayments still needs to be applied.",
  unknown: 'Something went wrong. Please try again.',
};

export class RepaymentError extends Error {
  constructor(
    public readonly kind: RepaymentErrorKind,
    message: string,
    /** For 'exceeds' only: the most (paise) that could have been recorded or confirmed, when the database said so. */
    public readonly maxMinor: number | null = null,
  ) {
    super(message);
    this.name = 'RepaymentError';
  }
  /** True when a WRITE may have been saved although it failed (a connection problem or an unknown failure): re-reading shows the truth. */
  get outcomeUnknown(): boolean {
    return this.kind === 'network' || this.kind === 'unknown';
  }
}

const E = (kind: RepaymentErrorKind, maxMinor: number | null = null) => new RepaymentError(kind, REPAYMENT_MESSAGES[kind], maxMinor);

/** The database's own words first (exact), then generic codes. Only fixed sentences are ever used; raw text is never passed on. */
function toError(error: PgError): RepaymentError {
  const code = error.code ?? '';
  const text = error.message ?? '';
  if (text.includes('trip_not_found')) return E('unavailable');
  if (text.includes('trip_archived')) return E('archived');
  if (text.includes('party_cannot_act')) return E('party_cannot_act');
  if (text.includes('not_admin')) return E('not_admin');
  if (text.includes('not_allowed')) return E('not_allowed');
  if (text.includes('repayment_not_found')) return E('not_found');
  if (text.includes('reversal_not_found')) return E('reversal_not_found');
  if (text.includes('repayment_id_taken') || text.includes('reversal_id_taken')) return E('taken');
  if (text.includes('repayment_exceeds_outstanding')) {
    const m = /max_minor=(\d{1,16})/.exec(error.details ?? '');
    return E('exceeds', m ? Number(m[1]) : null);
  }
  if (text.includes('member_not_active')) return E('member_inactive');
  if (text.includes('version_conflict')) return E('conflict');
  if (text.includes('repayment_not_pending')) return E('not_pending');
  if (text.includes('repayment_not_confirmed')) return E('not_confirmed');
  if (text.includes('reversal_not_open')) return E('reversal_not_open');
  if (text.includes('reversal_already_open')) return E('reversal_open');
  if (text.includes('reversal_already_applied')) return E('reversal_applied');
  if (text.includes('reversal_reason_required')) return E('reason_required');
  if (text.includes('reminder_too_soon')) return E('reminder_too_soon');
  if (text.includes('override_threshold_not_met')) return E('override_too_early');
  if (text.includes('override_evidence_missing')) return E('override_no_evidence');
  if (text.includes('override_proposer_cannot_approve')) return E('proposer_cannot_approve');
  if (text.includes('override_not_eligible')) return E('override_not_eligible');
  if (text.includes('former_member_balance') || text.includes('balance_not_settled')) return E('former_member');
  if (text.includes('repayment_transition_invalid') || text.includes('reversal_transition_invalid')) return E('state');
  if (text.includes('invalid_repayment') || ['23514', '22P02', '22003'].includes(code)) return E('invalid');
  if (code === '28000' || text.includes('not_authenticated') || code === '42501') return E('auth');
  if (['PGRST202', '42883', 'PGRST205', '42P01'].includes(code)) return E('setup');
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(text)) return E('network');
  return E('unknown');
}

async function rpc(client: RepaymentClient, fn: RepaymentFunction, args: Record<string, unknown>): Promise<unknown[]> {
  let reply: Awaited<ReturnType<RepaymentClient['rpc']>>;
  try {
    reply = await client.rpc(fn, args);
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' });
  }
  if (reply.error) throw toError(reply.error);
  if (reply.data === null || reply.data === undefined) return [];
  return Array.isArray(reply.data) ? reply.data : [reply.data];
}

async function read<T>(query: ReadQuery<T>): Promise<T[]> {
  let reply: Awaited<typeof query>;
  try {
    reply = await query;
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' });
  }
  if (reply.error) throw toError(reply.error);
  return reply.data ?? [];
}

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const badTrip = () => E('unavailable');
const validVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const lower = (id: string) => id.toLowerCase();

function checkIds(...ids: unknown[]) {
  for (const id of ids) if (!isValidTripId(id)) throw E('invalid');
}
function checkVersion(v: unknown) {
  if (!validVersion(v)) throw E('invalid');
}
/** A trimmed reason or note: empty is none. */
function trimmed(text: unknown): string | null {
  if (text === null || text === undefined) return null;
  if (typeof text !== 'string') throw E('invalid');
  const t = text.trim();
  return t === '' ? null : t;
}
function optionalNote(text: unknown): string | null {
  const t = trimmed(text);
  if (t !== null && t.length > REPAYMENT_NOTE_MAX) throw E('invalid');
  return t;
}
function requiredReason(text: unknown, min: number): string {
  const t = trimmed(text);
  if (t === null || t.length < min || t.length > REVERSAL_REASON_MAX) throw E('reason_required');
  return t;
}

// ---------------------------------------------------------------------------------------------------------------------
// Results of the writes
// ---------------------------------------------------------------------------------------------------------------------
export interface RecordedRepayment {
  repaymentId: string;
  version: number;
  status: RepaymentState;
  /** false = this exact repayment was already saved by an earlier try: nothing new was made. */
  created: boolean;
}
export interface DecidedRepayment {
  repaymentId: string;
  version: number;
  status: RepaymentState;
  /** false = it was already as asked (a safe repeat): nothing changed. */
  changed: boolean;
}
export interface RequestedReversal {
  reversalId: string;
  version: number;
  status: ReversalState;
  created: boolean;
}
export interface ChangedReversal {
  reversalId: string;
  version: number;
  status: ReversalState;
  changed: boolean;
}
export interface RemindedReversal {
  reversalId: string;
  version: number;
  status: ReversalState;
  remindedAt: string;
}

function repaymentResult(rowValue: unknown, flag: 'created'): RecordedRepayment;
function repaymentResult(rowValue: unknown, flag: 'changed'): DecidedRepayment;
function repaymentResult(rowValue: unknown, flag: 'created' | 'changed'): RecordedRepayment | DecidedRepayment {
  const row = asRecord(rowValue);
  if (!row || typeof row.repayment_id !== 'string' || !validVersion(row.version) || !isRepaymentState(row.status) || typeof row[flag] !== 'boolean') throw E('unknown');
  return flag === 'created'
    ? { repaymentId: row.repayment_id, version: row.version, status: row.status, created: row.created as boolean }
    : { repaymentId: row.repayment_id, version: row.version, status: row.status, changed: row.changed as boolean };
}

function reversalResult(rowValue: unknown, flag: 'created'): RequestedReversal;
function reversalResult(rowValue: unknown, flag: 'changed'): ChangedReversal;
function reversalResult(rowValue: unknown, flag: 'created' | 'changed'): RequestedReversal | ChangedReversal {
  const row = asRecord(rowValue);
  if (!row || typeof row.reversal_id !== 'string' || !validVersion(row.version) || !isReversalState(row.status) || typeof row[flag] !== 'boolean') throw E('unknown');
  return flag === 'created'
    ? { reversalId: row.reversal_id, version: row.version, status: row.status, created: row.created as boolean }
    : { reversalId: row.reversal_id, version: row.version, status: row.status, changed: row.changed as boolean };
}

// ---------------------------------------------------------------------------------------------------------------------
// Writes: repayments
// ---------------------------------------------------------------------------------------------------------------------
export interface RecordRepaymentVars {
  tripId: string;
  /** ONE id per new repayment, made when the form opens and reused on every retry. */
  repaymentId: string;
  /** The payer (a member id). For a guest payer the signed-in admin records on their behalf; the database checks that. */
  fromMemberId: string;
  /** The receiver (a member id). */
  toMemberId: string;
  amountMinor: number;
  method: RepaymentMethod;
  note?: string | null;
}

/** Records "X paid Y". Always created pending: it changes no balance until the receiver confirms. Safe to retry with the same id. */
export async function recordRepayment(client: RepaymentClient, vars: RecordRepaymentVars): Promise<RecordedRepayment> {
  if (!isValidTripId(vars.tripId)) throw badTrip();
  checkIds(vars.repaymentId, vars.fromMemberId, vars.toMemberId);
  const message = checkRepaymentInput({ amountMinor: vars.amountMinor, method: vars.method, note: vars.note, fromMemberId: vars.fromMemberId, toMemberId: vars.toMemberId });
  if (message !== null) throw new RepaymentError('invalid', message); // a specific, friendly sentence from the shared rules
  const note = cleanNote(vars.note);
  return repaymentResult(
    (await rpc(client, 'create_repayment', createRepaymentRpcArgs(vars.tripId, lower(vars.repaymentId), lower(vars.fromMemberId), lower(vars.toMemberId), vars.amountMinor, vars.method, note)))[0],
    'created',
  );
}

export interface RepaymentRef {
  tripId: string;
  repaymentId: string;
  /** The version the person was looking at. */
  expectedVersion: number;
}

function checkRef(ref: RepaymentRef) {
  if (!isValidTripId(ref.tripId)) throw badTrip();
  checkIds(ref.repaymentId);
  checkVersion(ref.expectedVersion);
}

/** The receiver (or an admin for a guest receiver) confirms. The database rechecks capacity against the real balances now. */
export async function confirmRepayment(client: RepaymentClient, ref: RepaymentRef): Promise<DecidedRepayment> {
  checkRef(ref);
  return repaymentResult((await rpc(client, 'confirm_repayment', confirmRepaymentRpcArgs(ref.tripId, lower(ref.repaymentId), ref.expectedVersion)))[0], 'changed');
}

/** The receiver (or an admin for a guest receiver) says it was not received. Releases what it had reserved. */
export async function rejectRepayment(client: RepaymentClient, ref: RepaymentRef & { reason?: string | null }): Promise<DecidedRepayment> {
  checkRef(ref);
  const reason = optionalNote(ref.reason);
  return repaymentResult((await rpc(client, 'reject_repayment', rejectRepaymentRpcArgs(ref.tripId, lower(ref.repaymentId), ref.expectedVersion, reason)))[0], 'changed');
}

/** The payer (or the recorder, or an eligible admin for a guest party) withdraws it while it is pending. Releases what it had reserved. */
export async function cancelRepayment(client: RepaymentClient, ref: RepaymentRef): Promise<DecidedRepayment> {
  checkRef(ref);
  return repaymentResult((await rpc(client, 'cancel_repayment', cancelRepaymentRpcArgs(ref.tripId, lower(ref.repaymentId), ref.expectedVersion)))[0], 'changed');
}

// ---------------------------------------------------------------------------------------------------------------------
// Writes: reversals and the admin override
// ---------------------------------------------------------------------------------------------------------------------
export interface RequestReversalVars {
  tripId: string;
  /** ONE id per new request, made when the form opens and reused on every retry. */
  reversalId: string;
  repaymentId: string;
  /** 1 to 200 characters. */
  reason: string;
  /**
   * The represented participant: leave it out when you act for yourself. An admin acting for a GUEST who is a party to the repayment names
   * the guest here. The database checks it is one of the two parties and that the admin is eligible; the app never says who the actor is.
   */
  requestedFor?: string | null;
}

/** Asks to reverse a CONFIRMED repayment. Changes nothing until the counterparty acknowledges (or a second admin approves an override). */
export async function requestReversal(client: RepaymentClient, vars: RequestReversalVars): Promise<RequestedReversal> {
  if (!isValidTripId(vars.tripId)) throw badTrip();
  checkIds(vars.reversalId, vars.repaymentId);
  const reason = requiredReason(vars.reason, 1);
  const forMember = vars.requestedFor ?? null;
  if (forMember !== null) checkIds(forMember);
  return reversalResult(
    (await rpc(client, 'request_reversal', requestReversalRpcArgs(vars.tripId, lower(vars.reversalId), lower(vars.repaymentId), reason, forMember === null ? null : lower(forMember))))[0],
    'created',
  );
}

export interface ReversalRef {
  tripId: string;
  reversalId: string;
  expectedVersion: number;
}

function checkReversalRef(ref: { tripId: string; reversalId: string }) {
  if (!isValidTripId(ref.tripId)) throw badTrip();
  checkIds(ref.reversalId);
}

/** The counterparty (or an eligible admin for a guest counterparty) acknowledges or declines. Acknowledging applies the reversal. */
export async function respondToReversal(client: RepaymentClient, ref: ReversalRef & { decision: ReversalDecision; note?: string | null }): Promise<ChangedReversal> {
  checkReversalRef(ref);
  checkVersion(ref.expectedVersion);
  if (ref.decision !== 'acknowledge' && ref.decision !== 'decline') throw E('invalid');
  const note = optionalNote(ref.note);
  return reversalResult((await rpc(client, 'respond_reversal', respondReversalRpcArgs(ref.tripId, lower(ref.reversalId), ref.expectedVersion, ref.decision, note)))[0], 'changed');
}

/** The requester withdraws the request (also after an override was proposed). */
export async function withdrawReversal(client: RepaymentClient, ref: ReversalRef): Promise<ChangedReversal> {
  checkReversalRef(ref);
  checkVersion(ref.expectedVersion);
  return reversalResult((await rpc(client, 'withdraw_reversal', withdrawReversalRpcArgs(ref.tripId, lower(ref.reversalId), ref.expectedVersion)))[0], 'changed');
}

/** The requester records a reminder (at most one per 24 hours). It changes no state; it is evidence for a later override. */
export async function remindAboutReversal(client: RepaymentClient, ref: { tripId: string; reversalId: string }): Promise<RemindedReversal> {
  checkReversalRef(ref);
  const row = asRecord((await rpc(client, 'remind_reversal', remindReversalRpcArgs(ref.tripId, lower(ref.reversalId))))[0]);
  if (!row || typeof row.reversal_id !== 'string' || !validVersion(row.version) || !isReversalState(row.status) || typeof row.reminded_at !== 'string') throw E('unknown');
  return { reversalId: row.reversal_id, version: row.version, status: row.status, remindedAt: row.reminded_at };
}

/**
 * An admin who took no part proposes an override of an unanswered request. The only executable category is
 * `counterparty_unresponsive` (14 days, two reminders); the category is fixed here and is never a parameter.
 */
export async function proposeOverride(client: RepaymentClient, ref: ReversalRef & { reason: string }): Promise<ChangedReversal> {
  checkReversalRef(ref);
  checkVersion(ref.expectedVersion);
  const reason = requiredReason(ref.reason, OVERRIDE_REASON_MIN);
  return reversalResult((await rpc(client, 'propose_override', proposeOverrideRpcArgs(ref.tripId, lower(ref.reversalId), ref.expectedVersion, reason)))[0], 'changed');
}

/** A SECOND independent admin approves or refuses a proposed override. The database re-evaluates everything at that moment. */
export async function decideOverride(client: RepaymentClient, ref: ReversalRef & { decision: OverrideDecision; note?: string | null }): Promise<ChangedReversal> {
  checkReversalRef(ref);
  checkVersion(ref.expectedVersion);
  if (ref.decision !== 'approve' && ref.decision !== 'refuse') throw E('invalid');
  const note = optionalNote(ref.note);
  return reversalResult((await rpc(client, 'decide_override', decideOverrideRpcArgs(ref.tripId, lower(ref.reversalId), ref.expectedVersion, ref.decision, note)))[0], 'changed');
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads (direct under row-level security: only ACTIVE members of the trip see anything)
// ---------------------------------------------------------------------------------------------------------------------

/** Every repayment of the trip, newest first, in every state. */
export async function listRepayments(client: RepaymentClient, tripId: string): Promise<Repayment[]> {
  if (!isValidTripId(tripId)) throw badTrip();
  const rows = await read(client.from('repayments').select(REPAYMENT_COLUMNS).eq('trip_id', tripId).order('created_at', { ascending: false }));
  const parsed = repaymentsFromRows(rows);
  if (parsed === null) throw E('unknown');
  return parsed;
}

/** Every reversal request of the trip, newest first, in every state. */
export async function listReversals(client: RepaymentClient, tripId: string): Promise<RepaymentReversal[]> {
  if (!isValidTripId(tripId)) throw badTrip();
  const rows = await read(client.from('repayment_reversals').select(REVERSAL_COLUMNS).eq('trip_id', tripId).order('requested_at', { ascending: false }));
  const parsed = reversalsFromRows(rows);
  if (parsed === null) throw E('unknown');
  return parsed;
}

/**
 * The history of one repayment (and its reversals), oldest first: who did what (the authenticated actor and the participant they acted
 * for, as member ids; names come from the trip's members) and when. Nothing here can change or delete an event: the app has no such right.
 */
export async function getRepaymentEvents(client: RepaymentClient, tripId: string, repaymentId: string): Promise<RepaymentEvent[]> {
  if (!isValidTripId(tripId)) throw badTrip();
  checkIds(repaymentId);
  const rows = await read(client.from('repayment_events').select(REPAYMENT_EVENT_COLUMNS).eq('trip_id', tripId).eq('repayment_id', lower(repaymentId)).order('id', { ascending: true }));
  const parsed = repaymentEventsFromRows(rows);
  if (parsed === null) throw E('unknown');
  return parsed;
}
