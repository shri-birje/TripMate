import { describe, expect, it } from 'vitest';
import { planSettlement } from './settlementPlan';
import { SETTLEMENT_DISCLAIMER, SETTLEMENT_FAILURE_MESSAGES, SETTLEMENT_INEXACT_NOTE, classifySettlementFailure, settlementFailureMessage, settlementView } from './settlementView';

const names: Record<string, string> = { a: 'Asha', r: 'Ravi', p: 'Priya', g: 'Gita (left)' };
const f = (meId: string | null) => ({ meId, name: (id: string) => names[id] ?? 'Someone', money: (m: number) => `₹${m / 100}` });
const plan = planSettlement([
  { memberId: 'a', netMinor: -50000, active: true },
  { memberId: 'r', netMinor: -30000, active: true },
  { memberId: 'p', netMinor: 80000, active: true },
]);

describe('how the plan reads', () => {
  it('lists every payment in the approved wording', () => {
    const v = settlementView(plan, f(null));
    expect(v.lines.map((l) => l.text)).toEqual(['Asha pays Priya ₹500', 'Ravi pays Priya ₹300']);
    expect(v.headline).toBe('2 payments settle everyone.');
    expect(v.mine).toEqual([]); // not known who is looking: no personal line
    expect(v.inexactNote).toBeNull();
  });

  it('the personal lines: You pay, You receive, You are settled', () => {
    expect(settlementView(plan, f('a')).mine).toEqual(['You pay Priya ₹500']);
    expect(settlementView(plan, f('p')).mine).toEqual(['You receive ₹500 from Asha', 'You receive ₹300 from Ravi']);
    const settled = planSettlement([...[{ memberId: 'a', netMinor: 0, active: true }], { memberId: 'r', netMinor: -100, active: true }, { memberId: 'p', netMinor: 100, active: true }]);
    expect(settlementView(settled, f('a')).mine).toEqual(['You are settled']);
  });

  it('marks the lines that involve the signed-in person', () => {
    expect(settlementView(plan, f('r')).lines.map((l) => l.involvesMe)).toEqual([false, true]);
  });

  it('an empty plan says everyone is settled; one payment is singular; a person who is not on the trip gets no personal line', () => {
    const empty = planSettlement([]);
    expect(settlementView(empty, f('a')).headline).toBe('Everyone is settled.');
    const one = planSettlement([{ memberId: 'a', netMinor: -100, active: true }, { memberId: 'p', netMinor: 100, active: true }]);
    expect(settlementView(one, f('a')).headline).toBe('1 payment settles everyone.');
    expect(settlementView(one, f('a'), false).mine).toEqual([]);
  });

  it('only a plan that is not proven minimal carries the "may not be the fewest" note, and the disclaimer never claims money moves', () => {
    const nets = Array.from({ length: 24 }, (_, i) => ({ memberId: `m${String(i).padStart(2, '0')}`, netMinor: i < 23 ? (i % 2 ? -(i + 1) * 7 : (i + 1) * 5) : 0, active: true }));
    const sum = nets.reduce((s, n) => s + n.netMinor, 0);
    nets[23]!.netMinor = -sum;
    const big = planSettlement(nets);
    expect(big.guaranteedMinimum).toBe(false);
    expect(settlementView(big, f(null)).inexactNote).toBe(SETTLEMENT_INEXACT_NOTE);
    expect(SETTLEMENT_DISCLAIMER).toMatch(/does not move any money or record repayments/);
    expect(SETTLEMENT_DISCLAIMER).toMatch(/can change when expenses change/);
  });
});

