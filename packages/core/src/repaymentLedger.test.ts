import { describe, expect, it } from 'vitest';
import { computeBalances, type LedgerExpense, type LedgerRepayment } from './balances';
import {
  REPAYMENT_STATES,
  REVERSAL_STATES,
  RepaymentLedgerError,
  applyRepaymentsToNets,
  computeLedgerBalances,
  isRepaymentState,
  isReversalState,
  pendingReservations,
  previewRepaymentCapacity,
  repaymentCountsOfficially,
  type RepaymentLedgerEntry,
  type RepaymentState,
  type ReversalLedgerEntry,
  type ReversalState,
} from './repaymentLedger';

const A = 'a', B = 'b', C = 'c', D = 'd';
const rep = (id: string, from: string, to: string, amountMinor: number, status: RepaymentState): RepaymentLedgerEntry => ({ id, fromMemberId: from, toMemberId: to, amountMinor, status });
const rev = (id: string, repaymentId: string, status: ReversalState): ReversalLedgerEntry => ({ id, repaymentId, status });
const nets = (pairs: Record<string, number>) => Object.entries(pairs).map(([memberId, netMinor]) => ({ memberId, netMinor }));
const netsOf = (b: { memberId: string; netMinor: number }[]) => Object.fromEntries(b.map((x) => [x.memberId, x.netMinor]));
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof RepaymentLedgerError ? e.code : `other:${(e as Error).message}`;
  }
};

/** A ledger for A -500, B -300, C +800 (the product example). */
const BASE = nets({ [A]: -500, [B]: -300, [C]: 800 });

describe('expense-only ledgers are unchanged (identical to the M5 figure and to M1)', () => {
  const expenses: LedgerExpense[] = [
    { id: 'e1', payers: [{ memberId: C, paidMinor: 90000 }], splits: [{ memberId: A, shareMinor: 30000 }, { memberId: B, shareMinor: 30000 }, { memberId: C, shareMinor: 30000 }] },
    { id: 'e2', payers: [{ memberId: A, paidMinor: 5000 }, { memberId: B, paidMinor: 2500 }], splits: [{ memberId: A, shareMinor: 3750 }, { memberId: B, shareMinor: 3750 }] },
    { id: 'gone', deleted: true, payers: [{ memberId: A, paidMinor: 777 }], splits: [{ memberId: B, shareMinor: 777 }] },
  ];

  it('with no repayments every net equals M1\'s expense balance and sent and received are zero', () => {
    const m1 = computeBalances([A, B, C], expenses, []);
    const ledger = computeLedgerBalances([A, B, C], expenses, [], []);
    expect(ledger.map((x) => [x.memberId, x.netMinor])).toEqual(m1.map((x) => [x.memberId, x.netConfirmedMinor]));
    for (const x of ledger) {
      expect(x.sentMinor).toBe(0);
      expect(x.receivedMinor).toBe(0);
      expect(x.expenseNetMinor).toBe(x.netMinor);
    }
    expect(ledger.reduce((s, x) => s + x.netMinor, 0)).toBe(0);
  });

  it('calls M1 with NO repayments only: a pending or unknown-status record never reaches M1\'s own (superseded) repayment path', () => {
    const ledger = computeLedgerBalances([A, B, C], expenses, [rep('p1', A, C, 100, 'pending')], []);
    expect(ledger.find((x) => x.memberId === A)!.sentMinor).toBe(0);
  });
});

