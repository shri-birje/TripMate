import { assertSafeMinor, type Minor } from './money';
import { suggestSettlements, type Transfer } from './settle';

/**
 * The settlement plan (M6, ADR-065): who should pay whom so that every balance ends at exactly zero. DISPLAY ONLY: nothing here moves
 * money or records anything. Integer paise throughout; no floating-point arithmetic touches an amount.
 *
 * INPUT: one entry per member of the trip as the database reports it (`trip_member_balances`): a net in paise (positive = is owed,
 * negative = owes) and whether the member is still on the trip.
 *
 * RULES
 *   - Members with a balance of exactly zero are left out (former members included).
 *   - A FORMER member with a non-zero balance cannot happen (Rule I-1 in the database); if it appears the plan fails with
 *     SettlementPlanError('FORMER_MEMBER_BALANCE'). It is never silently included or ignored.
 *   - Balances that do not add up to exactly zero fail with 'NOT_ZERO_SUM'; a value that is not a safe integer, or amounts so large that
 *     sums could lose precision, fail with 'UNSAFE_AMOUNT'; the same member twice fails with 'DUPLICATE_MEMBER'; input of the wrong shape (not a list,
 *     a missing or empty member id, an amount that is not a number, an active flag that is not true or false) fails with 'INVALID_INPUT'. Every
 *     failure throws before anything is planned, so a partial plan can never come out.
 *
 * HOW MANY PAYMENTS (the maths)
 *   A set of k people with non-zero balances can be split into groups that each add up to zero on their own. A group of g people needs at
 *   least g-1 payments (every payment settles at most two people, and the last one settles two), and g-1 are always enough (the greedy
 *   rule below: each payment settles at least one person and the last settles two). So the fewest payments overall is
 *   k - (the largest number of zero-sum groups the k people can be split into).
 *
 * EXACT SEARCH (k <= EXACT_LIMIT = 20), a dynamic programme over subsets. Number the k people 0..k-1 in member-id order. For every subset
 * `mask` (a bit per person):
 *     sum[mask]  = sum[mask without its lowest bit] + net[lowest bit]
 *     best[mask] = max over every person i in mask of best[mask without i]  +  (sum[mask] == 0 ? 1 : 0)
 *   best[mask] is the largest number of zero-sum "prefixes" over all the orders in which the people of `mask` can be listed. Why that equals
 *   the largest number of zero-sum groups: list the people group by group and every group boundary is a zero-sum prefix, so a split into
 *   g groups gives an order with g zero-sum prefixes (best >= g); conversely an order with g zero-sum prefixes cuts into g blocks, and the
 *   difference of two consecutive zero-sum prefixes is zero-sum, so it gives g zero-sum groups (best <= max groups). The whole set sums
 *   to zero, so best[full] counts it as the last group. The groups are recovered by remembering, for every mask, the person i that gave
 *   the maximum (the LOWEST such i, so the answer is deterministic), walking back from the full set, and taking the differences between
 *   consecutive zero-sum prefixes. Time O(2^k * k) (2^20 subsets x about 10 persons each = about 10 million inner steps at k = 20; measured 14 to 35 ms in Node), memory about 10 bytes per subset (10 MB at k = 20).
 *   Before the search, exact pairs (a debtor and a creditor owing and owed the same amount) are removed: an exchange argument shows this
 *   never lowers the best number of groups (if the two sit in different groups, regroup them as the pair plus the rest of those two groups,
 *   still two groups; if they sit in one group of more than two people, splitting the pair off makes more groups), and it shrinks k.
 *
 * FALLBACK (k > 20, up to the trip limit of 50 people): exact pairs removed, then the greedy rule (the approved M1 `suggestSettlements`:
 *   the biggest debtor pays the biggest creditor, ties by member id) on what is left. The plain greedy plan of everyone is also worked out
 *   and the SHORTER of the two is kept, so the result is never longer than plain greedy. It is NOT guaranteed to be the minimum, and
 *   `guaranteedMinimum` is false so that nothing may claim it is.
 *
 * DETERMINISM: members are sorted by id (plain text order, like the database's "C" collation) before anything else, every tie is broken
 * by id, and the payments come out sorted by (payer id, receiver id). The same balances give the same plan in any input order.
 */

export type SettlementPlanErrorCode = 'NOT_ZERO_SUM' | 'FORMER_MEMBER_BALANCE' | 'UNSAFE_AMOUNT' | 'DUPLICATE_MEMBER' | 'INVALID_INPUT';

export class SettlementPlanError extends Error {
  constructor(
    public readonly code: SettlementPlanErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SettlementPlanError';
  }
}

export interface PlanBalance {
  memberId: string;
  /** Paise: positive = is owed, negative = owes. */
  netMinor: Minor;
  /** Whether the member is still on the trip. */
  active: boolean;
}

export interface SettlementPlan {
  transfers: Transfer[];
  /** People with a non-zero balance (they are the only ones in the plan). */
  peopleWithBalance: number;
  /** 'exact': the fewest possible payments. 'suggested': a good plan that is not guaranteed to be the fewest. */
  quality: 'exact' | 'suggested';
  /** True only when the number of payments is proven to be the fewest possible. Never claim a minimum when this is false. */
  guaranteedMinimum: boolean;
}

/** The most people with a balance for which the fewest payments are found exactly. */
export const EXACT_LIMIT = 20;

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorts payments by (payer id, receiver id) so the output never depends on how it was produced. */
const sortTransfers = (xs: Transfer[]): Transfer[] => [...xs].sort((a, b) => byId(a.fromMemberId, b.fromMemberId) || byId(a.toMemberId, b.toMemberId));

