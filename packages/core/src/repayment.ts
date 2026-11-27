import { newExpenseId } from './expense';
import { isRepaymentState, isReversalState, type RepaymentState, type ReversalState } from './repaymentLedger';

/**
 * Repayments and reversals: types, strict readers of what the database stores, and the argument builders for its ten functions
 * (M7, ADR-066; the database is migration #12).
 *
 * THE DATABASE IS THE AUTHORITY. These helpers only SHAPE requests, give early friendly checks for mistakes the database would also refuse,
 * and read stored rows strictly. Nothing here decides who may act, what capacity is left or what any balance is: no client-computed balance,
 * capacity, or "who I am" is ever sent. The signed-in person is always taken from the login inside the database function; the only identities
 * the app names are the PAYER and RECEIVER of a repayment and, for a reversal made on behalf of a guest, the represented party (`requestedFor`).
 *
 * THREE IDENTITIES are kept apart everywhere:
 *   - the AUTHENTICATED ACTOR: the member whose login made the call (`createdBy`, `requestedBy`, `decidedBy`, an event's `actorMemberId`);
 *   - the REPRESENTED PARTICIPANT: the party of the repayment the action was made for (`requestedFor`, an event's `representedMemberId`).
 *     For a person acting personally it equals the actor; for an admin acting for a guest it is the guest;
 *   - the COUNTERPARTY: the other party of the same repayment (always derived, never supplied).
 */

export const REPAYMENT_METHODS = ['upi', 'cash', 'bank', 'other'] as const;
export type RepaymentMethod = (typeof REPAYMENT_METHODS)[number];
export const isRepaymentMethod = (v: unknown): v is RepaymentMethod => typeof v === 'string' && (REPAYMENT_METHODS as readonly string[]).includes(v);

export const REPAYMENT_AMOUNT_MAX = 1_000_000_000_000; // paise, the database limit
export const REPAYMENT_NOTE_MAX = 200;
export const REVERSAL_REASON_MAX = 200;
export const OVERRIDE_REASON_MIN = 20;
/** The ONLY executable override category (counterparty_account_inaccessible is deferred and is not accepted anywhere). */
export const OVERRIDE_CATEGORY = 'counterparty_unresponsive';
export type OverrideCategory = typeof OVERRIDE_CATEGORY;
export type ReversalDecision = 'acknowledge' | 'decline';
export type OverrideDecision = 'approve' | 'refuse';

export const newRepaymentId = newExpenseId;
export const newReversalId = newExpenseId;

// ---- rows as the database returns them
export interface RepaymentRowRecord {
  id: string;
  trip_id: string;
  from_member_id: string;
  to_member_id: string;
  amount_minor: number;
  method: string;
  note: string | null;
  status: string;
  created_by: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  version: number;
}

export interface ReversalRowRecord {
  id: string;
  trip_id: string;
  repayment_id: string;
  status: string;
  requested_by: string;
  requested_for: string;
  requested_at: string;
  reason: string;
  override_proposed_by: string | null;
  override_category: string | null;
  override_reason: string | null;
  override_proposed_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  is_override: boolean;
  version: number;
}

export interface RepaymentEventRowRecord {
  id: number;
  repayment_id: string;
  reversal_id: string | null;
  action: string;
  from_status: string | null;
  to_status: string | null;
  actor_member_id: string;
  represented_member_id: string;
  reason: string | null;
  acted_at: string;
}

// ---- domain types
export interface Repayment {
  id: string;
  tripId: string;
  /** The payer (a member id). */
  fromMemberId: string;
  /** The receiver (a member id). */
  toMemberId: string;
  amountMinor: number;
  method: RepaymentMethod;
  note: string | null;
  status: RepaymentState;
  /** The authenticated actor who recorded it (for a guest payer: the admin acting for them). */
  createdBy: string;
  createdAt: string;
  /** The authenticated actor who confirmed, rejected or cancelled it. */
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  version: number;
}

export interface RepaymentReversal {
  id: string;
  tripId: string;
  repaymentId: string;
  status: ReversalState;
  /** The authenticated actor who made the request. */
  requestedBy: string;
  /** The represented participant: one of the two parties of the repayment (equal to `requestedBy` unless an admin acts for a guest). */
  requestedFor: string;
  requestedAt: string;
  reason: string;
  overrideProposedBy: string | null;
  overrideCategory: OverrideCategory | null;
  overrideReason: string | null;
  overrideProposedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  isOverride: boolean;
  version: number;
}

export const REPAYMENT_EVENT_ACTIONS = [
  'repayment.create', 'repayment.confirm', 'repayment.reject', 'repayment.cancel',
  'reversal.request', 'reversal.remind', 'reversal.acknowledge', 'reversal.decline', 'reversal.withdraw',
  'reversal.override_propose', 'reversal.override_approve', 'reversal.override_refuse', 'reversal.apply',
] as const;
export type RepaymentEventAction = (typeof REPAYMENT_EVENT_ACTIONS)[number];