describe('what counts: only confirmed repayments, and only those without an applied reversal', () => {
  it('a confirmed repayment moves the net: A pays C 300 (design example 3)', () => {
    const out = applyRepaymentsToNets(BASE, [rep('r1', A, C, 300, 'confirmed')], []);
    expect(netsOf(out)).toEqual({ a: -200, b: -300, c: 500 });
    expect(out.find((x) => x.memberId === A)).toEqual({ memberId: A, expenseNetMinor: -500, sentMinor: 300, receivedMinor: 0, netMinor: -200 });
    expect(out.find((x) => x.memberId === C)).toEqual({ memberId: C, expenseNetMinor: 800, sentMinor: 0, receivedMinor: 300, netMinor: 500 });
  });

  it.each(['pending', 'rejected', 'cancelled'] as const)('a %s repayment never changes any balance', (status) => {
    const out = applyRepaymentsToNets(BASE, [rep('r1', A, C, 300, status)], []);
    expect(netsOf(out)).toEqual({ a: -500, b: -300, c: 800 });
    expect(out.every((x) => x.sentMinor === 0 && x.receivedMinor === 0)).toBe(true);
  });

  it('an APPLIED reversal stops a confirmed repayment counting, and the original record is not changed', () => {
    const repayments = [rep('r1', A, C, 300, 'confirmed')];
    const snapshot = JSON.stringify(repayments);
    const out = applyRepaymentsToNets(BASE, repayments, [rev('v1', 'r1', 'applied')]);
    expect(netsOf(out)).toEqual({ a: -500, b: -300, c: 800 });
    expect(JSON.stringify(repayments)).toBe(snapshot);
    expect(repayments[0]!.status).toBe('confirmed');
  });

  it.each(['requested', 'override_proposed', 'declined', 'withdrawn', 'override_refused'] as const)('a %s reversal does not change anything (only an applied one does)', (status) => {
    const out = applyRepaymentsToNets(BASE, [rep('r1', A, C, 300, 'confirmed')], [rev('v1', 'r1', status)]);
    expect(netsOf(out)).toEqual({ a: -200, b: -300, c: 500 });
  });

  it('every repayment state and every reversal state is covered by the tests above', () => {
    expect([...REPAYMENT_STATES].sort()).toEqual(['cancelled', 'confirmed', 'pending', 'rejected']);
    expect([...REVERSAL_STATES].sort()).toEqual(['applied', 'declined', 'override_proposed', 'override_refused', 'requested', 'withdrawn']);
    expect(isRepaymentState('paid')).toBe(false); // the superseded state does not exist
    expect(isRepaymentState('confirmed')).toBe(true);
    expect(isReversalState('applied')).toBe(true);
    expect(isReversalState('open')).toBe(false);
  });

  it('repaymentCountsOfficially: confirmed and not reversed', () => {
    const r = rep('r1', A, C, 1, 'confirmed');
    expect(repaymentCountsOfficially(r, [])).toBe(true);
    expect(repaymentCountsOfficially(r, [rev('v', 'r1', 'requested')])).toBe(true);
    expect(repaymentCountsOfficially(r, [rev('v', 'r1', 'applied')])).toBe(false);
    expect(repaymentCountsOfficially(r, [rev('v', 'other', 'applied')])).toBe(true);
    for (const status of ['pending', 'rejected', 'cancelled'] as const) expect(repaymentCountsOfficially(rep('r2', A, C, 1, status), [])).toBe(false);
  });
});

describe('several repayments and reversals together', () => {
  it('partial repayments add up, in either order and by different payers', () => {
    const repayments = [rep('r1', A, C, 300, 'confirmed'), rep('r2', A, C, 200, 'confirmed'), rep('r3', B, C, 300, 'confirmed')];
    const out = applyRepaymentsToNets(BASE, repayments, []);
    expect(netsOf(out)).toEqual({ a: 0, b: 0, c: 0 });
    expect(netsOf(applyRepaymentsToNets(BASE, [...repayments].reverse(), []))).toEqual({ a: 0, b: 0, c: 0 });
  });

  it('a reversal, then a smaller real repayment: -500, then +50 (the product example of the design)', () => {
    const base = nets({ [A]: -500, [B]: 500 });
    const out = applyRepaymentsToNets(base, [rep('wrong', A, B, 500, 'confirmed'), rep('real', A, B, 50, 'confirmed')], [rev('v', 'wrong', 'applied')]);
    expect(netsOf(out)).toEqual({ a: -450, b: 450 });
  });

  it('a mix of every state at once only counts what should count', () => {
    const repayments = [
      rep('c1', A, C, 100, 'confirmed'), rep('c2', A, C, 50, 'confirmed'), rep('p1', B, C, 70, 'pending'),
      rep('x1', B, C, 60, 'rejected'), rep('k1', B, C, 40, 'cancelled'), rep('c3', B, C, 80, 'confirmed'),
    ];
    const out = applyRepaymentsToNets(BASE, repayments, [rev('v1', 'c2', 'applied'), rev('v2', 'c3', 'declined'), rev('v3', 'c1', 'requested')]);
    // counting: c1 (A to C 100), c3 (B to C 80); c2 is reversed
    expect(netsOf(out)).toEqual({ a: -400, b: -220, c: 620 });
    expect(out.reduce((s, x) => s + x.netMinor, 0)).toBe(0);
  });

  it('a payer can end up owed after expenses change later (the formula allows it; the database decides what may be recorded)', () => {
    const out = applyRepaymentsToNets(nets({ [A]: 0, [C]: 0 }), [rep('r1', A, C, 500, 'confirmed')], []);
    expect(netsOf(out)).toEqual({ a: 500, c: -500 });
  });

  it('does not change what it is given and returns members in the order given', () => {
    const input = nets({ [C]: 800, [A]: -500, [B]: -300 });
    const repayments = [rep('r1', A, C, 300, 'confirmed')];
    const reversals = [rev('v', 'r1', 'applied')];
    const before = JSON.stringify([input, repayments, reversals]);
    const out = applyRepaymentsToNets(input, repayments, reversals);
    expect(JSON.stringify([input, repayments, reversals])).toBe(before);
    expect(out.map((x) => x.memberId)).toEqual([C, A, B]);
  });
});

