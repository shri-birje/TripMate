/**
 * Test helpers only. NOT exported from index.ts and never shipped in the app.
 */
import { expect } from 'vitest';
import { allocateByWeights } from './allocate';
import type { LedgerExpense, LedgerRepayment, RepaymentStatus } from './balances';
import { CoreError, type CoreErrorCode } from './errors';
import { computeExpense, type SplitSpec } from './split';

/** Asserts that `fn` throws a CoreError with the given code, and returns it. */
export function expectCoreError(fn: () => unknown, code: CoreErrorCode): CoreError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CoreError);
    expect((e as CoreError).code).toBe(code);
    return e as CoreError;
  }
  throw new Error(`Expected CoreError ${code} but nothing was thrown`);
}

/** Small deterministic random generator (mulberry32). Same seed = same trip, so any failure is reproducible. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** Integer in [min, max]. */
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    chance: (p: number) => next() < p,
    /** Random non-empty subset (in original order). */
    subset: <T>(items: readonly T[]): T[] => {
      const picked = items.filter(() => next() < 0.5);
      return picked.length > 0 ? picked : [items[Math.floor(next() * items.length)]!];
    },
  };
}

export interface RandomTrip {
  ids: string[];
  expenses: LedgerExpense[];
  repayments: LedgerRepayment[];
}

/** Builds a random but VALID trip using the real engine. Used by property tests. */
export function buildRandomTrip(seed: number): RandomTrip {
  const rng = makeRng(seed);
  const n = rng.int(2, 6);
  const ids = Array.from({ length: n }, (_, i) => `m${i + 1}`);

  const expenses: LedgerExpense[] = [];
  const expenseCount = rng.int(0, 8);
  for (let i = 0; i < expenseCount; i++) {
    const amountMinor = rng.int(1, 5_000_000);
    const payerIds = rng.subset(ids);
    const payers = allocateByWeights(
      amountMinor,
      payerIds.map((id) => ({ id, weight: 1 })),
    )
      .filter((a) => a.amountMinor > 0)
      .map((a) => ({ memberId: a.id, paidMinor: a.amountMinor }));
    // (With tiny amounts a payer could get 0 paise; those are dropped. The rest still add up.)

    const participants = rng.subset(ids);
    const method = rng.int(0, 3);
    let split: SplitSpec;
    if (method === 0) {
      split = { method: 'equal', participants };
    } else if (method === 1) {
      split = { method: 'shares', inputs: participants.map((memberId) => ({ memberId, weight: rng.int(1, 5) })) };
    } else if (method === 2) {
      const bps = allocateByWeights(
        10_000,
        participants.map((id) => ({ id, weight: rng.int(1, 100) })),
      );
      split = { method: 'percentage', inputs: bps.map((b) => ({ memberId: b.id, basisPoints: b.amountMinor })) };
    } else {
      const exact = allocateByWeights(
        amountMinor,
        participants.map((id) => ({ id, weight: rng.int(1, 50) })),
      );
      split = { method: 'exact', inputs: exact.map((a) => ({ memberId: a.id, amountMinor: a.amountMinor })) };
    }

    const computed = computeExpense({ amountMinor, payers, split });
    expenses.push({
      id: `e${i + 1}`,
      title: `Expense ${i + 1}`,
      payers: computed.payers,
      splits: computed.splits.map((s) => ({ memberId: s.memberId, shareMinor: s.shareMinor })),
      deleted: rng.chance(0.1),
      scope: rng.chance(0.1) ? 'personal' : 'shared',
    });
  }

  const statuses: RepaymentStatus[] = ['pending', 'paid', 'confirmed', 'cancelled'];
  const repayments: LedgerRepayment[] = [];
  const repaymentCount = rng.int(0, 6);
  for (let i = 0; i < repaymentCount; i++) {
    const from = rng.int(0, n - 1);
    let to = rng.int(0, n - 1);
    if (to === from) to = (to + 1) % n;
    repayments.push({
      id: `r${i + 1}`,
      fromMemberId: ids[from]!,
      toMemberId: ids[to]!,
      amountMinor: rng.int(1, 3_000_000),
      status: statuses[rng.int(0, 3)]!,
    });
  }
  return { ids, expenses, repayments };
}
