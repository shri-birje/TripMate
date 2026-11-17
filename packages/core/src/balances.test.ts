import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBalances, type LedgerExpense, type LedgerRepayment } from './balances';
import { computeExpense } from './split';
import { buildRandomTrip, expectCoreError } from './testkit';

const RUPEE = 100; // paise per rupee

/** The six-friend example from the product brief: everyone's share is Rs 8,000. */
const FRIENDS = ['shri', 'rahul', 'amit', 'kiran', 'rohan', 'akash'];
const PAID_BY: Record<string, number> = {
  shri: 15000,
  rahul: 12000,
  amit: 10000,
  kiran: 5000,
  rohan: 4000,
  akash: 2000,
};

/**
 * The brief treats the trip as one pool: Rs 48,000 in total, split six ways
 * (exactly Rs 8,000 each), with six people having paid different parts.
 * That is ONE expense with SIX payers.
 */
function briefExpenses(): LedgerExpense[] {
  const amountMinor = 48000 * RUPEE;
  const c = computeExpense({
    amountMinor,
    payers: FRIENDS.map((memberId) => ({ memberId, paidMinor: PAID_BY[memberId]! * RUPEE })),
    split: { method: 'equal', participants: FRIENDS },
  });
  return [
    {
      id: 'goa-trip',
      title: 'Goa trip (all costs)',
      payers: c.payers,
      splits: c.splits.map((s) => ({ memberId: s.memberId, shareMinor: s.shareMinor })),
    },
  ];
}

/** Same money, but entered the way people really do: each bill is its own expense, split six ways. */
function briefExpensesBillByBill(): LedgerExpense[] {
  return FRIENDS.map((payer) => {
    const amountMinor = PAID_BY[payer]! * RUPEE;
    const c = computeExpense({
      amountMinor,
      payers: [{ memberId: payer, paidMinor: amountMinor }],
      split: { method: 'equal', participants: FRIENDS },
    });
    return {
      id: `bill-${payer}`,
      payers: c.payers,
      splits: c.splits.map((s) => ({ memberId: s.memberId, shareMinor: s.shareMinor })),
    };
  });
}

const netsOf = (rows: { memberId: string; netConfirmedMinor: number }[]) =>
  Object.fromEntries(rows.map((r) => [r.memberId, r.netConfirmedMinor / RUPEE]));

describe('computeBalances - the brief example', () => {
  it('totals Rs 48,000 and gives everyone a Rs 8,000 share', () => {
    const b = computeBalances(FRIENDS, briefExpenses(), []);
    expect(b.every((m) => m.shareMinor === 8000 * RUPEE)).toBe(true);
    expect(b.reduce((s, m) => s + m.paidMinor, 0)).toBe(48000 * RUPEE);
  });

  it('computes each net balance (positive = should receive)', () => {
    const b = computeBalances(FRIENDS, briefExpenses(), []);
    expect(netsOf(b)).toEqual({
      shri: 7000,
      rahul: 4000,
      amit: 2000,
      kiran: -3000,
      rohan: -4000,
      akash: -6000,
    });
  });

  it('nets always add up to zero', () => {
    const b = computeBalances(FRIENDS, briefExpenses(), []);
    expect(b.reduce((s, m) => s + m.netConfirmedMinor, 0)).toBe(0);
    expect(b.reduce((s, m) => s + m.netProjectedMinor, 0)).toBe(0);
  });

  it('entering each bill separately can drift by a few paise but never loses money', () => {
    // Rs 10,000 / 6 is not a whole number of paise, so each separate bill rounds.
    // Each bill moves a person by at most 1 paisa from the pooled figure.
    const b = computeBalances(FRIENDS, briefExpensesBillByBill(), []);
    const target: Record<string, number> = { shri: 7000, rahul: 4000, amit: 2000, kiran: -3000, rohan: -4000, akash: -6000 };
    for (const m of b) {
      expect(Math.abs(m.netConfirmedMinor - target[m.memberId]! * RUPEE)).toBeLessThanOrEqual(FRIENDS.length);
    }
    expect(b.reduce((s, m) => s + m.netConfirmedMinor, 0)).toBe(0);
  });
});

