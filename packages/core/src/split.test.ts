import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeExpense, computeSplit } from './split';
import { expectCoreError } from './testkit';

const shares = (r: { memberId: string; shareMinor: number }[]) =>
  Object.fromEntries(r.map((x) => [x.memberId, x.shareMinor]));
const total = (r: { shareMinor: number }[]) => r.reduce((s, x) => s + x.shareMinor, 0);

describe('computeSplit - equal', () => {
  it('splits the brief example: Rs 3,000 petrol among Shri, Rahul, Amit, Kiran', () => {
    const r = computeSplit(300000, { method: 'equal', participants: ['shri', 'rahul', 'amit', 'kiran'] });
    expect(shares(r)).toEqual({ shri: 75000, rahul: 75000, amit: 75000, kiran: 75000 });
  });

  it('charges ONLY the selected participants (product rule 4)', () => {
    // Six friends travel, but only four join the activity.
    const r = computeSplit(400000, { method: 'equal', participants: ['a', 'b', 'c', 'd'] });
    expect(r.map((x) => x.memberId).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(shares(r)).not.toHaveProperty('e');
    expect(shares(r)).not.toHaveProperty('f');
    expect(total(r)).toBe(400000);
  });

  it('handles amounts that do not divide evenly', () => {
    const r = computeSplit(100000, { method: 'equal', participants: ['a', 'b', 'c'] });
    expect(total(r)).toBe(100000);
    expect(r.every((x) => x.inputValue === null)).toBe(true);
  });

  it('works for one participant', () => {
    expect(shares(computeSplit(5000, { method: 'equal', participants: ['solo'] }))).toEqual({ solo: 5000 });
  });
});

describe('computeSplit - percentage', () => {
  it('splits by percentage and keeps the exact total', () => {
    const r = computeSplit(100000, {
      method: 'percentage',
      inputs: [
        { memberId: 'a', basisPoints: 3333 },
        { memberId: 'b', basisPoints: 3333 },
        { memberId: 'c', basisPoints: 3334 },
      ],
    });
    expect(total(r)).toBe(100000);
    expect(r.map((x) => x.inputValue)).toEqual([3333, 3333, 3334]);
  });

  it('50 / 30 / 20 on Rs 1,000', () => {
    const r = computeSplit(100000, {
      method: 'percentage',
      inputs: [
        { memberId: 'a', basisPoints: 5000 },
        { memberId: 'b', basisPoints: 3000 },
        { memberId: 'c', basisPoints: 2000 },
      ],
    });
    expect(shares(r)).toEqual({ a: 50000, b: 30000, c: 20000 });
  });

  it('rejects percentages that do not total exactly 100%', () => {
    const e = expectCoreError(
      () =>
        computeSplit(100000, {
          method: 'percentage',
          inputs: [
            { memberId: 'a', basisPoints: 5000 },
            { memberId: 'b', basisPoints: 4999 },
          ],
        }),
      'PERCENT_SUM_INVALID',
    );
    expect(e.details).toMatchObject({ expectedBasisPoints: 10000, actualBasisPoints: 9999 });
  });

  it('rejects a zero, fractional or negative percentage', () => {
    for (const bp of [0, -100, 50.5]) {
      expectCoreError(
        () =>
          computeSplit(1000, {
            method: 'percentage',
            inputs: [
              { memberId: 'a', basisPoints: bp },
              { memberId: 'b', basisPoints: 10000 },
            ],
          }),
        'INVALID_WEIGHT',
      );
    }
  });
});

describe('computeSplit - exact', () => {
  it('uses the exact amounts when they add up', () => {
    const r = computeSplit(100000, {
      method: 'exact',
      inputs: [
        { memberId: 'a', amountMinor: 70000 },
        { memberId: 'b', amountMinor: 30000 },
      ],
    });
    expect(shares(r)).toEqual({ a: 70000, b: 30000 });
    expect(r.map((x) => x.inputValue)).toEqual([70000, 30000]);
  });

  it('rejects amounts that do not add up, reporting both numbers', () => {
    const e = expectCoreError(
      () =>
        computeSplit(100000, {
          method: 'exact',
          inputs: [
            { memberId: 'a', amountMinor: 70000 },
            { memberId: 'b', amountMinor: 29999 },
          ],
        }),
      'SPLIT_SUM_MISMATCH',
    );
    expect(e.details).toMatchObject({ expectedMinor: 100000, actualMinor: 99999 });
  });

  it('allows a participant with a zero share but rejects a negative one', () => {
    const r = computeSplit(1000, {
      method: 'exact',
      inputs: [
        { memberId: 'a', amountMinor: 1000 },
        { memberId: 'b', amountMinor: 0 },
      ],
    });
    expect(shares(r)).toEqual({ a: 1000, b: 0 });
    expectCoreError(
      () =>
        computeSplit(1000, {
          method: 'exact',
          inputs: [
            { memberId: 'a', amountMinor: 1500 },
            { memberId: 'b', amountMinor: -500 },
          ],
        }),
      'INVALID_AMOUNT',
    );
  });
});

describe('computeSplit - shares (weights)', () => {
  it('splits 2 : 1 : 1', () => {
    const r = computeSplit(10000, {
      method: 'shares',
      inputs: [
        { memberId: 'a', weight: 2 },
        { memberId: 'b', weight: 1 },
        { memberId: 'c', weight: 1 },
      ],
    });
    expect(shares(r)).toEqual({ a: 5000, b: 2500, c: 2500 });
    expect(r.map((x) => x.inputValue)).toEqual([2, 1, 1]);
  });

  it('rejects zero or fractional weights', () => {
    expectCoreError(() => computeSplit(1000, { method: 'shares', inputs: [{ memberId: 'a', weight: 0 }] }), 'INVALID_WEIGHT');
    expectCoreError(() => computeSplit(1000, { method: 'shares', inputs: [{ memberId: 'a', weight: 1.5 }] }), 'INVALID_WEIGHT');
  });
});

describe('computeSplit - shared validation', () => {
  it('rejects empty participant lists for every method', () => {
    expectCoreError(() => computeSplit(1000, { method: 'equal', participants: [] }), 'NO_PARTICIPANTS');
    expectCoreError(() => computeSplit(1000, { method: 'percentage', inputs: [] }), 'NO_PARTICIPANTS');
    expectCoreError(() => computeSplit(1000, { method: 'exact', inputs: [] }), 'NO_PARTICIPANTS');
    expectCoreError(() => computeSplit(1000, { method: 'shares', inputs: [] }), 'NO_PARTICIPANTS');
  });

  it('rejects the same member listed twice for every method', () => {
    expectCoreError(() => computeSplit(1000, { method: 'equal', participants: ['a', 'a'] }), 'DUPLICATE_MEMBER');
    expectCoreError(
      () =>
        computeSplit(1000, {
          method: 'percentage',
          inputs: [
            { memberId: 'a', basisPoints: 5000 },
            { memberId: 'a', basisPoints: 5000 },
          ],
        }),
      'DUPLICATE_MEMBER',
    );
    expectCoreError(
      () =>
        computeSplit(1000, {
          method: 'exact',
          inputs: [
            { memberId: 'a', amountMinor: 500 },
            { memberId: 'a', amountMinor: 500 },
          ],
        }),
      'DUPLICATE_MEMBER',
    );
    expectCoreError(
      () =>
        computeSplit(1000, {
          method: 'shares',
          inputs: [
            { memberId: 'a', weight: 1 },
            { memberId: 'a', weight: 1 },
          ],
        }),
      'DUPLICATE_MEMBER',
    );
  });

  it('rejects a zero, negative or fractional expense amount', () => {
    for (const amount of [0, -100, 10.5]) {
      expectCoreError(() => computeSplit(amount, { method: 'equal', participants: ['a'] }), 'INVALID_AMOUNT');
    }
  });

  it('every method always adds up to the amount (property)', () => {
    const amountArb = fc.integer({ min: 1, max: 1_000_000_000 });
    const nArb = fc.integer({ min: 1, max: 8 });
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);

    fc.assert(
      fc.property(amountArb, nArb, fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 8, maxLength: 8 }), (amount, n, w) => {
        const members = ids(n);
        expect(total(computeSplit(amount, { method: 'equal', participants: members }))).toBe(amount);
        expect(
          total(computeSplit(amount, { method: 'shares', inputs: members.map((memberId, i) => ({ memberId, weight: w[i]! })) })),
        ).toBe(amount);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('computeExpense', () => {
  it('accepts one payer', () => {
    const r = computeExpense({
      amountMinor: 300000,
      payers: [{ memberId: 'shri', paidMinor: 300000 }],
      split: { method: 'equal', participants: ['shri', 'rahul', 'amit', 'kiran'] },
    });
    expect(total(r.splits)).toBe(300000);
    expect(r.payers).toEqual([{ memberId: 'shri', paidMinor: 300000 }]);
  });

  it('accepts several payers', () => {
    const r = computeExpense({
      amountMinor: 100000,
      payers: [
        { memberId: 'a', paidMinor: 60000 },
        { memberId: 'b', paidMinor: 40000 },
      ],
      split: { method: 'equal', participants: ['a', 'b', 'c'] },
    });
    expect(r.payers).toHaveLength(2);
    expect(total(r.splits)).toBe(100000);
  });

  it('allows the payer to be outside the participants (paid on behalf of others)', () => {
    const r = computeExpense({
      amountMinor: 1000,
      payers: [{ memberId: 'host', paidMinor: 1000 }],
      split: { method: 'equal', participants: ['x', 'y'] },
    });
    expect(r.splits.map((s) => s.memberId)).not.toContain('host');
  });

  it('rejects when what was paid does not equal the amount', () => {
    const e = expectCoreError(
      () =>
        computeExpense({
          amountMinor: 100000,
          payers: [{ memberId: 'a', paidMinor: 90000 }],
          split: { method: 'equal', participants: ['a', 'b'] },
        }),
      'PAYERS_SUM_MISMATCH',
    );
    expect(e.details).toMatchObject({ expectedMinor: 100000, actualMinor: 90000 });
  });

  it('rejects no payers, duplicate payers and non-positive payments', () => {
    const split = { method: 'equal', participants: ['a'] } as const;
    expectCoreError(() => computeExpense({ amountMinor: 100, payers: [], split }), 'NO_PAYERS');
    expectCoreError(
      () =>
        computeExpense({
          amountMinor: 100,
          payers: [
            { memberId: 'a', paidMinor: 50 },
            { memberId: 'a', paidMinor: 50 },
          ],
          split,
        }),
      'DUPLICATE_MEMBER',
    );
    expectCoreError(
      () =>
        computeExpense({
          amountMinor: 100,
          payers: [
            { memberId: 'a', paidMinor: 100 },
            { memberId: 'b', paidMinor: 0 },
          ],
          split,
        }),
      'INVALID_AMOUNT',
    );
  });

  it('rejects a zero amount', () => {
    expectCoreError(
      () =>
        computeExpense({
          amountMinor: 0,
          payers: [{ memberId: 'a', paidMinor: 0 }],
          split: { method: 'equal', participants: ['a'] },
        }),
      'INVALID_AMOUNT',
    );
  });
});
