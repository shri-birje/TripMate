import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBalances, type LedgerExpense, type LedgerRepayment } from './balances';
import { explainBalance } from './explain';
import { computeExpense } from './split';
import { buildRandomTrip } from './testkit';

function expense(id: string, title: string, amount: number, payer: string, participants: string[]): LedgerExpense {
  const c = computeExpense({
    amountMinor: amount,
    payers: [{ memberId: payer, paidMinor: amount }],
    split: { method: 'equal', participants },
  });
  return { id, title, payers: c.payers, splits: c.splits.map((s) => ({ memberId: s.memberId, shareMinor: s.shareMinor })) };
}

describe('explainBalance', () => {
  const expenses = [
    expense('e1', 'Petrol', 300000, 'shri', ['shri', 'rahul', 'amit', 'kiran']),
    expense('e2', 'Lunch', 120000, 'rahul', ['rahul', 'amit']),
  ];

  it('lists the expenses behind a balance with what was paid and what was owed', () => {
    const x = explainBalance('rahul', expenses, []);
    expect(x.lines).toEqual([
      { kind: 'expense', expenseId: 'e1', title: 'Petrol', paidMinor: 0, shareMinor: 75000, effectConfirmedMinor: -75000, effectProjectedMinor: -75000 },
      { kind: 'expense', expenseId: 'e2', title: 'Lunch', paidMinor: 120000, shareMinor: 60000, effectConfirmedMinor: 60000, effectProjectedMinor: 60000 },
    ]);
    expect(x.netConfirmedMinor).toBe(-15000);
  });

  it('leaves out expenses the member was not part of', () => {
    const x = explainBalance('kiran', expenses, []);
    expect(x.lines.map((l) => (l.kind === 'expense' ? l.expenseId : ''))).toEqual(['e1']);
  });

  it('a member with no involvement has no lines and a zero balance', () => {
    const x = explainBalance('stranger', expenses, []);
    expect(x.lines).toEqual([]);
    expect(x.netConfirmedMinor).toBe(0);
    expect(x.netProjectedMinor).toBe(0);
  });

  it('shows repayments and whether each one counts yet', () => {
    const repayments: LedgerRepayment[] = [
      { id: 'r1', fromMemberId: 'rahul', toMemberId: 'shri', amountMinor: 5000, status: 'paid' },
      { id: 'r2', fromMemberId: 'rahul', toMemberId: 'shri', amountMinor: 3000, status: 'pending' },
      { id: 'r3', fromMemberId: 'amit', toMemberId: 'rahul', amountMinor: 1000, status: 'confirmed' },
    ];
    const x = explainBalance('rahul', expenses, repayments);
    const reps = x.lines.filter((l) => l.kind === 'repayment');
    expect(reps).toHaveLength(3);
    const r1 = reps.find((l) => l.kind === 'repayment' && l.repaymentId === 'r1')!;
    expect(r1).toMatchObject({ direction: 'sent', otherMemberId: 'shri', countsInConfirmed: false, countsInProjected: true, effectProjectedMinor: 5000, effectConfirmedMinor: 0 });
    const r2 = reps.find((l) => l.kind === 'repayment' && l.repaymentId === 'r2')!;
    expect(r2).toMatchObject({ countsInConfirmed: false, countsInProjected: false, effectProjectedMinor: 0 });
    const r3 = reps.find((l) => l.kind === 'repayment' && l.repaymentId === 'r3')!;
    expect(r3).toMatchObject({ direction: 'received', otherMemberId: 'amit', countsInConfirmed: true, effectConfirmedMinor: -1000 });
  });

  it('ignores deleted and personal expenses', () => {
    const extra: LedgerExpense[] = [
      { ...expense('d', 'Deleted', 1000, 'shri', ['shri', 'rahul']), deleted: true },
      { ...expense('p', 'Private', 1000, 'rahul', ['rahul']), scope: 'personal' },
    ];
    const x = explainBalance('rahul', [...expenses, ...extra], []);
    expect(x.lines.map((l) => (l.kind === 'expense' ? l.expenseId : ''))).toEqual(['e1', 'e2']);
  });

  it('lines always add up to the balance, and match computeBalances (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const t = buildRandomTrip(seed);
        const balances = computeBalances(t.ids, t.expenses, t.repayments);
        for (const b of balances) {
          const x = explainBalance(b.memberId, t.expenses, t.repayments);
          expect(x.lines.reduce((s, l) => s + l.effectConfirmedMinor, 0)).toBe(b.netConfirmedMinor);
          expect(x.lines.reduce((s, l) => s + l.effectProjectedMinor, 0)).toBe(b.netProjectedMinor);
          expect(x.netConfirmedMinor).toBe(b.netConfirmedMinor);
          expect(x.netProjectedMinor).toBe(b.netProjectedMinor);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
