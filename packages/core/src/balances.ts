import { CoreError } from './errors';
import { addMinor, assertSafeMinor, type Minor } from './money';

/**
 * BALANCE RULES (the heart of TripMate)
 *
 *   net(member) = paid - share + sent - received
 *
 *   paid      money the member put into shared expenses
 *   share     the member's portion of those expenses
 *   sent      repayments the member made to others
 *   received  repayments others made to the member
 *
 *   net > 0  the member should RECEIVE money
 *   net < 0  the member OWES money
 *   Across a whole trip the nets always add up to exactly 0.
 *
 * Balances are never stored; they are recomputed from the records every time,
 * so editing or deleting an expense can never leave a stale number behind.
 *
 * Two versions are produced (product rule 12: recorded is not confirmed):
 *   netConfirmed  counts repayments with status 'confirmed' only (final)
 *   netProjected  also counts 'paid' ones (awaiting the receiver's confirmation)
 * 'pending' and 'cancelled' repayments never change any balance.
 */
export type RepaymentStatus = 'pending' | 'paid' | 'confirmed' | 'cancelled';

export interface LedgerExpense {
  id: string;
  title?: string;
  /** Soft-deleted expenses are ignored. */
  deleted?: boolean;
  /** Personal expenses are private and never part of group balances (rule 9). Default 'shared'. */
  scope?: 'shared' | 'personal';
  payers: readonly { memberId: string; paidMinor: Minor }[];
  splits: readonly { memberId: string; shareMinor: Minor }[];
}

export interface LedgerRepayment {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: Minor;
  status: RepaymentStatus;
}

export interface MemberBalance {
  memberId: string;
  paidMinor: Minor;
  shareMinor: Minor;
  netConfirmedMinor: Minor;
  netProjectedMinor: Minor;
  /** netProjected - netConfirmed: the part that depends on repayments not yet confirmed. */
  awaitingConfirmationMinor: Minor;
}

export type Basis = 'confirmed' | 'projected';

export function repaymentCounts(status: RepaymentStatus, basis: Basis): boolean {
  if (basis === 'confirmed') return status === 'confirmed';
  return status === 'paid' || status === 'confirmed';
}

/** True if the expense takes part in group balances. */
export function isGroupExpense(e: LedgerExpense): boolean {
  return !e.deleted && (e.scope ?? 'shared') === 'shared';
}

/**
 * An expense is only valid if what was paid equals what is owed. If stored
 * data ever violates this we stop with an error instead of producing a
 * wrong balance.
 */
export function assertExpenseConsistent(e: LedgerExpense): void {
  let paid = 0;
  for (const p of e.payers) {
    assertSafeMinor(p.paidMinor);
    paid = addMinor(paid, p.paidMinor);
  }
  let owed = 0;
  for (const s of e.splits) {
    assertSafeMinor(s.shareMinor);
    owed = addMinor(owed, s.shareMinor);
  }
  if (paid !== owed) {
    throw new CoreError('INCONSISTENT_EXPENSE', 'Amount paid does not equal the sum of shares', {
      expenseId: e.id,
      paidMinor: paid,
      sharesMinor: owed,
    });
  }
}

function requireKnown(known: ReadonlySet<string>, memberId: string, context: Record<string, unknown>) {
  if (!known.has(memberId)) {
    throw new CoreError('UNKNOWN_MEMBER', 'A record refers to a member that is not part of this trip', {
      memberId,
      ...context,
    });
  }
}

/**
 * Computes every member's balance.
 * `memberIds` must include EVERY member who appears in any record, including
 * removed members (their history still counts).
 */
export function computeBalances(
  memberIds: readonly string[],
  expenses: readonly LedgerExpense[],
  repayments: readonly LedgerRepayment[],
): MemberBalance[] {
  const known = new Set(memberIds);
  const paid = new Map<string, Minor>();
  const share = new Map<string, Minor>();
  const confirmedFlow = new Map<string, Minor>(); // sent - received, confirmed only
  const projectedFlow = new Map<string, Minor>(); // sent - received, paid + confirmed
  for (const id of memberIds) {
    paid.set(id, 0);
    share.set(id, 0);
    confirmedFlow.set(id, 0);
    projectedFlow.set(id, 0);
  }

  for (const e of expenses) {
    if (!isGroupExpense(e)) continue;
    assertExpenseConsistent(e);
    for (const p of e.payers) {
      requireKnown(known, p.memberId, { expenseId: e.id });
      paid.set(p.memberId, addMinor(paid.get(p.memberId)!, p.paidMinor));
    }
    for (const s of e.splits) {
      requireKnown(known, s.memberId, { expenseId: e.id });
      share.set(s.memberId, addMinor(share.get(s.memberId)!, s.shareMinor));
    }
  }

  for (const r of repayments) {
    requireKnown(known, r.fromMemberId, { repaymentId: r.id });
    requireKnown(known, r.toMemberId, { repaymentId: r.id });
    assertSafeMinor(r.amountMinor, 'repayment amount');
    if (r.amountMinor <= 0 || r.fromMemberId === r.toMemberId) {
      throw new CoreError('INVALID_AMOUNT', 'A repayment must be positive and between two different members', {
        repaymentId: r.id,
      });
    }
    if (repaymentCounts(r.status, 'confirmed')) {
      confirmedFlow.set(r.fromMemberId, addMinor(confirmedFlow.get(r.fromMemberId)!, r.amountMinor));
      confirmedFlow.set(r.toMemberId, addMinor(confirmedFlow.get(r.toMemberId)!, -r.amountMinor));
    }
    if (repaymentCounts(r.status, 'projected')) {
      projectedFlow.set(r.fromMemberId, addMinor(projectedFlow.get(r.fromMemberId)!, r.amountMinor));
      projectedFlow.set(r.toMemberId, addMinor(projectedFlow.get(r.toMemberId)!, -r.amountMinor));
    }
  }

  const result = memberIds.map((memberId): MemberBalance => {
    const base = paid.get(memberId)! - share.get(memberId)!;
    const netConfirmedMinor = addMinor(base, confirmedFlow.get(memberId)!);
    const netProjectedMinor = addMinor(base, projectedFlow.get(memberId)!);
    return {
      memberId,
      paidMinor: paid.get(memberId)!,
      shareMinor: share.get(memberId)!,
      netConfirmedMinor,
      netProjectedMinor,
      awaitingConfirmationMinor: netProjectedMinor - netConfirmedMinor,
    };
  });

  // Safety net: if this ever fails, the data is corrupt. Refuse to answer.
  const sumConfirmed = result.reduce((a, b) => a + b.netConfirmedMinor, 0);
  const sumProjected = result.reduce((a, b) => a + b.netProjectedMinor, 0);
  if (sumConfirmed !== 0 || sumProjected !== 0) {
    throw new CoreError('BALANCES_NOT_ZERO_SUM', 'Balances do not add up to zero; records are inconsistent', {
      sumConfirmed,
      sumProjected,
    });
  }
  return result;
}
