import { computeBalances, type LedgerExpense } from './balances';
import { CoreError } from './errors';
import { addMinor, assertSafeMinor, type Minor } from './money';

/**
 * The M7 ledger: the expense-derived balance (M5, with M1 as its reference) plus CONFIRMED repayments, minus any that have an
 * APPLIED reversal (ADR-066, `docs/M7_REPAYMENTS_DESIGN.md` section 6).
 *
 *   expense_net(m) = paid - share                        (from the non-deleted shared expenses; M1 `computeBalances`, called with NO repayments)
 *   net(m)         = expense_net(m) + sent(m) - received(m)
 *   sent(m)        = sum of the amounts of CONFIRMED repayments from m that have NO applied reversal
 *   received(m)    = the same, to m
 *
 * Sign convention (unchanged): positive means the member is OWED money, negative means the member OWES. Over a whole trip the nets add up
 * to exactly zero, because every repayment adds an amount to one member and subtracts the same amount from another.
 *
 * `pending`, `rejected` and `cancelled` repayments NEVER change a balance, and neither do reversal requests that are not applied
 * (requested, override_proposed, declined, withdrawn, override_refused). A pending repayment only RESERVES capacity (see
 * `previewRepaymentCapacity`).
 *
 * THIS MODULE IS A REFERENCE AND A PREVIEW. The database computes the official balances (`trip_member_balances`) and decides every
 * capacity question; the app never trusts, and never submits, a balance or a capacity calculated here. Its jobs are to be the
 * independently written reference the database is tested against, and to power friendly previews (for example "the most you can record
 * is X") that the database then checks again.
 *
 * M1's own repayment path (its `paid` state and projected figure) belongs to the superseded semantics: it is neither used nor changed.
 * Integer paise only, with safe-integer checks everywhere; no floating-point arithmetic touches an amount.
 */

export const REPAYMENT_STATES = ['pending', 'confirmed', 'rejected', 'cancelled'] as const;
export type RepaymentState = (typeof REPAYMENT_STATES)[number];
export const REVERSAL_STATES = ['requested', 'override_proposed', 'applied', 'declined', 'withdrawn', 'override_refused'] as const;
export type ReversalState = (typeof REVERSAL_STATES)[number];

export const isRepaymentState = (v: unknown): v is RepaymentState => typeof v === 'string' && (REPAYMENT_STATES as readonly string[]).includes(v);
export const isReversalState = (v: unknown): v is ReversalState => typeof v === 'string' && (REVERSAL_STATES as readonly string[]).includes(v);

export type RepaymentLedgerErrorCode =
  | 'INVALID_INPUT'
  | 'DUPLICATE_MEMBER'
  | 'UNKNOWN_MEMBER'
  | 'INVALID_AMOUNT'
  | 'DUPLICATE_REPAYMENT'
  | 'DUPLICATE_REVERSAL'
  | 'UNKNOWN_REPAYMENT'
  | 'REVERSAL_OF_UNCONFIRMED'
  | 'MULTIPLE_APPLIED_REVERSALS'
  | 'NOT_ZERO_SUM';

/** Inconsistent records are refused loudly: a quietly wrong balance is worse than an error (the same stance as the M1 engine). */
export class RepaymentLedgerError extends Error {
  constructor(
    public readonly code: RepaymentLedgerErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RepaymentLedgerError';
  }
}

export interface RepaymentLedgerEntry {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: Minor;
  status: RepaymentState;
}

export interface ReversalLedgerEntry {
  id: string;
  repaymentId: string;
  status: ReversalState;
}

export interface ExpenseNet {
  memberId: string;
  /** paid - share over the non-deleted shared expenses. */
  netMinor: Minor;
}

export interface LedgerBalance {
  memberId: string;
  /** paid - share (the M5 figure). */
  expenseNetMinor: Minor;
  /** Confirmed, unreversed repayments this member made. */
  sentMinor: Minor;
  /** Confirmed, unreversed repayments this member received. */
  receivedMinor: Minor;
  /** expenseNet + sent - received. Positive: owed money. Negative: owes money. */
  netMinor: Minor;
}

/** Runs money arithmetic and reports an unsafe or overflowing amount as this module's own typed error. */
function money<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof CoreError) throw new RepaymentLedgerError('INVALID_AMOUNT', 'An amount is not a safe whole number of paise');
    throw e;
  }
}

const fail = (code: RepaymentLedgerErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new RepaymentLedgerError(code, message, details);
};