export interface RepaymentEvent {
  id: number;
  repaymentId: string;
  reversalId: string | null;
  action: RepaymentEventAction;
  fromStatus: string | null;
  toStatus: string | null;
  /** The authenticated actor. */
  actorMemberId: string;
  /** The participant the action was made for. */
  representedMemberId: string;
  reason: string | null;
  actedAt: string;
}

// ---- strict readers: anything unexpected gives null (the caller then reports an unknown failure, never a guess)
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): v is string => typeof v === 'string' && v !== '';
const optStr = (v: unknown): v is string | null => v === null || typeof v === 'string';
const safeInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const version = (v: unknown): v is number => safeInt(v) && v >= 1;

export function repaymentFromRow(value: unknown): Repayment | null {
  const r = rec(value);
  if (!r) return null;
  if (!str(r.id) || !str(r.trip_id) || !str(r.from_member_id) || !str(r.to_member_id) || !str(r.created_by) || !str(r.created_at)) return null;
  if (!safeInt(r.amount_minor) || r.amount_minor < 1 || r.amount_minor > REPAYMENT_AMOUNT_MAX || r.from_member_id === r.to_member_id) return null;
  if (!isRepaymentMethod(r.method) || !isRepaymentState(r.status) || !version(r.version)) return null;
  if (!optStr(r.note) || !optStr(r.decided_by) || !optStr(r.decided_at) || !optStr(r.decision_note)) return null;
  // the same consistency the table enforces: pending has no decision; every other status has one
  const decided = r.decided_by !== null && r.decided_at !== null;
  if (r.status === 'pending' ? r.decided_by !== null || r.decided_at !== null || r.decision_note !== null : !decided) return null;
  return {
    id: r.id, tripId: r.trip_id, fromMemberId: r.from_member_id, toMemberId: r.to_member_id, amountMinor: r.amount_minor, method: r.method, note: r.note,
    status: r.status, createdBy: r.created_by, createdAt: r.created_at, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, version: r.version,
  };
}

export function reversalFromRow(value: unknown): RepaymentReversal | null {
  const r = rec(value);
  if (!r) return null;
  if (!str(r.id) || !str(r.trip_id) || !str(r.repayment_id) || !str(r.requested_by) || !str(r.requested_for) || !str(r.requested_at) || !str(r.reason)) return null;
  if (!isReversalState(r.status) || !version(r.version) || typeof r.is_override !== 'boolean') return null;
  if (!optStr(r.override_proposed_by) || !optStr(r.override_reason) || !optStr(r.override_proposed_at) || !optStr(r.decided_by) || !optStr(r.decided_at) || !optStr(r.decision_note)) return null;
  if (!(r.override_category === null || r.override_category === OVERRIDE_CATEGORY)) return null; // any other category cannot exist (V1)
  return {
    id: r.id, tripId: r.trip_id, repaymentId: r.repayment_id, status: r.status, requestedBy: r.requested_by, requestedFor: r.requested_for, requestedAt: r.requested_at,
    reason: r.reason, overrideProposedBy: r.override_proposed_by, overrideCategory: r.override_category, overrideReason: r.override_reason,
    overrideProposedAt: r.override_proposed_at, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note, isOverride: r.is_override, version: r.version,
  };
}

export function repaymentEventFromRow(value: unknown): RepaymentEvent | null {
  const r = rec(value);
  if (!r) return null;
  if (!safeInt(r.id) || !str(r.repayment_id) || !str(r.actor_member_id) || !str(r.represented_member_id) || !str(r.acted_at)) return null;
  if (!(REPAYMENT_EVENT_ACTIONS as readonly string[]).includes(r.action as string)) return null;
  if (!optStr(r.reversal_id) || !optStr(r.from_status) || !optStr(r.to_status) || !optStr(r.reason)) return null;
  return {
    id: r.id, repaymentId: r.repayment_id, reversalId: r.reversal_id, action: r.action as RepaymentEventAction, fromStatus: r.from_status, toStatus: r.to_status,
    actorMemberId: r.actor_member_id, representedMemberId: r.represented_member_id, reason: r.reason, actedAt: r.acted_at,
  };
}

/** Rows to domain objects, or null if ANY row is unreadable (a partly understood list is never shown). */
function all<R, T>(rows: readonly R[], read: (row: unknown) => T | null): T[] | null {
  const out: T[] = [];
  for (const row of rows) {
    const item = read(row);
    if (item === null) return null;
    out.push(item);
  }
  return out;
}
export const repaymentsFromRows = (rows: readonly RepaymentRowRecord[]) => all(rows, repaymentFromRow);
export const reversalsFromRows = (rows: readonly ReversalRowRecord[]) => all(rows, reversalFromRow);
export const repaymentEventsFromRows = (rows: readonly RepaymentEventRowRecord[]) => all(rows, repaymentEventFromRow);