describe('typed errors for inconsistent records', () => {
  it('refuses bad amounts: zero, negative, fractional, unsafe, a repayment to oneself', () => {
    for (const amount of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, Infinity]) {
      expect(codeOf(() => applyRepaymentsToNets(BASE, [rep('r1', A, C, amount, 'confirmed')], [])), String(amount)).toBe('INVALID_AMOUNT');
    }
    expect(codeOf(() => applyRepaymentsToNets(BASE, [rep('r1', A, A, 5, 'confirmed')], []))).toBe('INVALID_AMOUNT');
    // even a repayment that would not count is validated (a bad record is never silently skipped)
    expect(codeOf(() => applyRepaymentsToNets(BASE, [rep('r1', A, C, 0, 'pending')], []))).toBe('INVALID_AMOUNT');
  });

  it('refuses unknown members, duplicates, malformed records and unknown states', () => {
    expect(codeOf(() => applyRepaymentsToNets(BASE, [rep('r1', A, 'zzz', 5, 'confirmed')], []))).toBe('UNKNOWN_MEMBER');
    expect(codeOf(() => applyRepaymentsToNets(BASE, [rep('r1', A, C, 5, 'confirmed'), rep('r1', B, C, 5, 'confirmed')], []))).toBe('DUPLICATE_REPAYMENT');
    expect(codeOf(() => applyRepaymentsToNets([...BASE, { memberId: A, netMinor: 0 }], [], []))).toBe('DUPLICATE_MEMBER');
    expect(codeOf(() => applyRepaymentsToNets(BASE, [rep('r1', A, C, 5, 'paid' as RepaymentState)], []))).toBe('INVALID_INPUT');
    expect(codeOf(() => applyRepaymentsToNets(BASE, [null as unknown as RepaymentLedgerEntry], []))).toBe('INVALID_INPUT');
    expect(codeOf(() => applyRepaymentsToNets(BASE, [], [rev('v', 'r1', 'open' as ReversalState)]))).toBe('INVALID_INPUT');
    expect(codeOf(() => applyRepaymentsToNets([{ memberId: '', netMinor: 0 }], [], []))).toBe('INVALID_INPUT');
  });

  it('refuses reversals that cannot exist in the database', () => {
    const r = [rep('r1', A, C, 5, 'confirmed')];
    expect(codeOf(() => applyRepaymentsToNets(BASE, r, [rev('v', 'missing', 'applied')]))).toBe('UNKNOWN_REPAYMENT');
    expect(codeOf(() => applyRepaymentsToNets(BASE, r, [rev('v', 'r1', 'applied'), rev('v', 'r1', 'declined')]))).toBe('DUPLICATE_REVERSAL');
    expect(codeOf(() => applyRepaymentsToNets(BASE, r, [rev('v1', 'r1', 'applied'), rev('v2', 'r1', 'applied')]))).toBe('MULTIPLE_APPLIED_REVERSALS');
    for (const status of ['pending', 'rejected', 'cancelled'] as const) {
      expect(codeOf(() => applyRepaymentsToNets(BASE, [rep('r2', A, C, 5, status)], [rev('v', 'r2', 'applied')]))).toBe('REVERSAL_OF_UNCONFIRMED');
    }
    // several non-applied reversals of one repayment are fine (a declined request, then a new one)
    expect(codeOf(() => applyRepaymentsToNets(BASE, r, [rev('v1', 'r1', 'declined'), rev('v2', 'r1', 'requested')]))).toBe('ok');
  });

  it('refuses expense balances that do not add up to zero', () => {
    expect(codeOf(() => applyRepaymentsToNets(nets({ [A]: -100, [B]: 99 }), [], []))).toBe('NOT_ZERO_SUM');
  });

  it('safe-integer arithmetic: an amount near the limit works, an overflow is a typed error', () => {
    const big = 4_000_000_000_000_000;
    const out = applyRepaymentsToNets(nets({ [A]: -big, [B]: big }), [rep('r1', A, B, big, 'confirmed')], []);
    expect(netsOf(out)).toEqual({ a: 0, b: 0 });
    expect(codeOf(() => applyRepaymentsToNets(nets({ [A]: -big, [B]: big }), [rep('r1', A, B, big, 'confirmed'), rep('r2', A, B, big, 'confirmed'), rep('r3', A, B, big, 'confirmed')], []))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => applyRepaymentsToNets(nets({ [A]: 1.5, [B]: -1.5 }), [], []))).toBe('INVALID_AMOUNT');
  });
});