function checkRepayments(repayments: readonly RepaymentLedgerEntry[], known: ReadonlySet<string>): Map<string, RepaymentLedgerEntry> {
  const byId = new Map<string, RepaymentLedgerEntry>();
  for (const r of repayments) {
    if (typeof r !== 'object' || r === null || typeof r.id !== 'string' || r.id === '' || typeof r.fromMemberId !== 'string' || typeof r.toMemberId !== 'string' || !isRepaymentState(r.status)) {
      fail('INVALID_INPUT', 'A repayment record is malformed', { id: (r as { id?: unknown } | null)?.id });
    }
    if (byId.has(r.id)) fail('DUPLICATE_REPAYMENT', 'A repayment appears more than once', { id: r.id });
    byId.set(r.id, r);
    if (typeof r.amountMinor !== 'number' || !Number.isSafeInteger(r.amountMinor) || r.amountMinor <= 0 || r.fromMemberId === r.toMemberId) {
      fail('INVALID_AMOUNT', 'A repayment must be a positive whole number of paise between two different members', { id: r.id });
    }
    if (!known.has(r.fromMemberId) || !known.has(r.toMemberId)) fail('UNKNOWN_MEMBER', 'A repayment names a member who is not in the ledger', { id: r.id });
  }
  return byId;
}

/** The ids of the repayments that have an APPLIED reversal (they stop counting). Refuses reversals that cannot exist in the database. */
function reversedIds(reversals: readonly ReversalLedgerEntry[], repayments: ReadonlyMap<string, RepaymentLedgerEntry>): Set<string> {
  const seen = new Set<string>();
  const reversed = new Set<string>();
  for (const v of reversals) {
    if (typeof v !== 'object' || v === null || typeof v.id !== 'string' || v.id === '' || typeof v.repaymentId !== 'string' || !isReversalState(v.status)) {
      fail('INVALID_INPUT', 'A reversal record is malformed', { id: (v as { id?: unknown } | null)?.id });
    }
    if (seen.has(v.id)) fail('DUPLICATE_REVERSAL', 'A reversal appears more than once', { id: v.id });
    seen.add(v.id);
    const repayment = repayments.get(v.repaymentId);
    if (!repayment) fail('UNKNOWN_REPAYMENT', 'A reversal names a repayment that is not in the ledger', { id: v.id });
    if (v.status === 'applied') {
      if (repayment!.status !== 'confirmed') fail('REVERSAL_OF_UNCONFIRMED', 'Only a confirmed repayment can have an applied reversal', { id: v.id });
      if (reversed.has(v.repaymentId)) fail('MULTIPLE_APPLIED_REVERSALS', 'A repayment can have at most one applied reversal', { repaymentId: v.repaymentId });
      reversed.add(v.repaymentId);
    }
  }
  return reversed;
}

/** True when the repayment changes official balances: it is confirmed and has no applied reversal. */
export function repaymentCountsOfficially(repayment: RepaymentLedgerEntry, reversals: readonly ReversalLedgerEntry[]): boolean {
  return repayment.status === 'confirmed' && !reversals.some((v) => v.repaymentId === repayment.id && v.status === 'applied');
}

/**
 * Adds the confirmed, unreversed repayments to the given expense-derived nets. The expense nets must add up to zero and name each member
 * once. Results come back in the order of `expenseNets`.
 */
export function applyRepaymentsToNets(expenseNets: readonly ExpenseNet[], repayments: readonly RepaymentLedgerEntry[], reversals: readonly ReversalLedgerEntry[]): LedgerBalance[] {
  return money(() => applyImpl(expenseNets, repayments, reversals));
}

function applyImpl(expenseNets: readonly ExpenseNet[], repayments: readonly RepaymentLedgerEntry[], reversals: readonly ReversalLedgerEntry[]): LedgerBalance[] {
  const known = new Set<string>();
  let expenseTotal = 0;
  for (const n of expenseNets) {
    if (typeof n !== 'object' || n === null || typeof n.memberId !== 'string' || n.memberId === '') fail('INVALID_INPUT', 'An expense balance is malformed');
    if (known.has(n.memberId)) fail('DUPLICATE_MEMBER', 'A member appears more than once', { memberId: n.memberId });
    known.add(n.memberId);
    assertSafeMinor(n.netMinor, 'expense balance');
    expenseTotal = addMinor(expenseTotal, n.netMinor);
  }
  if (expenseTotal !== 0) fail('NOT_ZERO_SUM', 'The expense balances do not add up to zero', { sumMinor: expenseTotal });

  const byId = checkRepayments(repayments, known);
  const reversed = reversedIds(reversals, byId);

  const sent = new Map<string, Minor>();
  const received = new Map<string, Minor>();
  for (const id of known) {
    sent.set(id, 0);
    received.set(id, 0);
  }
  for (const r of repayments) {
    if (r.status !== 'confirmed' || reversed.has(r.id)) continue; // pending, rejected, cancelled and reversed ones never count
    sent.set(r.fromMemberId, addMinor(sent.get(r.fromMemberId)!, r.amountMinor));
    received.set(r.toMemberId, addMinor(received.get(r.toMemberId)!, r.amountMinor));
  }

  let total = 0;
  const result = expenseNets.map((n): LedgerBalance => {
    const sentMinor = sent.get(n.memberId)!;
    const receivedMinor = received.get(n.memberId)!;
    const netMinor = addMinor(addMinor(n.netMinor, sentMinor), -receivedMinor);
    total = addMinor(total, netMinor);
    return { memberId: n.memberId, expenseNetMinor: n.netMinor, sentMinor, receivedMinor, netMinor };
  });
  if (total !== 0) fail('NOT_ZERO_SUM', 'The balances do not add up to zero', { sumMinor: total }); // cannot happen for valid records: defensive
  return result;
}

