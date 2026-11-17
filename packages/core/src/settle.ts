import { CoreError } from './errors';
import { assertSafeMinor, type Minor } from './money';

export interface NetBalance {
  memberId: string;
  netMinor: Minor;
}

export interface Transfer {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: Minor;
}

/**
 * Suggests who should pay whom to settle everything, using few transfers.
 *
 * Method (greedy): repeatedly take the person who owes the most and the
 * person who is owed the most, and have the first pay the second as much as
 * possible. Someone is fully settled at every step, so the plan has at most
 * (number of people with a balance - 1) transfers.
 *
 * Honest limitation: the true minimum number of transfers is a hard puzzle
 * (finding the most groups that settle among themselves). Greedy is optimal
 * in most small friend groups, including the six-friend example in the
 * product brief, but is not guaranteed minimal in every case.
 *
 * Deterministic: ties are broken by member id, so the same balances always
 * produce the same plan, whatever order they were supplied in.
 */
export function suggestSettlements(nets: readonly NetBalance[]): Transfer[] {
  const seen = new Set<string>();
  let total = 0;
  for (const n of nets) {
    assertSafeMinor(n.netMinor, 'balance');
    if (seen.has(n.memberId)) {
      throw new CoreError('DUPLICATE_MEMBER', 'A member appears more than once', { memberId: n.memberId });
    }
    seen.add(n.memberId);
    total += n.netMinor;
  }
  if (total !== 0) {
    throw new CoreError('BALANCES_NOT_ZERO_SUM', 'Balances must add up to zero to be settled', {
      sumMinor: total,
    });
  }

  type Entry = { memberId: string; remaining: Minor };
  const creditors: Entry[] = nets.filter((n) => n.netMinor > 0).map((n) => ({ memberId: n.memberId, remaining: n.netMinor }));
  const debtors: Entry[] = nets.filter((n) => n.netMinor < 0).map((n) => ({ memberId: n.memberId, remaining: -n.netMinor }));

  const order = (a: Entry, b: Entry) =>
    a.remaining !== b.remaining ? b.remaining - a.remaining : a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;

  const transfers: Transfer[] = [];
  while (creditors.length > 0 && debtors.length > 0) {
    creditors.sort(order);
    debtors.sort(order);
    const creditor = creditors[0]!;
    const debtor = debtors[0]!;
    const amount = Math.min(creditor.remaining, debtor.remaining);
    transfers.push({ fromMemberId: debtor.memberId, toMemberId: creditor.memberId, amountMinor: amount });
    creditor.remaining -= amount;
    debtor.remaining -= amount;
    if (creditor.remaining === 0) creditors.shift();
    if (debtor.remaining === 0) debtors.shift();
  }
  return transfers;
}
