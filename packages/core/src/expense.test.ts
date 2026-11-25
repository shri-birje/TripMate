import { describe, expect, it } from 'vitest';
import { LEDGER_VECTORS, MEMBER_IDS, SPLIT_VECTORS } from '../test-fixtures/expenseVectors';
import {
  EXPENSE_AMOUNT_MAX,
  categoryKeyOf,
  createExpenseRpcArgs,
  deleteExpenseRpcArgs,
  draftFromExpense,
  expensesFromRows,
  isSettled,
  newExpenseId,
  previewEqualSplit,
  previewSplit,
  restoreExpenseRpcArgs,
  tripBalancesRpcArgs,
  updateExpenseRpcArgs,
  validateExpenseDraft,
  type ExpenseDraft,
  type ExpenseRowRecord,
  type SplitMethod,
} from './expense';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';
const TRIP = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const EXP = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const draft = (over: Partial<ExpenseDraft> = {}): ExpenseDraft => ({
  title: 'Beach dinner',
  amountMinor: 1000,
  spentOn: '2026-12-28',
  categoryKey: 'food',
  notes: null,
  participants: [A, B, C],
  payers: [{ memberId: A, paidMinor: 1000 }],
  ...over,
});
const bad = (over: Partial<ExpenseDraft>, ctx = {}) => {
  const r = validateExpenseDraft(draft(over), ctx);
  if (r.ok) throw new Error(`expected a refusal for ${JSON.stringify(over)}`);
  return r.message;
};