describe('random ledgers: zero-sum, safe integers, and agreement with M1\'s own confirmed figure (used here only as an independent check)', () => {
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
  const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

  it('1,500 seeded ledgers with random expenses, repayments in every state and random reversals', () => {
    const r = rng(20261126);
    for (let n = 0; n < 1500; n++) {
      const members = Array.from({ length: int(r, 2, 7) }, (_, i) => `m${i}`);
      const expenses: LedgerExpense[] = [];
      for (let e = 0; e < int(r, 0, 5); e++) {
        const total = int(r, 1, 100000);
        const payer = members[int(r, 0, members.length - 1)]!;
        const sharers = members.filter(() => r() < 0.6);
        const people = sharers.length > 0 ? sharers : [members[0]!];
        let left = total;
        const splits = people.map((m, i) => {
          const amount = i === people.length - 1 ? left : int(r, 0, left);
          left -= amount;
          return { memberId: m, shareMinor: amount };
        });
        expenses.push({ id: `e${e}`, payers: [{ memberId: payer, paidMinor: total }], splits });
      }
      const repayments: RepaymentLedgerEntry[] = [];
      for (let k = 0; k < int(r, 0, 8); k++) {
        const from = members[int(r, 0, members.length - 1)]!;
        let to = members[int(r, 0, members.length - 1)]!;
        if (to === from) to = members[(members.indexOf(from) + 1) % members.length]!;
        repayments.push(rep(`r${k}`, from, to, int(r, 1, 50000), REPAYMENT_STATES[int(r, 0, 3)]!));
      }
      const reversals: ReversalLedgerEntry[] = [];
      for (const p of repayments) {
        if (p.status === 'confirmed' && r() < 0.4) reversals.push(rev(`v-${p.id}-applied`, p.id, 'applied'));
        if (r() < 0.3) reversals.push(rev(`v-${p.id}-other`, p.id, ['requested', 'override_proposed', 'declined', 'withdrawn', 'override_refused'][int(r, 0, 4)] as ReversalState));
      }
      const ledger = computeLedgerBalances(members, expenses, repayments, reversals);
      // zero-sum and safe integers
      expect(ledger.reduce((s, x) => s + x.netMinor, 0)).toBe(0);
      for (const x of ledger) for (const v of [x.expenseNetMinor, x.sentMinor, x.receivedMinor, x.netMinor]) expect(Number.isSafeInteger(v)).toBe(true);
      // net = expense net + sent - received
      for (const x of ledger) expect(x.netMinor).toBe(x.expenseNetMinor + x.sentMinor - x.receivedMinor);
      // the expense part is exactly M1's, with no repayments
      const m1Expenses = computeBalances(members, expenses, []);
      for (const x of ledger) expect(x.expenseNetMinor).toBe(m1Expenses.find((b) => b.memberId === x.memberId)!.netConfirmedMinor);
      // an independent check: M1's own confirmed figure, fed only the repayments that should count
      const applied = new Set(reversals.filter((v) => v.status === 'applied').map((v) => v.repaymentId));
      const asM1: LedgerRepayment[] = repayments.map((p) => ({ id: p.id, fromMemberId: p.fromMemberId, toMemberId: p.toMemberId, amountMinor: p.amountMinor, status: p.status === 'confirmed' && !applied.has(p.id) ? 'confirmed' : 'cancelled' }));
      const m1 = computeBalances(members, expenses, asM1);
      for (const x of ledger) expect(x.netMinor).toBe(m1.find((b) => b.memberId === x.memberId)!.netConfirmedMinor);
      // a pending repayment never moves a balance: dropping every pending one changes nothing
      const withoutPending = computeLedgerBalances(members, expenses, repayments.filter((p) => p.status !== 'pending'), reversals.filter((v) => repayments.find((p) => p.id === v.repaymentId)!.status !== 'pending'));
      expect(withoutPending.map((x) => x.netMinor)).toEqual(ledger.map((x) => x.netMinor));
    }
  });
});