describe('computeBalances - repayment status (product rule 12)', () => {
  const repay = (status: LedgerRepayment['status']): LedgerRepayment => ({
    id: 'r1',
    fromMemberId: 'akash',
    toMemberId: 'shri',
    amountMinor: 6000 * RUPEE,
    status,
  });
  const akash = (rs: LedgerRepayment[]) => computeBalances(FRIENDS, briefExpenses(), rs).find((m) => m.memberId === 'akash')!;
  const shri = (rs: LedgerRepayment[]) => computeBalances(FRIENDS, briefExpenses(), rs).find((m) => m.memberId === 'shri')!;

  it('pending changes nothing', () => {
    expect(akash([repay('pending')]).netConfirmedMinor).toBe(-6000 * RUPEE);
    expect(akash([repay('pending')]).netProjectedMinor).toBe(-6000 * RUPEE);
  });

  it('paid changes the projected balance only, and shows the awaiting amount', () => {
    const a = akash([repay('paid')]);
    expect(a.netConfirmedMinor).toBe(-6000 * RUPEE);
    expect(a.netProjectedMinor).toBe(0);
    expect(a.awaitingConfirmationMinor).toBe(6000 * RUPEE);
    const s = shri([repay('paid')]);
    expect(s.netConfirmedMinor).toBe(7000 * RUPEE);
    expect(s.netProjectedMinor).toBe(1000 * RUPEE);
  });

  it('confirmed changes both balances', () => {
    const a = akash([repay('confirmed')]);
    expect(a.netConfirmedMinor).toBe(0);
    expect(a.netProjectedMinor).toBe(0);
    expect(a.awaitingConfirmationMinor).toBe(0);
  });

  it('cancelled changes nothing', () => {
    expect(akash([repay('cancelled')]).netConfirmedMinor).toBe(-6000 * RUPEE);
    expect(akash([repay('cancelled')]).netProjectedMinor).toBe(-6000 * RUPEE);
  });

  it('supports partial repayments that add up', () => {
    const part = (id: string, amt: number): LedgerRepayment => ({
      id,
      fromMemberId: 'akash',
      toMemberId: 'shri',
      amountMinor: amt * RUPEE,
      status: 'confirmed',
    });
    const a = akash([part('p1', 2500), part('p2', 1500)]);
    expect(a.netConfirmedMinor).toBe(-2000 * RUPEE);
  });

  it('counts each repayment once even if several exist between the same pair', () => {
    const rs: LedgerRepayment[] = [
      { id: 'r1', fromMemberId: 'akash', toMemberId: 'shri', amountMinor: 100 * RUPEE, status: 'confirmed' },
      { id: 'r2', fromMemberId: 'akash', toMemberId: 'shri', amountMinor: 100 * RUPEE, status: 'confirmed' },
    ];
    expect(akash(rs).netConfirmedMinor).toBe(-5800 * RUPEE);
  });
});

describe('computeBalances - which expenses count', () => {
  it('ignores soft-deleted expenses (as if they never existed)', () => {
    const all = briefExpenses();
    const withDeleted: LedgerExpense[] = [
      ...all,
      { id: 'oops', payers: [{ memberId: 'shri', paidMinor: 99900 }], splits: [{ memberId: 'rahul', shareMinor: 99900 }], deleted: true },
    ];
    expect(computeBalances(FRIENDS, withDeleted, [])).toEqual(computeBalances(FRIENDS, all, []));
  });

  it('ignores personal expenses (product rule 9)', () => {
    const all = briefExpenses();
    const withPersonal: LedgerExpense[] = [
      ...all,
      { id: 'mine', payers: [{ memberId: 'shri', paidMinor: 5000 }], splits: [{ memberId: 'shri', shareMinor: 5000 }], scope: 'personal' },
    ];
    expect(computeBalances(FRIENDS, withPersonal, [])).toEqual(computeBalances(FRIENDS, all, []));
  });

  it('editing an expense and reverting it restores the original balances (rule 11)', () => {
    const original = briefExpenses();
    const before = computeBalances(FRIENDS, original, []);
    // "Edit" the expense: now Shri paid the whole Rs 60,000 alone.
    const c = computeExpense({
      amountMinor: 6_000_000,
      payers: [{ memberId: 'shri', paidMinor: 6_000_000 }],
      split: { method: 'equal', participants: FRIENDS },
    });
    const edited: LedgerExpense[] = [
      { id: 'goa-trip', payers: c.payers, splits: c.splits.map((s) => ({ memberId: s.memberId, shareMinor: s.shareMinor })) },
    ];
    const during = computeBalances(FRIENDS, edited, []);
    expect(during).not.toEqual(before);
    expect(computeBalances(FRIENDS, original, [])).toEqual(before);
  });

  it('does not depend on the order of the records', () => {
    const e = briefExpenses();
    expect(computeBalances(FRIENDS, [...e].reverse(), [])).toEqual(computeBalances(FRIENDS, e, []));
  });

  it('a member who paid for others but did not join is owed the whole amount', () => {
    const c = computeExpense({
      amountMinor: 1000,
      payers: [{ memberId: 'host', paidMinor: 1000 }],
      split: { method: 'equal', participants: ['x', 'y'] },
    });
    const b = computeBalances(
      ['host', 'x', 'y'],
      [{ id: 'e', payers: c.payers, splits: c.splits.map((s) => ({ memberId: s.memberId, shareMinor: s.shareMinor })) }],
      [],
    );
    expect(b.find((m) => m.memberId === 'host')!.netConfirmedMinor).toBe(1000);
    expect(b.find((m) => m.memberId === 'x')!.netConfirmedMinor).toBe(-500);
  });
});

