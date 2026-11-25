import { describe, expect, it } from 'vitest';
import { computeBalances, type LedgerExpense } from './balances';
import { CoreError } from './errors';
import { computeSplit, type SplitSpec } from './split';
import { BAD_SPLIT_VECTORS, LEDGER_VECTORS, MEMBER_IDS, SPLIT_VECTORS, vid, type SplitMethodName, type VectorOp } from '../test-fixtures/expenseVectors';

/**
 * The TypeScript side of the golden vectors (M5, ADR-063). The same hand-verified numbers are checked against the
 * database functions in supabase/tests, so the two implementations cannot drift apart.
 */
function specFor(method: SplitMethodName | undefined, participants: readonly string[], inputs: Record<string, number> | undefined): SplitSpec {
  if (!method || method === 'equal') return { method: 'equal', participants };
  const ids = participants.slice();
  const val = (id: string) => inputs![id]!;
  if (method === 'percentage') return { method, inputs: ids.map((memberId) => ({ memberId, basisPoints: val(memberId) })) };
  if (method === 'exact') return { method, inputs: ids.map((memberId) => ({ memberId, amountMinor: val(memberId) })) };
  return { method, inputs: ids.map((memberId) => ({ memberId, weight: val(memberId) })) };
}

describe('golden vectors: individual allocations (every split method)', () => {
  for (const v of SPLIT_VECTORS) {
    it(v.name, () => {
      const result = computeSplit(v.amountMinor, specFor(v.method, v.participants, v.inputs));
      const got = Object.fromEntries(result.map((r) => [r.memberId, r.shareMinor]));
      expect(got).toEqual(v.shares);
      expect(result.reduce((a, r) => a + r.shareMinor, 0)).toBe(v.amountMinor);
    });
  }

  it('the fixture itself is sound: every hand-written allocation adds up to its amount, with distinct participants', () => {
    for (const v of SPLIT_VECTORS) {
      expect(Object.values(v.shares).reduce((a, n) => a + n, 0), v.name).toBe(v.amountMinor);
      expect(new Set(v.participants).size, v.name).toBe(v.participants.length);
      if (v.method && v.method !== 'equal') expect(Object.keys(v.inputs ?? {}).sort(), v.name).toEqual([...v.participants].sort());
    }
  });

  it('ids that mix digits and letters really are ordered digits-first as plain text', () => {
    expect([vid('ff'), vid('10'), vid('a'), vid('9')].sort()).toEqual([vid('9'), vid('a'), vid('10'), vid('ff')]);
  });

  it('shares 1 : 1 : ... is the SAME rule as the equal split (so the database can use one allocation for both)', () => {
    for (const amount of [1, 2, 7, 99, 100, 1001, 123_456_789]) {
      for (const n of [1, 2, 3, 5, 7]) {
        const ids = Array.from({ length: n }, (_, i) => vid(`a${i}`));
        const equal = computeSplit(amount, { method: 'equal', participants: ids }).map((r) => [r.memberId, r.shareMinor]);
        const weighted = computeSplit(amount, { method: 'shares', inputs: ids.map((memberId) => ({ memberId, weight: 1 })) }).map((r) => [r.memberId, r.shareMinor]);
        expect(weighted, `${amount} among ${n}`).toEqual(equal);
      }
    }
  });

  it('the typed-value mistakes the engine itself refuses are refused with the engine\'s own codes (the limits are checked by the database and the form)', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof CoreError ? e.code : 'other';
      }
      return 'none';
    };
    for (const v of BAD_SPLIT_VECTORS) {
      const spec = specFor(v.method, v.participants, v.inputs);
      const expected = v.code === 'split_total_mismatch' ? (v.method === 'exact' ? 'SPLIT_SUM_MISMATCH' : 'PERCENT_SUM_INVALID') : 'INVALID_WEIGHT';
      const got = code(() => computeSplit(v.amountMinor, spec));
      // a value above the database's limit (percentage above 100%, a weight above 1,000,000) is an INPUT LIMIT, not an engine rule
      if (/above/.test(v.name)) expect(['none', 'PERCENT_SUM_INVALID']).toContain(got);
      else expect(got, v.name).toBe(expected);
    }
  });
});

describe('golden vectors: ledgers (member balances after every step)', () => {
  for (const vector of LEDGER_VECTORS) {
    it(vector.name, () => {
      const ids = vector.members.map((k) => MEMBER_IDS[k]!);
      interface Held { amount: number; payers: Record<string, number>; participants: string[]; split: { method: 'exact' | 'percentage' | 'shares'; values: Record<string, number> } | undefined; deleted: boolean }
      const expenses = new Map<string, Held>();
      const ledger = (): LedgerExpense[] =>
        [...expenses.entries()].map(([key, e]) => {
          const participants = e.participants.map((k) => MEMBER_IDS[k]!);
          const values = e.split ? Object.fromEntries(Object.entries(e.split.values).map(([k, n]) => [MEMBER_IDS[k]!, n])) : undefined;
          return {
            id: key,
            deleted: e.deleted,
            payers: Object.entries(e.payers).map(([k, paidMinor]) => ({ memberId: MEMBER_IDS[k]!, paidMinor })),
            splits: computeSplit(e.amount, specFor(e.split?.method, participants, values)).map((r) => ({ memberId: r.memberId, shareMinor: r.shareMinor })),
          };
        });

      vector.steps.forEach((step, i) => {
        const op: VectorOp = step.do;
        // A refused step changes nothing. (The refusal itself is a database rule, checked in the database suite.)
        if (!step.error) {
          if (op.op === 'create' || op.op === 'edit') expenses.set(op.key, { amount: op.amount, payers: op.payers, participants: op.participants, split: op.split, deleted: false });
          else if (op.op === 'delete') expenses.get(op.key)!.deleted = true;
          else if (op.op === 'restore') expenses.get(op.key)!.deleted = false;
          // remove and leave only change who is active: balances are untouched
        }
        const balances = computeBalances(ids, ledger(), []);
        const got = Object.fromEntries(vector.members.map((k) => [k, balances.find((b) => b.memberId === MEMBER_IDS[k])!.netConfirmedMinor]));
        expect(got, `step ${i + 1}: ${JSON.stringify(op)}`).toEqual(step.balances);
        expect(Object.values(step.balances).reduce((a, n) => a + n, 0), `step ${i + 1} sums to zero`).toBe(0);
      });
    });
  }
});