describe('capacity PREVIEW (the database decides; this is only a preview)', () => {
  // design example 1: A -1000, D -500, B +1000, C +500
  const balances = [{ memberId: A, netMinor: -1000 }, { memberId: D, netMinor: -500 }, { memberId: B, netMinor: 1000 }, { memberId: C, netMinor: 500 }];

  it('with nothing pending the capacity is the smaller of the debt and the credit', () => {
    expect(previewRepaymentCapacity(balances, [], A, B)).toEqual({ maxMinor: 1000, debtMinor: 1000, creditMinor: 1000, reservedOutMinor: 0, reservedInMinor: 0 });
    expect(previewRepaymentCapacity(balances, [], D, C).maxMinor).toBe(500);
    expect(previewRepaymentCapacity(balances, [], D, B).maxMinor).toBe(500);
    expect(previewRepaymentCapacity(balances, [], A, C).maxMinor).toBe(500);
  });

  it('design example 1: pending repayments reserve capacity per payer AND per receiver, across different counterparties', () => {
    const pending = [rep('p1', A, B, 600, 'pending')];
    expect(previewRepaymentCapacity(balances, pending, A, C).maxMinor).toBe(400); // A has 400 of debt left, whoever the receiver
    expect(previewRepaymentCapacity(balances, pending, D, B).maxMinor).toBe(400); // B has 400 of credit left, whoever the payer
    expect(previewRepaymentCapacity(balances, pending, D, C).maxMinor).toBe(500); // untouched
    const more = [...pending, rep('p2', D, B, 400, 'pending'), rep('p3', A, C, 400, 'pending')];
    expect(previewRepaymentCapacity(balances, more, A, B).maxMinor).toBe(0);
    expect(previewRepaymentCapacity(balances, more, D, B).maxMinor).toBe(0);
  });

  it('rejecting or cancelling releases the reservation; confirmed repayments reserve nothing (they are already in the balances)', () => {
    for (const status of ['rejected', 'cancelled', 'confirmed'] as const) {
      expect(previewRepaymentCapacity(balances, [rep('p1', A, B, 600, status)], A, B).maxMinor, status).toBe(1000);
    }
    expect(pendingReservations([rep('p1', A, B, 600, 'pending'), rep('p2', A, C, 100, 'pending'), rep('p3', D, B, 50, 'rejected')])).toEqual({
      out: new Map([[A, 700]]),
      in: new Map([[B, 600], [C, 100]]),
    });
  });

  it('never goes below zero, even if reservations exceed the debt (an expense edit after recording)', () => {
    const edited = [{ memberId: A, netMinor: -400 }, { memberId: B, netMinor: 400 }];
    const p = previewRepaymentCapacity(edited, [rep('p1', A, B, 600, 'pending')], A, B);
    expect(p.maxMinor).toBe(0);
    expect(p.reservedOutMinor).toBe(600);
    expect(p.debtMinor).toBe(400);
  });

  it('someone who is owed money cannot pay, and someone who owes cannot receive: the capacity is zero', () => {
    expect(previewRepaymentCapacity(balances, [], B, A).maxMinor).toBe(0);
    expect(previewRepaymentCapacity(balances, [], A, D).maxMinor).toBe(0);
  });

  it('typed errors: unknown member, the same member twice, unsafe values', () => {
    expect(codeOf(() => previewRepaymentCapacity(balances, [], A, 'zzz'))).toBe('UNKNOWN_MEMBER');
    expect(codeOf(() => previewRepaymentCapacity(balances, [], A, A))).toBe('INVALID_INPUT');
    expect(codeOf(() => previewRepaymentCapacity([{ memberId: A, netMinor: 1.5 }, { memberId: B, netMinor: 0 }], [], A, B))).toBe('INVALID_AMOUNT');
    expect(codeOf(() => previewRepaymentCapacity(balances, [rep('p', A, B, 1.5, 'pending')], A, B))).toBe('INVALID_AMOUNT');
  });
});
