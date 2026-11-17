import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateByWeights } from './allocate';
import { expectCoreError } from './testkit';

const toMap = (a: { id: string; amountMinor: number }[]) => Object.fromEntries(a.map((x) => [x.id, x.amountMinor]));
const sum = (a: { amountMinor: number }[]) => a.reduce((s, x) => s + x.amountMinor, 0);

describe('allocateByWeights', () => {
  it('splits Rs 1000.00 three ways without losing a paisa', () => {
    const r = allocateByWeights(100000, [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ]);
    expect(toMap(r)).toEqual({ a: 33334, b: 33333, c: 33333 }); // extra paisa goes to the lowest id
    expect(sum(r)).toBe(100000);
  });

  it('gives the extra paisa to the same person whatever the input order', () => {
    const forward = allocateByWeights(100000, [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ]);
    const backward = allocateByWeights(100000, [
      { id: 'c', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'a', weight: 1 },
    ]);
    expect(toMap(forward)).toEqual(toMap(backward));
  });

  it('keeps results in the order the entries were given', () => {
    const r = allocateByWeights(10, [
      { id: 'z', weight: 1 },
      { id: 'a', weight: 1 },
    ]);
    expect(r.map((x) => x.id)).toEqual(['z', 'a']);
  });

  it('handles weighted splits (2 : 1 : 1)', () => {
    const r = allocateByWeights(10000, [
      { id: 'a', weight: 2 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ]);
    expect(toMap(r)).toEqual({ a: 5000, b: 2500, c: 2500 });
  });

  it('gives the leftover to the largest fractional remainder, not just the lowest id', () => {
    // total 10, weights 1:1:8 -> exact 1, 1, 8 (no leftover). Use 7 : weights 5,5,1 -> exact 3.18,3.18,0.636
    const r = allocateByWeights(7, [
      { id: 'a', weight: 5 },
      { id: 'b', weight: 5 },
      { id: 'c', weight: 1 },
    ]);
    // bases 3,3,0 leftover 1; remainders 4/11,4/11,7/11 -> c gets it
    expect(toMap(r)).toEqual({ a: 3, b: 3, c: 1 });
  });

  it('one paisa among three people goes to exactly one of them', () => {
    const r = allocateByWeights(1, [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 1 },
      { id: 'c', weight: 1 },
    ]);
    expect(toMap(r)).toEqual({ a: 1, b: 0, c: 0 });
  });

  it('allows a total of zero', () => {
    const r = allocateByWeights(0, [
      { id: 'a', weight: 1 },
      { id: 'b', weight: 3 },
    ]);
    expect(toMap(r)).toEqual({ a: 0, b: 0 });
  });

  it('works at the largest safe amount without overflow', () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, weight: 999_999_937 }));
    const r = allocateByWeights(Number.MAX_SAFE_INTEGER, entries);
    expect(sum(r)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects bad input', () => {
    expectCoreError(() => allocateByWeights(100, []), 'NO_PARTICIPANTS');
    expectCoreError(
      () =>
        allocateByWeights(100, [
          { id: 'a', weight: 1 },
          { id: 'a', weight: 1 },
        ]),
      'DUPLICATE_MEMBER',
    );
    expectCoreError(() => allocateByWeights(100, [{ id: 'a', weight: 0 }]), 'INVALID_WEIGHT');
    expectCoreError(() => allocateByWeights(100, [{ id: 'a', weight: 1.5 }]), 'INVALID_WEIGHT');
    expectCoreError(() => allocateByWeights(100, [{ id: 'a', weight: -1 }]), 'INVALID_WEIGHT');
    expectCoreError(() => allocateByWeights(-1, [{ id: 'a', weight: 1 }]), 'INVALID_AMOUNT');
    expectCoreError(() => allocateByWeights(1.5, [{ id: 'a', weight: 1 }]), 'INVALID_AMOUNT');
  });

  describe('properties (thousands of random cases)', () => {
    const entriesArb = fc
      .uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 10 })
      .chain((ids) =>
        fc.tuple(
          fc.constant(ids),
          fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: ids.length, maxLength: ids.length }),
        ),
      )
      .map(([ids, weights]) => ids.map((id, i) => ({ id: `m${id}`, weight: weights[i]! })));

    it('always adds up to the total exactly', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), entriesArb, (total, entries) => {
          expect(sum(allocateByWeights(total, entries))).toBe(total);
        }),
        { numRuns: 3000 },
      );
    });

    it('is never more than one paisa away from the exact share, and never negative', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), entriesArb, (total, entries) => {
          const W = entries.reduce((s, e) => s + BigInt(e.weight), 0n);
          const result = allocateByWeights(total, entries);
          result.forEach((r, i) => {
            const num = BigInt(total) * BigInt(entries[i]!.weight);
            const floor = Number(num / W);
            const ceil = floor + (num % W > 0n ? 1 : 0);
            expect(r.amountMinor).toBeGreaterThanOrEqual(floor);
            expect(r.amountMinor).toBeLessThanOrEqual(ceil);
          });
        }),
        { numRuns: 3000 },
      );
    });

    it('gives each person the same amount whatever order the entries come in', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), entriesArb, (total, entries) => {
          const forward = toMap(allocateByWeights(total, entries));
          const reversed = toMap(allocateByWeights(total, [...entries].reverse()));
          expect(reversed).toEqual(forward);
        }),
        { numRuns: 2000 },
      );
    });

    it('equal weights never differ by more than one paisa', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 1, max: 30 }), (total, n) => {
          const r = allocateByWeights(
            total,
            Array.from({ length: n }, (_, i) => ({ id: `m${i}`, weight: 1 })),
          );
          const amounts = r.map((x) => x.amountMinor);
          expect(Math.max(...amounts) - Math.min(...amounts)).toBeLessThanOrEqual(1);
        }),
        { numRuns: 2000 },
      );
    });
  });
});