/** Who acted and for whom. `isProxy` is true when an admin acted for a guest (the actor differs from the represented participant). */
export function eventActors(e: Pick<RepaymentEvent, 'actorMemberId' | 'representedMemberId'>): { actorMemberId: string; representedMemberId: string; isProxy: boolean } {
  return { actorMemberId: e.actorMemberId, representedMemberId: e.representedMemberId, isProxy: e.actorMemberId !== e.representedMemberId };
}

/** The other party of a repayment, relative to one of its two parties; null if `party` is neither. */
export function counterpartyOf(r: Pick<Repayment, 'fromMemberId' | 'toMemberId'>, party: string): string | null {
  return party === r.fromMemberId ? r.toMemberId : party === r.toMemberId ? r.fromMemberId : null;
}

// ---- early friendly checks (the database checks everything again)
const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v.trim() : '';
};

/** A message for something the database would refuse, or null. */
export function checkRepaymentInput(i: { amountMinor: unknown; method: unknown; note?: unknown; fromMemberId: unknown; toMemberId: unknown }): string | null {
  if (typeof i.amountMinor !== 'number' || !Number.isSafeInteger(i.amountMinor) || i.amountMinor < 1) return 'Enter an amount greater than zero.';
  if (i.amountMinor > REPAYMENT_AMOUNT_MAX) return 'That amount is too large.';
  if (!isRepaymentMethod(i.method)) return 'Choose how it was paid.';
  if (typeof i.fromMemberId !== 'string' || typeof i.toMemberId !== 'string' || i.fromMemberId === '' || i.toMemberId === '' || i.fromMemberId === i.toMemberId) return 'Choose two different people.';
  const note = text(i.note);
  if (note !== null && note.length > REPAYMENT_NOTE_MAX) return `The note can be at most ${REPAYMENT_NOTE_MAX} characters.`;
  return null;
}

export const cleanNote = (note: string | null | undefined): string | null => {
  const t = typeof note === 'string' ? note.trim() : '';
  return t === '' ? null : t;
};

// ---- argument builders: the names must match the SQL exactly
export const createRepaymentRpcArgs = (tripId: string, repaymentId: string, fromMemberId: string, toMemberId: string, amountMinor: number, method: RepaymentMethod, note: string | null) => ({
  p_trip_id: tripId, p_repayment_id: repaymentId, p_from_member_id: fromMemberId, p_to_member_id: toMemberId, p_amount_minor: amountMinor, p_method: method, p_note: note,
});
export const confirmRepaymentRpcArgs = (tripId: string, repaymentId: string, expectedVersion: number) => ({ p_trip_id: tripId, p_repayment_id: repaymentId, p_expected_version: expectedVersion });
export const rejectRepaymentRpcArgs = (tripId: string, repaymentId: string, expectedVersion: number, reason: string | null) => ({
  p_trip_id: tripId, p_repayment_id: repaymentId, p_expected_version: expectedVersion, p_reason: reason,
});
export const cancelRepaymentRpcArgs = confirmRepaymentRpcArgs;
export const requestReversalRpcArgs = (tripId: string, reversalId: string, repaymentId: string, reason: string, requestedFor: string | null) => ({
  p_trip_id: tripId, p_reversal_id: reversalId, p_repayment_id: repaymentId, p_reason: reason, p_requested_for: requestedFor,
});
export const respondReversalRpcArgs = (tripId: string, reversalId: string, expectedVersion: number, decision: ReversalDecision, note: string | null) => ({
  p_trip_id: tripId, p_reversal_id: reversalId, p_expected_version: expectedVersion, p_decision: decision, p_note: note,
});
export const withdrawReversalRpcArgs = (tripId: string, reversalId: string, expectedVersion: number) => ({ p_trip_id: tripId, p_reversal_id: reversalId, p_expected_version: expectedVersion });
export const remindReversalRpcArgs = (tripId: string, reversalId: string) => ({ p_trip_id: tripId, p_reversal_id: reversalId });
export const proposeOverrideRpcArgs = (tripId: string, reversalId: string, expectedVersion: number, reason: string) => ({
  p_trip_id: tripId, p_reversal_id: reversalId, p_expected_version: expectedVersion, p_category: OVERRIDE_CATEGORY, p_reason: reason,
});
export const decideOverrideRpcArgs = (tripId: string, reversalId: string, expectedVersion: number, decision: OverrideDecision, note: string | null) => ({
  p_trip_id: tripId, p_reversal_id: reversalId, p_expected_version: expectedVersion, p_decision: decision, p_note: note,
});
