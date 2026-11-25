import { describe, expect, it } from 'vitest';
import { suggestSettlements } from './settle';
import { EXACT_LIMIT, SettlementPlanError, planSettlement, type PlanBalance } from './settlementPlan';

const bal = (memberId: string, netMinor: number, active = true): PlanBalance => ({ memberId, netMinor, active });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${String(i).padStart(2, '0')}`);
const fromNets = (nets: number[]): PlanBalance[] => ids(nets.length).map((id, i) => bal(id, nets[i]!));

/** A small seeded random generator (mulberry32), so every random test is repeatable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/** Nets that add up to zero: `k` people, amounts up to `range` (small ranges make many zero-sum subgroups). */
function randomNets(r: () => number, k: number, range: number): number[] {
  const nets: number[] = [];
  let sum = 0;
  for (let i = 0; i < k - 1; i++) {
    const v = randInt(r, -range, range);
    nets.push(v);
    sum += v;
  }
  nets.push(0 - sum);
  return nets;
}

/** Applies a plan to the balances and returns what everyone has left (must be all zero). */
function leftOver(balances: PlanBalance[], plan: ReturnType<typeof planSettlement>): Map<string, number> {
  const left = new Map(balances.map((b) => [b.memberId, b.netMinor]));
  for (const t of plan.transfers) {
    left.set(t.fromMemberId, left.get(t.fromMemberId)! + t.amountMinor); // paying reduces what you owe
    left.set(t.toMemberId, left.get(t.toMemberId)! - t.amountMinor); // receiving reduces what you are owed
  }
  return left;
}

function checkPlan(balances: PlanBalance[], plan: ReturnType<typeof planSettlement>) {
  for (const v of leftOver(balances, plan).values()) expect(v === 0).toBe(true);
  const payers = new Set<string>();
  const receivers = new Set<string>();
  const pairs = new Set<string>();
  for (const t of plan.transfers) {
    expect(Number.isSafeInteger(t.amountMinor)).toBe(true);
    expect(t.amountMinor).toBeGreaterThan(0);
    expect(t.fromMemberId).not.toBe(t.toMemberId);
    payers.add(t.fromMemberId);
    receivers.add(t.toMemberId);
    expect(pairs.has(`${t.fromMemberId}>${t.toMemberId}`)).toBe(false); // never the same two people twice
    pairs.add(`${t.fromMemberId}>${t.toMemberId}`);
  }
  for (const p of payers) expect(receivers.has(p)).toBe(false); // debtors only pay, creditors only receive
  for (const t of plan.transfers) {
    expect(balances.find((b) => b.memberId === t.fromMemberId)!.netMinor).toBeLessThan(0);
    expect(balances.find((b) => b.memberId === t.toMemberId)!.netMinor).toBeGreaterThan(0);
  }
}

/** An independent oracle: the most zero-sum groups, found by trying every subset that holds the first person (no dynamic programme). */
function maxGroups(nets: number[]): number {
  if (nets.length === 0) return 0;
  const [first, ...rest] = nets as [number, ...number[]];
  let best = -Infinity;
  for (let mask = 0; mask < 1 << rest.length; mask++) {
    let s = first;
    const left: number[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (mask & (1 << i)) s += rest[i]!;
      else left.push(rest[i]!);
    }
    if (s === 0) best = Math.max(best, 1 + maxGroups(left));
  }
  return best;
}
const oracleMinimum = (nets: number[]) => nets.length - maxGroups(nets);

/** A second, fully independent oracle for tiny cases: breadth-first search over real payments (any amount from a debtor to a creditor). */
function bfsMinimum(nets: number[]): number {
  const key = (v: number[]) => v.join(',');
  let frontier = [nets];
  const seen = new Set([key(nets)]);
  for (let depth = 0; depth <= nets.length; depth++) {
    if (frontier.some((v) => v.every((x) => x === 0))) return depth;
    const next: number[][] = [];
    for (const v of frontier) {
      for (let i = 0; i < v.length; i++) {
        if (v[i]! >= 0) continue;
        for (let j = 0; j < v.length; j++) {
          if (v[j]! <= 0) continue;
          for (let a = 1; a <= Math.min(-v[i]!, v[j]!); a++) {
            const w = [...v];
            w[i] = w[i]! + a;
            w[j] = w[j]! - a;
            if (!seen.has(key(w))) {
              seen.add(key(w));
              next.push(w);
            }
          }
        }
      }
    }
    frontier = next;
  }
  return Infinity;
}

describe('hand-checked plans', () => {
  it('the product example: A owes 500, B owes 300, C is owed 800', () => {
    const plan = planSettlement([bal('A', -500), bal('B', -300), bal('C', 800)]);
    expect(plan.transfers).toEqual([
      { fromMemberId: 'A', toMemberId: 'C', amountMinor: 500 },
      { fromMemberId: 'B', toMemberId: 'C', amountMinor: 300 },
    ]);
    expect(plan.guaranteedMinimum).toBe(true);
    expect(plan.quality).toBe('exact');
  });

  it('greedy is not minimal: +10 +9 -6 -4 -9 needs 3 payments, plain greedy needs 4', () => {
    const balances = [bal('a', 10), bal('b', 9), bal('c', -6), bal('d', -4), bal('e', -9)];
    const greedy = suggestSettlements(balances.map((b) => ({ memberId: b.memberId, netMinor: b.netMinor })));
    expect(greedy).toHaveLength(4);
    const plan = planSettlement(balances);
    expect(plan.transfers).toHaveLength(3);
    checkPlan(balances, plan);
    expect(plan.transfers).toContainEqual({ fromMemberId: 'e', toMemberId: 'b', amountMinor: 9 });
  });

  it('equal balances pair up by member id, whatever order they arrive in', () => {
    const balances = [bal('d', -5), bal('b', 5), bal('a', 5), bal('c', -5)];
    const expected = [
      { fromMemberId: 'c', toMemberId: 'a', amountMinor: 5 },
      { fromMemberId: 'd', toMemberId: 'b', amountMinor: 5 },
    ];
    expect(planSettlement(balances).transfers).toEqual(expected);
    expect(planSettlement([...balances].reverse()).transfers).toEqual(expected);
  });

  it('an empty ledger and all-zero balances give an empty plan', () => {
    for (const input of [[], [bal('a', 0), bal('b', 0)]]) {
      const plan = planSettlement(input);
      expect(plan.transfers).toEqual([]);
      expect(plan.peopleWithBalance).toBe(0);
      expect(plan.guaranteedMinimum).toBe(true);
    }
  });

  it('zero-balance members (including former members) are left out', () => {
    const plan = planSettlement([bal('a', -100), bal('b', 100), bal('gone', 0, false), bal('idle', 0)]);
    expect(plan.transfers).toEqual([{ fromMemberId: 'a', toMemberId: 'b', amountMinor: 100 }]);
    expect(plan.peopleWithBalance).toBe(2);
  });

  it('one person owed by three, paise kept exactly', () => {
    const balances = [bal('a', -3333), bal('b', -3333), bal('c', -3334), bal('z', 10000)];
    const plan = planSettlement(balances);
    expect(plan.transfers).toHaveLength(3);
    expect(plan.transfers.map((t) => t.amountMinor).sort()).toEqual([3333, 3333, 3334]);
    checkPlan(balances, plan);
  });

  it('two independent groups settle separately (4 payments for 6 people)', () => {
    const balances = [bal('a', 6), bal('b', -4), bal('c', -2), bal('d', 7), bal('e', -3), bal('f', -4)];
    const plan = planSettlement(balances);
    expect(plan.transfers).toHaveLength(4);
    checkPlan(balances, plan);
  });
});

describe('pinned behaviour', () => {
  it('when several best plans exist, the one built from the lowest member ids first is chosen (pinned, so the tie-break cannot drift)', () => {
    const plan = planSettlement(fromNets([3, 3, -1, -2, -1, -2]));
    expect(plan.transfers).toEqual([
      { fromMemberId: 'm02', toMemberId: 'm00', amountMinor: 1 },
      { fromMemberId: 'm03', toMemberId: 'm00', amountMinor: 2 },
      { fromMemberId: 'm04', toMemberId: 'm01', amountMinor: 1 },
      { fromMemberId: 'm05', toMemberId: 'm01', amountMinor: 2 },
    ]);
  });

  it('a second pinned tie: -3 2 6 2 2 -4 5 -10 (several equally short plans exist; this exact one is chosen)', () => {
    const plan = planSettlement(fromNets([-3, 2, 6, 2, 2, -4, 5, -10]));
    expect(plan.transfers.map((t) => [t.fromMemberId, t.toMemberId, t.amountMinor])).toEqual([
      ['m00', 'm01', 2],
      ['m00', 'm06', 1],
      ['m05', 'm03', 2],
      ['m05', 'm04', 2],
      ['m07', 'm02', 6],
      ['m07', 'm06', 4],
    ]);
  });

  it('payments always come out sorted by payer id, then receiver id', () => {
    const r = rng(31);
    for (let n = 0; n < 200; n++) {
      const plan = planSettlement(fromNets(randomNets(r, randInt(r, 2, 16), 30)));
      const keys = plan.transfers.map((t) => `${t.fromMemberId}>${t.toMemberId}`);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('with 25 people, removing exact pairs first beats plain greedy (13 payments against 14)', () => {
    const trap = [10, 9, -6, -4, -9]; // plain greedy needs 4 payments here
    const pairs = Array.from({ length: 10 }, (_, i) => [101 + i, -(101 + i)]).flat();
    const plan = planSettlement(fromNets([...trap, ...pairs]));
    const greedy = suggestSettlements(fromNets([...trap, ...pairs]).map((b) => ({ memberId: b.memberId, netMinor: b.netMinor })));
    expect(greedy).toHaveLength(14);
    expect(plan.transfers).toHaveLength(13);
    expect(plan.guaranteedMinimum).toBe(false);
  });
});

describe('refusing inconsistent data', () => {
  it('balances that do not add up to zero', () => {
    expect(() => planSettlement([bal('a', -100), bal('b', 99)])).toThrowError(SettlementPlanError);
    try {
      planSettlement([bal('a', -100), bal('b', 99)]);
    } catch (e) {
      expect((e as SettlementPlanError).code).toBe('NOT_ZERO_SUM');
    }
  });

  it('a former member with a balance fails safely: never included, never ignored', () => {
    for (const net of [100, -100]) {
      const input = [bal('a', -net), bal('gone', net, false)];
      try {
        planSettlement(input);
        throw new Error('should have failed');
      } catch (e) {
        expect(e).toBeInstanceOf(SettlementPlanError);
        expect((e as SettlementPlanError).code).toBe('FORMER_MEMBER_BALANCE');
      }
    }
  });

  it('a repeated member, a fractional or unsafe amount, and amounts too large to add exactly', () => {
    const code = (input: PlanBalance[]) => {
      try {
        planSettlement(input);
        return 'ok';
      } catch (e) {
        return (e as SettlementPlanError).code;
      }
    };
    expect(code([bal('a', 0), bal('a', 0)])).toBe('DUPLICATE_MEMBER');
    expect(code([bal('a', 1.5), bal('b', -1.5)])).toBe('UNSAFE_AMOUNT');
    expect(code([bal('a', Number.NaN)])).toBe('UNSAFE_AMOUNT');
    expect(code([bal('a', Number.MAX_SAFE_INTEGER), bal('b', -Number.MAX_SAFE_INTEGER)])).toBe('UNSAFE_AMOUNT'); // sums could lose precision
  });

  it('never changes the input', () => {
    const input = [bal('b', 5), bal('a', -5)];
    const copy = JSON.stringify(input);
    planSettlement(input);
    expect(JSON.stringify(input)).toBe(copy);
  });
});

describe('random ledgers: invariants', () => {
  it('2,500 seeded cases of 1 to 14 people: exact, conserving, deterministic, never longer than greedy', () => {
    const r = rng(20261125);
    for (let n = 0; n < 2500; n++) {
      const k = randInt(r, 1, 14);
      const range = [2, 5, 20, 1000][n % 4]!;
      const balances = fromNets(randomNets(r, k, range));
      const plan = planSettlement(balances);
      checkPlan(balances, plan);
      const nonZero = balances.filter((b) => b.netMinor !== 0);
      const greedy = suggestSettlements(nonZero.map((b) => ({ memberId: b.memberId, netMinor: b.netMinor })));
      expect(plan.transfers.length).toBeLessThanOrEqual(Math.max(0, nonZero.length - 1));
      expect(plan.transfers.length).toBeLessThanOrEqual(greedy.length);
      // the same plan in any input order
      const shuffled = [...balances].sort(() => r() - 0.5);
      expect(planSettlement(shuffled).transfers).toEqual(plan.transfers);
    }
  });

  it('equals the independent brute-force minimum for up to 10 people (1,500 seeded cases)', () => {
    const r = rng(77);
    for (let n = 0; n < 1500; n++) {
      const k = randInt(r, 2, 10);
      const nets = randomNets(r, k, [1, 3, 6, 25][n % 4]!);
      const plan = planSettlement(fromNets(nets));
      expect(plan.transfers.length, JSON.stringify(nets)).toBe(oracleMinimum(nets.filter((v) => v !== 0)));
    }
  });

  it('and equals a search over real payments (any amount) for tiny groups, confirming the theory behind it', () => {
    const r = rng(5);
    for (let n = 0; n < 150; n++) {
      const k = randInt(r, 2, 5);
      const nets = randomNets(r, k, 4);
      const plan = planSettlement(fromNets(nets));
      expect(plan.transfers.length, JSON.stringify(nets)).toBe(bfsMinimum(nets));
    }
  });

  it('structured ledgers built from known zero-sum groups use exactly (people - groups) payments or fewer', () => {
    const r = rng(99);
    for (let n = 0; n < 300; n++) {
      const groups = randInt(r, 1, 4);
      const nets: number[] = [];
      for (let g = 0; g < groups; g++) nets.push(...randomNets(r, randInt(r, 2, 5), 500));
      if (nets.length > EXACT_LIMIT) continue;
      const plan = planSettlement(fromNets(nets));
      const nonZero = nets.filter((v) => v !== 0).length;
      expect(plan.transfers.length).toBeLessThanOrEqual(nonZero - groups);
    }
  });
});

describe('21 to 50 people: the fallback', () => {
  it('is never longer than plain greedy, always settles exactly, and never claims to be the minimum (400 seeded cases)', () => {
    const r = rng(4242);
    for (let n = 0; n < 400; n++) {
      const k = randInt(r, EXACT_LIMIT + 1, 50);
      const balances = fromNets(randomNets(r, k, [3, 40, 100000][n % 3]!));
      const plan = planSettlement(balances);
      checkPlan(balances, plan);
      const nonZero = balances.filter((b) => b.netMinor !== 0);
      const greedy = suggestSettlements(nonZero.map((b) => ({ memberId: b.memberId, netMinor: b.netMinor })));
      if (nonZero.length > EXACT_LIMIT) {
        expect(plan.transfers.length).toBeLessThanOrEqual(greedy.length);
        expect(plan.guaranteedMinimum).toBe(false);
        expect(plan.quality).toBe('suggested');
      }
      expect(planSettlement([...balances].reverse()).transfers).toEqual(plan.transfers);
    }
  });

  it('removes exact pairs first', () => {
    const nets = [...Array.from({ length: 12 }, () => 70), ...Array.from({ length: 12 }, () => -70)];
    const plan = planSettlement(fromNets(nets));
    expect(plan.transfers).toHaveLength(12);
    expect(plan.guaranteedMinimum).toBe(false); // 24 people: still never claimed to be the fewest
  });
});

describe('performance', () => {
  /** The worst case for the search: 20 people, large distinct amounts, no equal pairs and no zero-sum subgroups. */
  const worst20 = () => {
    const r = rng(1);
    const nets: number[] = [];
    let sum = 0;
    for (let i = 0; i < 19; i++) {
      const v = (i % 2 === 0 ? 1 : -1) * (100000 + randInt(r, 1, 900000) * 7 + i * 13);
      nets.push(v);
      sum += v;
    }
    nets.push(0 - sum);
    return fromNets(nets);
  };

  it('20 people with no shortcuts: exact answer, timed', () => {
    const balances = worst20();
    const started = performance.now();
    const plan = planSettlement(balances);
    const ms = performance.now() - started;
    console.log(`planSettlement, 20 people, worst case: ${ms.toFixed(0)} ms (${plan.transfers.length} payments)`);
    checkPlan(balances, plan);
    expect(plan.guaranteedMinimum).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  it('50 people: fast', () => {
    const r = rng(2);
    const balances = fromNets(randomNets(r, 50, 100000));
    const started = performance.now();
    const plan = planSettlement(balances);
    const ms = performance.now() - started;
    console.log(`planSettlement, 50 people: ${ms.toFixed(1)} ms (${plan.transfers.length} payments)`);
    checkPlan(balances, plan);
    expect(ms).toBeLessThan(200);
  });

  it('large amounts (13-digit rupees in paise) stay exact', () => {
    const big = 4_000_000_000_000_000; // 4e15 paise: below 2^53, and the sum of absolute values (8e15) is too
    const plan = planSettlement([bal('a', -big), bal('b', big)]);
    expect(plan.transfers).toEqual([{ fromMemberId: 'a', toMemberId: 'b', amountMinor: big }]);
  });
});