describe('validateExpenseDraft', () => {
  it('accepts a good draft and returns exactly what will be sent (trimmed, lower-case ids)', () => {
    const r = validateExpenseDraft(draft({ title: '  Beach dinner ', notes: '  with sea view ', participants: [A.toUpperCase(), B], payers: [{ memberId: B.toUpperCase(), paidMinor: 1000 }] }));
    expect(r).toEqual({ ok: true, value: { title: 'Beach dinner', amountMinor: 1000, spentOn: '2026-12-28', categoryKey: 'food', notes: 'with sea view', participants: [A, B], payers: [{ memberId: B, paidMinor: 1000 }], splitMethod: 'equal', splitInputs: null } });
  });

  it('turns empty notes into null and allows no category', () => {
    const r = validateExpenseDraft(draft({ notes: '   ', categoryKey: null }));
    expect(r.ok && r.value.notes).toBeNull();
    expect(r.ok && r.value.categoryKey).toBeNull();
  });

  it('refuses a missing or too-long name, a bad amount, a bad day and bad notes with a plain sentence', () => {
    expect(bad({ title: '   ' })).toMatch(/name/);
    expect(bad({ title: 'x'.repeat(121) })).toMatch(/120/);
    for (const amountMinor of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(bad({ amountMinor, payers: [{ memberId: A, paidMinor: 1 }] }), String(amountMinor)).toMatch(/amount/i);
    expect(bad({ amountMinor: EXPENSE_AMOUNT_MAX + 1, payers: [{ memberId: A, paidMinor: EXPENSE_AMOUNT_MAX + 1 }] })).toMatch(/too large/);
    for (const spentOn of ['', '28/12/2026', '2026-13-01', '2026-02-30', 'tomorrow']) expect(bad({ spentOn }), spentOn).toMatch(/day/);
    expect(bad({ notes: 'n'.repeat(1001) })).toMatch(/1000/);
    expect(bad({ categoryKey: 'Not A Key' })).toMatch(/category/);
    expect(validateExpenseDraft(draft({ amountMinor: EXPENSE_AMOUNT_MAX, payers: [{ memberId: A, paidMinor: EXPENSE_AMOUNT_MAX }] })).ok).toBe(true);
  });

  it('checks the day against the trip dates when they are known (both ends are inside)', () => {
    const ctx = { tripStart: '2026-12-27', tripEnd: '2026-12-30' };
    expect(validateExpenseDraft(draft({ spentOn: '2026-12-27' }), ctx).ok).toBe(true);
    expect(validateExpenseDraft(draft({ spentOn: '2026-12-30' }), ctx).ok).toBe(true);
    expect(bad({ spentOn: '2026-12-26' }, ctx)).toMatch(/trip's dates/);
    expect(bad({ spentOn: '2026-12-31' }, ctx)).toMatch(/trip's dates/);
  });

  it('participants: at least one, no duplicates (even in different letter case), valid ids, at most 50', () => {
    expect(bad({ participants: [] })).toMatch(/at least one/);
    expect(bad({ participants: [A, A] })).toMatch(/once/);
    expect(bad({ participants: [A, A.toUpperCase()] })).toMatch(/once/);
    expect(bad({ participants: ['nope'] })).toMatch(/not valid/);
    expect(bad({ participants: Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) })).toMatch(/50/);
  });

  it('payers: at least one, each above zero and distinct, and together exactly the total', () => {
    expect(bad({ payers: [] })).toMatch(/who paid/);
    expect(bad({ payers: [{ memberId: A, paidMinor: 0 }, { memberId: B, paidMinor: 1000 }] })).toMatch(/more than zero/);
    expect(bad({ payers: [{ memberId: A, paidMinor: -1 }, { memberId: B, paidMinor: 1001 }] })).toMatch(/more than zero/);
    expect(bad({ payers: [{ memberId: A, paidMinor: 500.5 }, { memberId: B, paidMinor: 499.5 }] })).toMatch(/more than zero/);
    expect(bad({ payers: [{ memberId: A, paidMinor: 500 }, { memberId: A, paidMinor: 500 }] })).toMatch(/only once/);
    expect(bad({ payers: [{ memberId: A, paidMinor: 600 }, { memberId: B, paidMinor: 399 }] })).toMatch(/add up/);
    expect(bad({ payers: [{ memberId: 'x', paidMinor: 1000 }] })).toMatch(/not valid/);
    expect(validateExpenseDraft(draft({ payers: [{ memberId: A, paidMinor: 600 }, { memberId: B, paidMinor: 400 }] })).ok).toBe(true);
  });

  it('when the current members are known, a former member cannot be chosen as a participant or a payer', () => {
    const ctx = { activeMemberIds: [A, B] };
    expect(bad({ participants: [A, C] }, ctx)).toMatch(/on the trip/);
    expect(bad({ payers: [{ memberId: C, paidMinor: 1000 }] }, ctx)).toMatch(/on the trip/);
    expect(validateExpenseDraft(draft({ participants: [A, B] }), ctx).ok).toBe(true);
  });
});

describe('the exact arguments sent to the database (names must match the SQL)', () => {
  const clean = (() => {
    const r = validateExpenseDraft(draft({ payers: [{ memberId: A, paidMinor: 600 }, { memberId: B, paidMinor: 400 }] }));
    if (!r.ok) throw new Error('fixture');
    return r.value;
  })();

  it('create sends the trip, the app-chosen id, the fields, the participants and the payers, and NEVER any share', () => {
    const args = createExpenseRpcArgs(TRIP, EXP, clean);
    expect(args).toEqual({
      p_trip_id: TRIP, p_expense_id: EXP, p_title: 'Beach dinner', p_amount_minor: 1000, p_spent_on: '2026-12-28', p_category_key: 'food', p_notes: null,
      p_split_method: 'equal', p_participants: [A, B, C], p_payers: [{ member_id: A, paid_minor: 600 }, { member_id: B, paid_minor: 400 }], p_split_inputs: null,
    });
    expect(Object.keys(args).join()).not.toMatch(/share|user|uid|actor|currency/i);
  });

  it('update adds the expected version; delete and restore send only the trip, the expense and the version', () => {
    expect(updateExpenseRpcArgs(TRIP, EXP, 3, clean)).toEqual({ ...createExpenseRpcArgs(TRIP, EXP, clean), p_expected_version: 3 });
    expect(deleteExpenseRpcArgs(TRIP, EXP, 4)).toEqual({ p_trip_id: TRIP, p_expense_id: EXP, p_expected_version: 4 });
    expect(restoreExpenseRpcArgs(TRIP, EXP, 5)).toEqual({ p_trip_id: TRIP, p_expense_id: EXP, p_expected_version: 5 });
    expect(tripBalancesRpcArgs(TRIP)).toEqual({ p_trip_id: TRIP });
  });
});

describe('newExpenseId', () => {
  it('makes distinct, valid version-4 ids (lower-case)', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newExpenseId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('still works where crypto.randomUUID is missing (older phones) and where crypto is missing entirely', () => {
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) % 256; return a; } }, configurable: true });
      expect(newExpenseId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      expect(newExpenseId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});

describe('previewSplit and previewEqualSplit (a preview only; the database derives the real shares)', () => {
  for (const v of SPLIT_VECTORS) {
    it(`matches the hand-verified golden vector: ${v.name}`, () => {
      const inputs = v.inputs ? Object.entries(v.inputs).map(([memberId, value]) => ({ memberId, value })) : null;
      const got = previewSplit(v.amountMinor, v.method ?? 'equal', v.participants, inputs);
      expect(Object.fromEntries(got.map((r) => [r.memberId, r.shareMinor]))).toEqual(v.shares);
      expect(got.map((r) => r.memberId)).toEqual([...got.map((r) => r.memberId)].sort()); // always listed in id order
      if (!v.method || v.method === 'equal') expect(previewEqualSplit(v.amountMinor, v.participants)).toEqual(got);
    });
  }

  it('upper-case ids are treated as the same ids', () => {
    expect(previewSplit(1000, 'shares', [A.toUpperCase(), B], [{ memberId: A, value: 1 }, { memberId: B.toUpperCase(), value: 1 }])).toEqual([{ memberId: A, shareMinor: 500 }, { memberId: B, shareMinor: 500 }]);
  });

  it('the engine refuses what it cannot split (a missing value, a total that does not add up)', () => {
    expect(() => previewSplit(1000, 'exact', [A, B], [{ memberId: A, value: 500 }])).toThrow();
    expect(() => previewSplit(1000, 'exact', [A, B], [{ memberId: A, value: 500 }, { memberId: B, value: 400 }])).toThrow();
    expect(() => previewSplit(1000, 'percentage', [A, B], [{ memberId: A, value: 5000 }, { memberId: B, value: 4000 }])).toThrow();
    expect(() => previewSplit(1000, 'shares', [A, B], [{ memberId: A, value: 0 }, { memberId: B, value: 1 }])).toThrow();
  });
});

describe('the split methods in a draft', () => {
  const ids = [A, B, C];
  const withSplit = (splitMethod: SplitMethod, values: number[], over: Partial<ExpenseDraft> = {}) => draft({ splitMethod, splitInputs: ids.map((memberId, k) => ({ memberId, value: values[k]! })), ...over });
  const refusal = (d: ExpenseDraft) => {
    const r = validateExpenseDraft(d);
    if (r.ok) throw new Error('expected a refusal');
    return r;
  };

  it('accepts exact, percentage and shares that are well formed, and returns the typed values as sent', () => {
    const exact = validateExpenseDraft(withSplit('exact', [0, 700, 300]));
    expect(exact.ok && exact.value).toMatchObject({ splitMethod: 'exact', splitInputs: [{ memberId: A, value: 0 }, { memberId: B, value: 700 }, { memberId: C, value: 300 }] });
    const pct = validateExpenseDraft(withSplit('percentage', [5000, 3000, 2000]));
    expect(pct.ok && pct.value.splitMethod).toBe('percentage');
    const sh = validateExpenseDraft(withSplit('shares', [2, 1, 1]));
    expect(sh.ok && sh.value.splitInputs).toEqual([{ memberId: A, value: 2 }, { memberId: B, value: 1 }, { memberId: C, value: 1 }]);
    const eq = validateExpenseDraft(draft());
    expect(eq.ok && eq.value).toMatchObject({ splitMethod: 'equal', splitInputs: null });
  });

  it('every refusal names the split and says plainly what is wrong', () => {
    expect(refusal(withSplit('exact', [500, 499, 0]))).toMatchObject({ field: 'split', message: 'The amounts each person owes have to add up to the total.' });
    expect(refusal(withSplit('exact', [-1, 1001, 0]))).toMatchObject({ field: 'split' });
    expect(refusal(withSplit('percentage', [5000, 4000, 999])).message).toBe('The percentages have to add up to 100%.');
    expect(refusal(withSplit('percentage', [10000, 0, 0])).message).toMatch(/between 0\.01 and 100/);
    expect(refusal(withSplit('percentage', [10001, 1, 1])).message).toMatch(/between 0\.01 and 100/);
    expect(refusal(withSplit('shares', [1, 0, 1])).message).toMatch(/whole number from 1 to 1,000,000/);
    expect(refusal(withSplit('shares', [1, 1_000_001, 1])).field).toBe('split');
    expect(refusal(withSplit('shares', [1, 1.5, 1])).field).toBe('split');
    expect(refusal(draft({ splitMethod: 'shares' })).message).toMatch(/shares as a whole number/); // typed method, no values
    expect(refusal(draft({ splitMethod: 'weird' as SplitMethod })).field).toBe('split');
    expect(refusal(draft({ splitMethod: 'equal', splitInputs: [{ memberId: A, value: 1 }] })).message).toMatch(/takes no typed values/);
  });

  it('the typed people must be exactly the participants, each once', () => {
    expect(refusal(draft({ splitMethod: 'shares', splitInputs: [{ memberId: A, value: 1 }, { memberId: B, value: 1 }] })).field).toBe('split'); // C has no value
    expect(refusal(draft({ splitMethod: 'shares', splitInputs: [{ memberId: A, value: 1 }, { memberId: A, value: 1 }, { memberId: B, value: 1 }] })).field).toBe('split');
    expect(refusal(draft({ splitMethod: 'shares', splitInputs: [{ memberId: A, value: 1 }, { memberId: B, value: 1 }, { memberId: '00000000-0000-4000-8000-0000000000e5', value: 1 }] })).field).toBe('split');
    expect(refusal(draft({ splitMethod: 'shares', splitInputs: [{ memberId: A, value: 1 }, { memberId: B, value: 1 }, { memberId: 'nope', value: 1 }] })).field).toBe('split');
  });

  it('refusals about other parts still point at their own fields', () => {
    expect(refusal(draft({ title: '' })).field).toBe('title');
    expect(refusal(draft({ amountMinor: 0 })).field).toBe('amount');
    expect(refusal(draft({ spentOn: '2026-02-30' })).field).toBe('date');
    expect(refusal(draft({ participants: [] })).field).toBe('participants');
    expect(refusal(draft({ payers: [] })).field).toBe('payers');
    expect(refusal(draft({ categoryKey: 'Bad Key' })).field).toBe('category');
    expect(refusal(draft({ notes: 'n'.repeat(1001) })).field).toBe('notes');
  });

  it('the database arguments carry the method and the typed values (never a share); equal sends null', () => {
    const clean = (d: ExpenseDraft) => {
      const r = validateExpenseDraft(d);
      if (!r.ok) throw new Error(r.message);
      return r.value;
    };
    const args = createExpenseRpcArgs(TRIP, EXP, clean(withSplit('percentage', [5000, 3000, 2000])));
    expect(args.p_split_method).toBe('percentage');
    expect(args.p_split_inputs).toEqual([{ member_id: A, value: 5000 }, { member_id: B, value: 3000 }, { member_id: C, value: 2000 }]);
    expect(Object.keys(args).join()).not.toMatch(/share/i);
    expect(updateExpenseRpcArgs(TRIP, EXP, 2, clean(withSplit('exact', [0, 700, 300]))).p_split_inputs).toHaveLength(3);
    expect(createExpenseRpcArgs(TRIP, EXP, clean(draft())).p_split_inputs).toBeNull();
  });

  it('a stored expense with typed values reads back with its method and values, and an edit draft keeps them (former members dropped)', () => {
    const rows = [{ id: 'e1', trip_id: 't', title: 'Rent', amount_minor: 1000, category_id: null, spent_on: '2026-12-28', notes: null, split_method: 'percentage', created_by: A, updated_by: null, created_at: '', updated_at: '', version: 1, deleted_at: null, deleted_by: null }];
    const payers = [{ expense_id: 'e1', trip_member_id: A, paid_minor: 1000 }];
    const shares = [{ expense_id: 'e1', trip_member_id: A, share_minor: 500, input_value: 5000 }, { expense_id: 'e1', trip_member_id: B, share_minor: 300, input_value: '3000' }, { expense_id: 'e1', trip_member_id: C, share_minor: 200, input_value: 2000 }];
    const [e] = expensesFromRows(rows, payers, shares)!;
    expect(e).toMatchObject({ splitMethod: 'percentage' });
    expect(e!.shares).toEqual([{ memberId: A, shareMinor: 500, inputValue: 5000 }, { memberId: B, shareMinor: 300, inputValue: 3000 }, { memberId: C, shareMinor: 200, inputValue: 2000 }]);
    const d = draftFromExpense(e!, [], [A, B]); // C has left
    expect(d.splitMethod).toBe('percentage');
    expect(d.splitInputs).toEqual([{ memberId: A, value: 5000 }, { memberId: B, value: 3000 }]);
    expect(validateExpenseDraft(d).ok).toBe(false); // the percentages no longer add up: the person must fix it, nothing is silently rebalanced
  });

  it('reading refuses an expense whose typed values are missing for a non-equal method, or whose method is unknown (read again)', () => {
    const row = { id: 'e1', trip_id: 't', title: 'Rent', amount_minor: 1000, category_id: null, spent_on: '2026-12-28', notes: null, split_method: 'shares', created_by: A, updated_by: null, created_at: '', updated_at: '', version: 1, deleted_at: null, deleted_by: null };
    const payers = [{ expense_id: 'e1', trip_member_id: A, paid_minor: 1000 }];
    const shares = [{ expense_id: 'e1', trip_member_id: A, share_minor: 1000, input_value: null }];
    expect(expensesFromRows([row], payers, shares)).toBeNull();
    expect(expensesFromRows([{ ...row, split_method: 'weird' }], payers, [{ ...shares[0]!, input_value: 1 }])).toBeNull();
    expect(expensesFromRows([row], payers, [{ ...shares[0]!, input_value: 1 }])).not.toBeNull();
  });
});

describe('golden ledgers: the front end\'s own reading of balances agrees with the hand-verified numbers', () => {
  it('every ledger vector sums to zero after every step (the shape the balance screens will rely on)', () => {
    for (const v of LEDGER_VECTORS) {
      for (const step of v.steps) expect(Object.values(step.balances).reduce((a, n) => a + n, 0), v.name).toBe(0);
      expect(v.members.every((k) => MEMBER_IDS[k] !== undefined)).toBe(true);
    }
  });
});

describe('reading stored expenses', () => {
  const row = (over: Partial<ExpenseRowRecord> = {}): ExpenseRowRecord => ({
    id: EXP, trip_id: TRIP, title: 'Taxi', amount_minor: 600, category_id: 'cat1', spent_on: '2026-12-28', notes: null, split_method: 'equal',
    created_by: A, updated_by: null, created_at: '2026-11-24T10:00:00Z', updated_at: '2026-11-24T10:00:00Z', version: 2, deleted_at: null, deleted_by: null, ...over,
  });
  const payers = [{ expense_id: EXP, trip_member_id: B, paid_minor: 400 }, { expense_id: EXP, trip_member_id: A, paid_minor: 200 }];
  const shares = [{ expense_id: EXP, trip_member_id: B, share_minor: 300, input_value: null }, { expense_id: EXP, trip_member_id: A, share_minor: 300, input_value: null }];

  it('joins the three reads, sorts people by id, and flags deleted expenses', () => {
    const r = expensesFromRows([row(), row({ id: 'e2', deleted_at: '2026-11-24T11:00:00Z', deleted_by: A })], [...payers, { expense_id: 'e2', trip_member_id: A, paid_minor: 600 }], [...shares, { expense_id: 'e2', trip_member_id: A, share_minor: 600, input_value: null }])!;
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ id: EXP, title: 'Taxi', amountMinor: 600, version: 2, deleted: false, categoryId: 'cat1' });
    expect(r[0]!.payers).toEqual([{ memberId: A, paidMinor: 200 }, { memberId: B, paidMinor: 400 }]);
    expect(r[0]!.shares).toEqual([{ memberId: A, shareMinor: 300, inputValue: null }, { memberId: B, shareMinor: 300, inputValue: null }]);
    expect(r[1]).toMatchObject({ id: 'e2', deleted: true });
  });

  it('answers null (read again) when the reads disagree: missing payers, missing shares, or amounts that do not add up', () => {
    expect(expensesFromRows([row()], [], shares)).toBeNull();
    expect(expensesFromRows([row()], payers, [])).toBeNull();
    expect(expensesFromRows([row()], [{ expense_id: EXP, trip_member_id: A, paid_minor: 599 }], shares)).toBeNull();
    expect(expensesFromRows([row()], payers, [{ expense_id: EXP, trip_member_id: A, share_minor: 599, input_value: null }])).toBeNull();
    expect(expensesFromRows([], [], [])).toEqual([]);
  });

  it('keeps payer and share rows of different expenses apart', () => {
    const r = expensesFromRows([row(), row({ id: 'e2', amount_minor: 100 })], [...payers, { expense_id: 'e2', trip_member_id: C, paid_minor: 100 }], [...shares, { expense_id: 'e2', trip_member_id: C, share_minor: 100, input_value: null }])!;
    expect(r.find((e) => e.id === 'e2')!.payers).toEqual([{ memberId: C, paidMinor: 100 }]);
    expect(r.find((e) => e.id === EXP)!.payers).toHaveLength(2);
  });

  it('turns a stored expense back into an edit draft: category key restored, former members dropped', () => {
    const [e] = expensesFromRows([row()], payers, shares)!;
    const categories = [{ id: 'cat1', key: 'food', name: 'Food', icon: 'x' }];
    expect(categoryKeyOf(categories, 'cat1')).toBe('food');
    expect(categoryKeyOf(categories, 'nope')).toBeNull();
    expect(categoryKeyOf(categories, null)).toBeNull();
    const d = draftFromExpense(e!, categories, [A]); // B has left
    expect(d).toMatchObject({ title: 'Taxi', amountMinor: 600, categoryKey: 'food', spentOn: '2026-12-28' });
    expect(d.participants).toEqual([A]);
    expect(d.payers).toEqual([{ memberId: A, paidMinor: 200 }]);
    expect(validateExpenseDraft(d).ok).toBe(false); // what was paid no longer adds up: the person must fix it, nothing is silently rebalanced
  });
});

describe('balance lines', () => {
  it('settled means exactly zero', () => {
    expect(isSettled({ memberId: A, paidMinor: 0, shareMinor: 0, netMinor: 0 })).toBe(true);
    expect(isSettled({ memberId: A, paidMinor: 1, shareMinor: 0, netMinor: 1 })).toBe(false);
    expect(isSettled({ memberId: A, paidMinor: 0, shareMinor: 1, netMinor: -1 })).toBe(false);
  });
});