describe('computeBalances - refuses corrupt data instead of guessing', () => {
  it('rejects an expense where paid != sum of shares', () => {
    const bad: LedgerExpense = {
      id: 'bad',
      payers: [{ memberId: 'a', paidMinor: 1000 }],
      splits: [{ memberId: 'a', shareMinor: 999 }],
    };
    const e = expectCoreError(() => computeBalances(['a'], [bad], []), 'INCONSISTENT_EXPENSE');
    expect(e.details).toMatchObject({ expenseId: 'bad', paidMinor: 1000, sharesMinor: 999 });
  });

  it('rejects records that mention an unknown member', () => {
    const e: LedgerExpense = { id: 'e', payers: [{ memberId: 'ghost', paidMinor: 10 }], splits: [{ memberId: 'a', shareMinor: 10 }] };
    expectCoreError(() => computeBalances(['a'], [e], []), 'UNKNOWN_MEMBER');
    expectCoreError(
      () => computeBalances(['a'], [], [{ id: 'r', fromMemberId: 'a', toMemberId: 'ghost', amountMinor: 5, status: 'paid' }]),
      'UNKNOWN_MEMBER',
    );
  });

  it('still counts removed members as long as they are listed', () => {
    const c = computeExpense({
      amountMinor: 1000,
      payers: [{ memberId: 'gone', paidMinor: 1000 }],
      split: { method: 'equal', participants: ['gone', 'stay'] },
    });
    const b = computeBalances(
      ['gone', 'stay'],
      [{ id: 'e', payers: c.payers, splits: c.splits.map((s) => ({ memberId: s.memberId, shareMinor: s.shareMinor })) }],
      [],
    );
    expect(b.find((m) => m.memberId === 'stay')!.netConfirmedMinor).toBe(-500);
  });

  it('rejects zero-amount, negative or self repayments', () => {
    const base = { id: 'r', status: 'paid' as const };
    expectCoreError(() => computeBalances(['a', 'b'], [], [{ ...base, fromMemberId: 'a', toMemberId: 'b', amountMinor: 0 }]), 'INVALID_AMOUNT');
    expectCoreError(() => computeBalances(['a', 'b'], [], [{ ...base, fromMemberId: 'a', toMemberId: 'b', amountMinor: -5 }]), 'INVALID_AMOUNT');
    expectCoreError(() => computeBalances(['a', 'b'], [], [{ ...base, fromMemberId: 'a', toMemberId: 'a', amountMinor: 5 }]), 'INVALID_AMOUNT');
  });

  it('returns zeros for a trip with no records', () => {
    const b = computeBalances(['a', 'b'], [], []);
    expect(b.every((m) => m.netConfirmedMinor === 0 && m.paidMinor === 0)).toBe(true);
  });
});

describe('computeBalances - properties on random trips', () => {
  it('never loses money: nets sum to zero, paid sum equals share sum', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const t = buildRandomTrip(seed);
        const b = computeBalances(t.ids, t.expenses, t.repayments);
        expect(b.reduce((s, m) => s + m.netConfirmedMinor, 0)).toBe(0);
        expect(b.reduce((s, m) => s + m.netProjectedMinor, 0)).toBe(0);
        expect(b.reduce((s, m) => s + m.paidMinor, 0)).toBe(b.reduce((s, m) => s + m.shareMinor, 0));
      }),
      { numRuns: 3000 },
    );
  });

  it('is independent of record order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const t = buildRandomTrip(seed);
        const forward = computeBalances(t.ids, t.expenses, t.repayments);
        const reversed = computeBalances(t.ids, [...t.expenses].reverse(), [...t.repayments].reverse());
        expect(reversed).toEqual(forward);
      }),
      { numRuns: 1500 },
    );
  });
});
