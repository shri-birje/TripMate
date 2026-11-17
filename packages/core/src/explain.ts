import {
  assertExpenseConsistent,
  isGroupExpense,
  repaymentCounts,
  type LedgerExpense,
  type LedgerRepayment,
  type RepaymentStatus,
} from './balances';
import { addMinor, type Minor } from './money';

/**
 * "Why do I owe this?" - the exact records behind one member's balance.
 * Built from real expenses and repayments (never generated text), so the
 * lines always add up to the balance shown.
 */
export type ExplanationLine =
  | {
      kind: 'expense';
      expenseId: string;
      title: string | undefined;
      paidMinor: Minor;
      shareMinor: Minor;
      /** paid - share: positive = the group owes you for this, negative = you owe the group. */
      effectConfirmedMinor: Minor;
      effectProjectedMinor: Minor;
    }
  | {
      kind: 'repayment';
      repaymentId: string;
      direction: 'sent' | 'received';
      otherMemberId: string;
      amountMinor: Minor;
      status: RepaymentStatus;
      countsInConfirmed: boolean;
      countsInProjected: boolean;
      effectConfirmedMinor: Minor;
      effectProjectedMinor: Minor;
    };

export interface BalanceExplanation {
  memberId: string;
  lines: ExplanationLine[];
  netConfirmedMinor: Minor;
  netProjectedMinor: Minor;
}

export function explainBalance(
  memberId: string,
  expenses: readonly LedgerExpense[],
  repayments: readonly LedgerRepayment[],
): BalanceExplanation {
  const lines: ExplanationLine[] = [];
  let netConfirmed = 0;
  let netProjected = 0;

  for (const e of expenses) {
    if (!isGroupExpense(e)) continue;
    assertExpenseConsistent(e);
    const paid = e.payers.filter((p) => p.memberId === memberId).reduce((a, p) => addMinor(a, p.paidMinor), 0);
    const share = e.splits.filter((s) => s.memberId === memberId).reduce((a, s) => addMinor(a, s.shareMinor), 0);
    if (paid === 0 && share === 0) continue; // this expense did not involve the member
    const effect = paid - share;
    lines.push({
      kind: 'expense',
      expenseId: e.id,
      title: e.title,
      paidMinor: paid,
      shareMinor: share,
      effectConfirmedMinor: effect,
      effectProjectedMinor: effect,
    });
    netConfirmed = addMinor(netConfirmed, effect);
    netProjected = addMinor(netProjected, effect);
  }

  for (const r of repayments) {
    if (r.fromMemberId !== memberId && r.toMemberId !== memberId) continue;
    const sent = r.fromMemberId === memberId;
    const signed = sent ? r.amountMinor : -r.amountMinor;
    const countsInConfirmed = repaymentCounts(r.status, 'confirmed');
    const countsInProjected = repaymentCounts(r.status, 'projected');
    const effectConfirmed = countsInConfirmed ? signed : 0;
    const effectProjected = countsInProjected ? signed : 0;
    lines.push({
      kind: 'repayment',
      repaymentId: r.id,
      direction: sent ? 'sent' : 'received',
      otherMemberId: sent ? r.toMemberId : r.fromMemberId,
      amountMinor: r.amountMinor,
      status: r.status,
      countsInConfirmed,
      countsInProjected,
      effectConfirmedMinor: effectConfirmed,
      effectProjectedMinor: effectProjected,
    });
    netConfirmed = addMinor(netConfirmed, effectConfirmed);
    netProjected = addMinor(netProjected, effectProjected);
  }

  return { memberId, lines, netConfirmedMinor: netConfirmed, netProjectedMinor: netProjected };
}