interface Person {
  memberId: string;
  netMinor: number;
}

/** Removes exact pairs: the lowest-id debtor with the lowest-id unused creditor of the same amount. Returns the payments and who is left. */
function removeExactPairs(people: Person[]): { transfers: Transfer[]; rest: Person[] } {
  const creditorsByAmount = new Map<number, Person[]>();
  for (const p of people) if (p.netMinor > 0) (creditorsByAmount.get(p.netMinor) ?? creditorsByAmount.set(p.netMinor, []).get(p.netMinor)!).push(p);
  const used = new Set<string>();
  const transfers: Transfer[] = [];
  for (const d of people) {
    if (d.netMinor >= 0) continue;
    const queue = creditorsByAmount.get(-d.netMinor);
    const c = queue?.shift(); // people are in id order, so this is the lowest-id creditor left
    if (c) {
      used.add(d.memberId);
      used.add(c.memberId);
      transfers.push({ fromMemberId: d.memberId, toMemberId: c.memberId, amountMinor: -d.netMinor });
    }
  }
  return { transfers, rest: people.filter((p) => !used.has(p.memberId)) };
}

/** The exact search (see the header): the largest split into zero-sum groups, then the greedy rule inside each group. */
function exactGroups(people: Person[]): Transfer[] {
  const k = people.length;
  if (k === 0) return [];
  const size = 1 << k;
  const sum = new Float64Array(size); // every value is an exact integer below 2^53 (checked before)
  const best = new Uint8Array(size);
  const via = new Int8Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sum[mask] = sum[mask & (mask - 1)]! + people[low]!.netMinor;
    const isZero = sum[mask] === 0 ? 1 : 0;
    let top = -1;
    let pick = 0;
    for (let rest = mask; rest !== 0; rest &= rest - 1) {
      const i = 31 - Math.clz32(rest & -rest);
      const value = best[mask ^ (1 << i)]!;
      if (value > top) {
        top = value;
        pick = i;
      }
    }
    best[mask] = top + isZero;
    via[mask] = pick;
  }
  // Walk back from the full set, then cut at the zero-sum prefixes.
  const chain: number[] = [];
  for (let mask = size - 1; mask !== 0; mask ^= 1 << via[mask]!) chain.push(mask);
  const groups: number[] = [];
  let previous = 0;
  for (let n = chain.length - 1; n >= 0; n--) {
    const mask = chain[n]!;
    if (sum[mask] === 0) {
      groups.push(mask ^ previous);
      previous = mask;
    }
  }
  const transfers: Transfer[] = [];
  for (const group of groups) {
    const members = people.filter((_, i) => (group & (1 << i)) !== 0);
    transfers.push(...suggestSettlements(members.map((p) => ({ memberId: p.memberId, netMinor: p.netMinor }))));
  }
  return transfers;
}

/** The settlement plan for a trip's balances. See the header for the rules, the maths and the guarantees. */
export function planSettlement(balances: readonly PlanBalance[]): SettlementPlan {
  if (!Array.isArray(balances)) throw new SettlementPlanError('INVALID_INPUT', 'The balances are not a list');
  for (const b of balances as readonly unknown[]) {
    const r = b as Partial<PlanBalance> | null;
    if (typeof r !== 'object' || r === null || typeof r.memberId !== 'string' || r.memberId === '' || typeof r.netMinor !== 'number' || typeof r.active !== 'boolean') {
      throw new SettlementPlanError('INVALID_INPUT', 'A balance entry is malformed');
    }
  }
  const seen = new Set<string>();
  let total = 0;
  let magnitude = 0;
  for (const b of balances) {
    try {
      assertSafeMinor(b.netMinor, 'balance');
    } catch {
      throw new SettlementPlanError('UNSAFE_AMOUNT', 'A balance is not a whole number of paise', { memberId: b.memberId });
    }
    if (seen.has(b.memberId)) throw new SettlementPlanError('DUPLICATE_MEMBER', 'A member appears more than once', { memberId: b.memberId });
    seen.add(b.memberId);
    if (b.netMinor !== 0 && !b.active) {
      throw new SettlementPlanError('FORMER_MEMBER_BALANCE', 'A member who left still has a balance', { memberId: b.memberId });
    }
    total += b.netMinor;
    magnitude += Math.abs(b.netMinor);
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(magnitude)) {
      throw new SettlementPlanError('UNSAFE_AMOUNT', 'The balances are too large to settle exactly', { memberId: b.memberId });
    }
  }
  if (total !== 0) throw new SettlementPlanError('NOT_ZERO_SUM', 'The balances do not add up to zero', { sumMinor: total });

  const people: Person[] = balances
    .filter((b) => b.netMinor !== 0)
    .map((b) => ({ memberId: b.memberId, netMinor: b.netMinor }))
    .sort((a, b) => byId(a.memberId, b.memberId));
  const k = people.length;
  if (k === 0) return { transfers: [], peopleWithBalance: 0, quality: 'exact', guaranteedMinimum: true };

  const { transfers: pairs, rest } = removeExactPairs(people);
  if (k <= EXACT_LIMIT) {
    return { transfers: sortTransfers([...pairs, ...exactGroups(rest)]), peopleWithBalance: k, quality: 'exact', guaranteedMinimum: true };
  }
  const ours = [...pairs, ...suggestSettlements(rest)];
  const plain = suggestSettlements(people);
  return { transfers: sortTransfers(plain.length < ours.length ? plain : ours), peopleWithBalance: k, quality: 'suggested', guaranteedMinimum: false };
}
