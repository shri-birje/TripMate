import type { Transfer } from './settle';
import { SettlementPlanError, type SettlementPlan } from './settlementPlan';

/**
 * How a settlement plan reads on screen (M6). Pure text-making: no amounts are calculated here (they are the plan's, exactly), and the
 * wording is fixed so that every screen says the same thing: suggestions only, nothing is transferred, nothing is recorded.
 */

export const SETTLEMENT_DISCLAIMER =
  'These are suggestions only. The app does not move any money or record repayments, and the suggested payments can change when expenses change.';

export const SETTLEMENT_INEXACT_NOTE = 'This is a good plan, but with this many people it may not be the fewest possible payments.';

/** Why no plan could be made. Each kind has its own message, and when any of them applies NO payments are shown at all. */
export type SettlementFailureKind = 'not_zero_sum' | 'former_member_balance' | 'unsafe_amount' | 'invalid_input';

export const SETTLEMENT_FAILURE_MESSAGES: Record<SettlementFailureKind, string> = {
  not_zero_sum: "The balances don't add up to zero, so no payments can be suggested. Reload to try again.",
  former_member_balance:
    'Someone who left the trip still has a balance, which should not happen, so no payments can be suggested. Check the expenses that involve people who left.',
  unsafe_amount: 'Some amounts are too large or are not valid money amounts, so no payments can be suggested.',
  invalid_input: 'The balance information looks invalid, so no payments can be suggested. Reload to try again.',
};

/** Which kind of failure an error from `planSettlement` is. Anything that is not a recognised plan error counts as invalid input. */
export function classifySettlementFailure(error: unknown): SettlementFailureKind {
  if (error instanceof SettlementPlanError) {
    if (error.code === 'NOT_ZERO_SUM') return 'not_zero_sum';
    if (error.code === 'FORMER_MEMBER_BALANCE') return 'former_member_balance';
    if (error.code === 'UNSAFE_AMOUNT') return 'unsafe_amount';
  }
  return 'invalid_input'; // a repeated member, malformed entries, or anything unexpected
}

export const settlementFailureMessage = (kind: SettlementFailureKind): string => SETTLEMENT_FAILURE_MESSAGES[kind];

export interface SettlementFormat {
  /** The signed-in person's member id, or null when it is not known. */
  meId: string | null;
  /** A member id as a name (and "(left)" for someone who left). */
  name(memberId: string): string;
  /** Paise as money text, for example "₹500". */
  money(minor: number): string;
}

export interface PaymentLine {
  key: string;
  fromId: string;
  toId: string;
  amountMinor: number;
  /** "Asha pays Ravi ₹500". */
  text: string;
  involvesMe: boolean;
}

export interface SettlementView {
  /** "Everyone is settled." or "3 payments settle everyone." */
  headline: string;
  /** The signed-in person's own lines: "You pay Ravi ₹300", "You receive ₹500 from Priya", or "You are settled". Empty when they are not on the trip. */
  mine: string[];
  lines: PaymentLine[];
  /** Set only when the plan is not guaranteed to use the fewest payments. */
  inexactNote: string | null;
}

export function settlementView(plan: SettlementPlan, f: SettlementFormat, meIsMember = true): SettlementView {
  const lines: PaymentLine[] = plan.transfers.map((t: Transfer) => ({
    key: `${t.fromMemberId}>${t.toMemberId}`,
    fromId: t.fromMemberId,
    toId: t.toMemberId,
    amountMinor: t.amountMinor,
    text: `${f.name(t.fromMemberId)} pays ${f.name(t.toMemberId)} ${f.money(t.amountMinor)}`,
    involvesMe: f.meId !== null && (t.fromMemberId === f.meId || t.toMemberId === f.meId),
  }));
  const mine: string[] = [];
  if (f.meId !== null && meIsMember) {
    for (const t of plan.transfers) {
      if (t.fromMemberId === f.meId) mine.push(`You pay ${f.name(t.toMemberId)} ${f.money(t.amountMinor)}`);
    }
    for (const t of plan.transfers) {
      if (t.toMemberId === f.meId) mine.push(`You receive ${f.money(t.amountMinor)} from ${f.name(t.fromMemberId)}`);
    }
    if (mine.length === 0) mine.push('You are settled');
  }
  const n = plan.transfers.length;
  return {
    headline: n === 0 ? 'Everyone is settled.' : `${n} ${n === 1 ? 'payment settles' : 'payments settle'} everyone.`,
    mine,
    lines,
    inexactNote: plan.guaranteedMinimum ? null : SETTLEMENT_INEXACT_NOTE,
  };
}
