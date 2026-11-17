import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeBalances, type LedgerRepayment } from './balances';
import { suggestSettlements, type NetBalance, type Transfer } from './settle';
import { buildRandomTrip, expectCoreError, makeRng } from './testkit';

const RUPEE = 100;
const n = (memberId: string, rupees: number): NetBalance => ({ memberId, netMinor: rupees * RUPEE });

/** Applies transfers to balances: a payer's balance rises, a receiver's falls. */
function apply(nets: readonly NetBalance[], transfers: readonly Transfer[]): Record<string, number> {
  const out = Object.fromEntries(nets.map((x) => [x.memberId, x.netMinor]));
  for (const t of transfers) {
    out[t.fromMemberId] = out[t.fromMemberId]! + t.amountMinor;
    out[t.toMemberId] = out[t.toMemberId]! - t.amountMinor;
  }
  return out;
}

describe('suggestSettlements - the brief example', () => {
  const nets = [n('shri', 7000), n('rahul', 4000), n('amit', 2000), n('kiran', -3000), n('rohan', -4000), n('akash', -6000)];

  it('produces the expected four transfers', () => {
    const plan = suggestSettlements(nets).map((t) => `${t.fromMemberId}->${t.toMemberId}:${t.amountMinor / RUPEE}`);
    expect(plan).toEqual(['akash->shri:6000', 'rohan->rahul:4000', 'kiran->amit:2000', 'kiran->shri:1000']);
  });

  it('settles everyone to zero', () => {
    const after = apply(nets, suggestSettlements(nets));
    expect(Object.values(after).every((v) => v === 0)).toBe(true);
  });

  it('uses four transfers, the minimum possible here (two groups settle among themselves, 6 - 2 = 4)', () => {
    expect(suggestSettlements(nets)).toHaveLength(4);
  });

  it('gives the same plan whatever order balances are supplied in', () => {
    expect(suggestSettlements([...nets].reverse())).toEqual(suggestSettlements(nets));
  });
});

describe('suggestSettlements - edge cases', () => {
  it('returns no transfers when everyone is settled or nobody is listed', () => {
    expect(suggestSettlements([])).toEqual([]);
    expect(suggestSettlements([n('a', 0), n('b', 0)])).toEqual([]);
  });

  it('handles a single debtor and single creditor', () => {
    expect(suggestSettlements([n('a', -50), n('b', 50)])).toEqual([
      { fromMemberId: 'a', toMemberId: 'b', amountMinor: 5000 },
    ]);
  });

  it('settles odd paise amounts exactly', () => {
    const nets: NetBalance[] = [
      { memberId: 'a', netMinor: 3333 },
      { memberId: 'b', netMinor: 3333 },
      { memberId: 'c', netMinor: -6666 },
    ];
    const after = apply(nets, suggestSettlements(nets));
    expect(Object.values(after).every((v) => v === 0)).toBe(true);
  });

  it('breaks ties by member id so results are stable', () => {
    const plan = suggestSettlements([n('b', 100), n('a', 100), n('d', -100), n('c', -100)]);
    expect(plan).toEqual([
      { fromMemberId: 'c', toMemberId: 'a', amountMinor: 10000 },
      { fromMemberId: 'd', toMemberId: 'b', amountMinor: 10000 },
    ]);
  });

  it('rejects balances that do not add up to zero', () => {
    const e = expectCoreError(() => suggestSettlements([n('a', 10), n('b', -9)]), 'BALANCES_NOT_ZERO_SUM');
    expect(e.details).toMatchObject({ sumMinor: 100 });
  });

  it('rejects duplicates and unsafe numbers', () => {
    expectCoreError(() => suggestSettlements([n('a', 0), n('a', 0)]), 'DUPLICATE_MEMBER');
    expectCoreError(() => suggestSettlements([{ memberId: 'a', netMinor: 1.5 }]), 'INVALID_AMOUNT');
  });
});

describe('suggestSettlements - properties', () => {
  function randomZeroSumNets(seed: number): NetBalance[] {
    const rng = makeRng(seed);
    const count = rng.int(2, 12);
    const nets: NetBalance[] = [];
    let running = 0;
    for (let i = 0; i < count - 1; i++) {
      const v = rng.chance(0.2) ? 0 : rng.int(-5_000_000, 5_000_000);
      running += v;
      nets.push({ memberId: `m${i}`, netMinor: v });
    }
    nets.push({ memberId: `m${count - 1}`, netMinor: -running });
    return nets;
  }

  it('always settles everyone to exactly zero, with positive amounts and no more than (people with a balance - 1) transfers', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const nets = randomZeroSumNets(seed);
        const plan = suggestSettlements(nets);
        const after = apply(nets, plan);
        expect(Object.values(after).every((v) => v === 0)).toBe(true);
        expect(plan.every((t) => t.amountMinor > 0 && t.fromMemberId !== t.toMemberId)).toBe(true);
        const nonZero = nets.filter((x) => x.netMinor !== 0).length;
        expect(plan.length).toBeLessThanOrEqual(Math.max(0, nonZero - 1));
      }),
      { numRuns: 3000 },
    );
  });

  it('only ever makes debtors pay creditors', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const nets = randomZeroSumNets(seed);
        const net = Object.fromEntries(nets.map((x) => [x.memberId, x.netMinor]));
        for (const t of suggestSettlements(nets)) {
          expect(net[t.fromMemberId]!).toBeLessThan(0);
          expect(net[t.toMemberId]!).toBeGreaterThan(0);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('end to end: recording the suggested plan as confirmed repayments leaves every balance at zero', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (seed) => {
        const t = buildRandomTrip(seed);
        const before = computeBalances(t.ids, t.expenses, []);
        const plan = suggestSettlements(before.map((b) => ({ memberId: b.memberId, netMinor: b.netConfirmedMinor })));
        const repayments: LedgerRepayment[] = plan.map((p, i) => ({
          id: `plan${i}`,
          fromMemberId: p.fromMemberId,
          toMemberId: p.toMemberId,
          amountMinor: p.amountMinor,
          status: 'confirmed',
        }));
        const after = computeBalances(t.ids, t.expenses, repayments);
        expect(after.every((m) => m.netConfirmedMinor === 0 && m.netProjectedMinor === 0)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