describe('why no plan could be made: each case is classified and worded on its own', () => {
  const attempt = (input: unknown) => {
    let plan: unknown;
    let error: unknown = null;
    try {
      plan = planSettlement(input as never);
    } catch (e) {
      error = e;
    }
    return { plan, error, kind: error === null ? null : classifySettlementFailure(error) };
  };
  const ok = (id: string, n: number, active = true) => ({ memberId: id, netMinor: n, active });

  it('balances that do not add up to zero', () => {
    const r = attempt([ok('a', -100), ok('b', 99)]);
    expect(r.kind).toBe('not_zero_sum');
    expect(settlementFailureMessage(r.kind!)).toBe("The balances don't add up to zero, so no payments can be suggested. Reload to try again.");
  });

  it('a former member who still has a balance (either direction)', () => {
    for (const n of [100, -100]) {
      const r = attempt([ok('a', -n), ok('gone', n, false)]);
      expect(r.kind).toBe('former_member_balance');
      expect(settlementFailureMessage(r.kind!)).toBe(
        'Someone who left the trip still has a balance, which should not happen, so no payments can be suggested. Check the expenses that involve people who left.',
      );
    }
  });

  it('unsafe or unsupported amounts: fractions, NaN, infinity, beyond the safe integers, and sums too large to add exactly', () => {
    for (const input of [
      [ok('a', 1.5), ok('b', -1.5)],
      [ok('a', Number.NaN)],
      [ok('a', Number.POSITIVE_INFINITY), ok('b', Number.NEGATIVE_INFINITY)],
      [ok('a', 2 ** 53), ok('b', -(2 ** 53))],
      [ok('a', Number.MAX_SAFE_INTEGER), ok('b', -Number.MAX_SAFE_INTEGER)],
    ]) {
      const r = attempt(input);
      expect(r.kind).toBe('unsafe_amount');
      expect(settlementFailureMessage(r.kind!)).toBe('Some amounts are too large or are not valid money amounts, so no payments can be suggested.');
    }
  });

  it('other invalid input: a repeated member, malformed entries, a list that is not a list', () => {
    const bad: unknown[] = [
      [ok('a', 0), ok('a', 0)],
      [{ memberId: '', netMinor: 0, active: true }],
      [{ netMinor: 0, active: true }],
      [{ memberId: 'a', netMinor: '100', active: true }],
      [{ memberId: 'a', netMinor: 0 }],
      [null],
      'not a list',
      null,
      undefined,
    ];
    for (const input of bad) {
      const r = attempt(input);
      expect(r.kind, JSON.stringify(input)).toBe('invalid_input');
      expect(settlementFailureMessage(r.kind!)).toBe('The balance information looks invalid, so no payments can be suggested. Reload to try again.');
    }
  });

  it('anything that is not a plan error is also invalid input, never an unexplained failure', () => {
    expect(classifySettlementFailure(new Error('boom'))).toBe('invalid_input');
    expect(classifySettlementFailure('text')).toBe('invalid_input');
    expect(classifySettlementFailure(undefined)).toBe('invalid_input');
  });

  it('every failure throws before any plan exists: a failed check never returns even a partial plan', () => {
    const inputs: unknown[] = [
      [ok('a', -100), ok('b', 99)],
      [ok('a', -100), ok('gone', 100, false)],
      [ok('a', 1.5), ok('b', -1.5)],
      [ok('a', 0), ok('a', 0)],
      [ok('a', -5), ok('b', -5), ok('c', 10), ok('d', 3)], // would partly settle, but does not add up
    ];
    for (const input of inputs) {
      const r = attempt(input);
      expect(r.plan).toBeUndefined();
      expect(r.error).not.toBeNull();
    }
  });

  it('the four messages are different from each other and none of them leaks a code or says a plan exists', () => {
    const messages = Object.values(SETTLEMENT_FAILURE_MESSAGES);
    expect(new Set(messages).size).toBe(4);
    for (const m of messages) {
      expect(m).toMatch(/no payments can be suggested/);
      expect(m).not.toMatch(/NOT_ZERO_SUM|FORMER_MEMBER|UNSAFE_AMOUNT|INVALID_INPUT|DUPLICATE_MEMBER|undefined|null/);
    }
  });
});