/**
 * The full M7 ledger from the raw expenses: the expense part is M1's `computeBalances` called with NO repayments (the expense-derived
 * reference, unchanged), then the confirmed, unreversed repayments are added. `memberIds` must include every member who appears in any
 * record, former members included.
 */
export function computeLedgerBalances(
  memberIds: readonly string[],
  expenses: readonly LedgerExpense[],
  repayments: readonly RepaymentLedgerEntry[],
  reversals: readonly ReversalLedgerEntry[],
): LedgerBalance[] {
  const expenseOnly = computeBalances(memberIds, expenses, []); // M1: expense part only; its repayment path is not used
  return applyRepaymentsToNets(
    expenseOnly.map((b) => ({ memberId: b.memberId, netMinor: b.netConfirmedMinor })),
    repayments,
    reversals,
  );
}

/** What pending repayments currently RESERVE, per member: what each payer has promised out and what each receiver has coming in. */
export function pendingReservations(repayments: readonly RepaymentLedgerEntry[]): { out: Map<string, Minor>; in: Map<string, Minor> } {
  return money(() => reservationsImpl(repayments));
}

function reservationsImpl(repayments: readonly RepaymentLedgerEntry[]): { out: Map<string, Minor>; in: Map<string, Minor> } {
  const out = new Map<string, Minor>();
  const inc = new Map<string, Minor>();
  for (const r of repayments) {
    if (r.status !== 'pending') continue;
    assertSafeMinor(r.amountMinor, 'repayment amount');
    out.set(r.fromMemberId, addMinor(out.get(r.fromMemberId) ?? 0, r.amountMinor));
    inc.set(r.toMemberId, addMinor(inc.get(r.toMemberId) ?? 0, r.amountMinor));
  }
  return { out, in: inc };
}

export interface CapacityPreview {
  /** The most a NEW repayment from the payer to the receiver could be, by this preview. The database decides; this is only a preview. */
  maxMinor: Minor;
  debtMinor: Minor;
  creditMinor: Minor;
  reservedOutMinor: Minor;
  reservedInMinor: Minor;
}

/**
 * PREVIEW of the database's capacity rule (never an authority, never sent):
 *   capacity(p -> q) = max(0, min(max(0, debt(p) - everything p has pending), max(0, credit(q) - everything pending TO q)))
 * where debt(p) = max(0, -net(p)) and credit(q) = max(0, net(q)) on the CONFIRMED balances. Pending repayments of the same payer (to anyone)
 * and to the same receiver (from anyone) all reserve capacity. Rejecting or cancelling a repayment removes its reservation simply because
 * it is no longer pending.
 */
export function previewRepaymentCapacity(
  balances: readonly { memberId: string; netMinor: Minor }[],
  repayments: readonly RepaymentLedgerEntry[],
  fromMemberId: string,
  toMemberId: string,
): CapacityPreview {
  return money(() => capacityImpl(balances, repayments, fromMemberId, toMemberId));
}

function capacityImpl(balances: readonly { memberId: string; netMinor: Minor }[], repayments: readonly RepaymentLedgerEntry[], fromMemberId: string, toMemberId: string): CapacityPreview {
  const net = (id: string): Minor => {
    const b = balances.find((x) => x.memberId === id);
    if (!b) fail('UNKNOWN_MEMBER', 'The member is not in the balances', { memberId: id });
    assertSafeMinor(b!.netMinor, 'balance');
    return b!.netMinor;
  };
  if (fromMemberId === toMemberId) fail('INVALID_INPUT', 'A repayment is between two different members');
  const debtMinor = Math.max(0, -net(fromMemberId));
  const creditMinor = Math.max(0, net(toMemberId));
  const reserved = pendingReservations(repayments);
  const reservedOutMinor = reserved.out.get(fromMemberId) ?? 0;
  const reservedInMinor = reserved.in.get(toMemberId) ?? 0;
  const maxMinor = Math.max(0, Math.min(Math.max(0, debtMinor - reservedOutMinor), Math.max(0, creditMinor - reservedInMinor)));
  return { maxMinor, debtMinor, creditMinor, reservedOutMinor, reservedInMinor };
}
