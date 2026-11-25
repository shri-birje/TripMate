import { describe, expect, it } from 'vitest';
import type { StoredExpense, TripBalanceLine } from './expense';
import {
  balanceKind,
  blankExpenseForm,
  bpToPercentText,
  parsePercent,
  parseWeight,
  setParticipants,
  setSplitMethod,
  splitGap,
  splitPreview,
  toggleParticipant,
  canAddExpense,
  defaultExpenseDay,
  effectivePayerTexts,
  expenseActions,
  expenseToForm,
  expenseTotals,
  formToDraft,
  paidByLabel,
  payerGap,
  personLabels,
  personName,
  togglePayer,
  type ExpenseFormValues,
} from './expenseView';
import type { TripDetails, TripMember } from './tripDetails';

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';
const D = '00000000-0000-4000-8000-0000000000d4';
const ME = 'user-me';

const member = (id: string, name: string, role: 'admin' | 'member', userId: string | null = null): TripMember => ({ id, userId, displayName: name, role, status: 'active', joinedAt: '2026-11-18T10:00:00Z', isGuest: userId === null });
const details = (over: { archived?: boolean; role?: 'admin' | 'member' } = {}): TripDetails =>
  ({
    trip: { id: 't', name: 'Goa', destination: 'Goa', startDate: '2026-12-27', endDate: '2026-12-30', status: over.archived ? 'archived' : 'active', currency: 'INR' },
    members: [member(A, 'Asha', over.role ?? 'admin', ME), member(B, 'Ravi', 'member', 'u2'), member(C, 'Gita', 'member')],
    admins: [],
    formerMembers: [{ id: D, displayName: 'Dev', status: 'left', leftOn: '2026-11-15', isGuest: false }],
    creatorName: null,
    lengthDays: 4,
  }) as unknown as TripDetails;

const form = (over: Partial<ExpenseFormValues> = {}): ExpenseFormValues => ({
  title: 'Dinner', amount: '900', date: '28/12/2026', categoryKey: 'food', notes: '', participantIds: [A, B, C], payerAmounts: { [A]: '' }, splitMethod: 'equal', splitValues: {}, ...over,
});
const stored = (over: Partial<StoredExpense> = {}): StoredExpense => ({
  id: 'e1', tripId: 't', title: 'Taxi', amountMinor: 600, categoryId: 'cat1', spentOn: '2026-12-28', notes: null, createdBy: B, updatedBy: null, createdAt: '', updatedAt: '', version: 1,
  deleted: false, deletedAt: null, splitMethod: 'equal', payers: [{ memberId: B, paidMinor: 600 }], shares: [{ memberId: A, shareMinor: 300, inputValue: null }, { memberId: B, shareMinor: 300, inputValue: null }], ...over,
});

describe('starting a new expense', () => {
  it('the day is today when it falls inside the trip, otherwise the trip\'s first day', () => {
    expect(defaultExpenseDay('2026-12-27', '2026-12-30', '2026-12-28')).toBe('2026-12-28');
    expect(defaultExpenseDay('2026-12-27', '2026-12-30', '2026-12-27')).toBe('2026-12-27');
    expect(defaultExpenseDay('2026-12-27', '2026-12-30', '2026-12-30')).toBe('2026-12-30');
    expect(defaultExpenseDay('2026-12-27', '2026-12-30', '2026-11-25')).toBe('2026-12-27');
    expect(defaultExpenseDay('2026-12-27', '2026-12-30', '2027-02-01')).toBe('2026-12-27');
  });

  it('a blank form: everyone CURRENT shares, the signed-in person paid, former members are not offered', () => {
    const f = blankExpenseForm(details(), ME, '2026-11-25');
    expect(f.participantIds).toEqual([A, B, C]);
    expect(f.participantIds).not.toContain(D);
    expect(Object.keys(f.payerAmounts)).toEqual([A]);
    expect(f.date).toBe('27/12/2026');
    expect(f).toMatchObject({ title: '', amount: '', categoryKey: null, notes: '' });
  });

  it('someone who is not a member gets no default payer', () => {
    expect(blankExpenseForm(details(), 'stranger', '2026-12-28').payerAmounts).toEqual({});
  });
});

describe('payers: one, several, and the gap', () => {
  it('with ONE payer the amount is the whole total and nothing is typed', () => {
    expect(effectivePayerTexts(form({ payerAmounts: { [A]: '' } }))).toEqual({ [A]: '900' });
    expect(payerGap(form())).toEqual({ totalMinor: 90000, paidMinor: 90000, remainingMinor: 0, incomplete: false });
  });

  it('adding a second payer keeps the first payer\'s amount; removing one goes back to a single payer', () => {
    const one = form({ payerAmounts: { [A]: '' } });
    const two = togglePayer(one, B);
    expect(two.payerAmounts).toEqual({ [A]: '900', [B]: '' });
    expect(togglePayer(two, B).payerAmounts).toEqual({ [A]: '' });
    expect(togglePayer(two, A).payerAmounts).toEqual({ [B]: '' });
    expect(togglePayer(togglePayer(one, B), C).payerAmounts).toEqual({ [A]: '900', [B]: '', [C]: '' });
  });

  it('the gap says how much is still to assign (or too much), and is null while the total is unreadable', () => {
    const f = form({ payerAmounts: { [A]: '500', [B]: '' } });
    expect(payerGap(f)).toEqual({ totalMinor: 90000, paidMinor: 50000, remainingMinor: 40000, incomplete: true }); // Ravi has not typed an amount yet
    expect(payerGap(form({ payerAmounts: { [A]: '600', [B]: '400' } })).remainingMinor).toBe(-10000);
    expect(payerGap(form({ amount: 'abc' })).remainingMinor).toBeNull();
    expect(payerGap(form({ payerAmounts: { [A]: '500.50', [B]: '399.50' } })).remainingMinor).toBe(0);
  });
});

describe('formToDraft', () => {
  it('builds exactly the draft the service sends: paise, ISO day, trimmed name, empty notes as null', () => {
    const r = formToDraft(form({ title: '  Dinner ', amount: '1,200.50', payerAmounts: { [A]: '' }, notes: '   ' }), { activeMemberIds: [A, B, C] });
    expect(r).toEqual({ ok: true, draft: { title: 'Dinner', amountMinor: 120050, spentOn: '2026-12-28', categoryKey: 'food', notes: null, participants: [A, B, C], payers: [{ memberId: A, paidMinor: 120050 }], splitMethod: 'equal' } });
  });

  it('several payers with exact amounts are accepted when they add up, refused when they do not', () => {
    const ok = formToDraft(form({ payerAmounts: { [A]: '500', [B]: '400' } }));
    expect(ok.ok && ok.draft.payers).toEqual([{ memberId: A, paidMinor: 50000 }, { memberId: B, paidMinor: 40000 }]);
    const bad = formToDraft(form({ payerAmounts: { [A]: '500', [B]: '399' } }));
    expect(bad).toEqual({ ok: false, errors: { payers: 'What was paid has to add up to the total.' } });
  });

  it('every mistake gets its own plain message on its own field', () => {
    const errs = (over: Partial<ExpenseFormValues>) => {
      const r = formToDraft(form(over));
      if (r.ok) throw new Error('expected a refusal');
      return r.errors;
    };
    expect(errs({ title: '  ' }).title).toMatch(/name/);
    expect(errs({ amount: '' }).amount).toMatch(/Enter the amount/);
    expect(errs({ amount: 'abc' }).amount).toMatch(/like 1200/);
    expect(errs({ amount: '0' }).amount).toMatch(/greater than zero/);
    expect(errs({ amount: '-5' }).amount).toBeDefined();
    expect(errs({ date: '31/02/2026' }).date).toMatch(/day\/month\/year/);
    expect(errs({ date: '' }).date).toBeDefined();
    expect(errs({ participantIds: [] }).participants).toMatch(/at least one/);
    expect(errs({ payerAmounts: {} }).payers).toMatch(/who paid/);
    expect(errs({ payerAmounts: { [A]: '500', [B]: '' } }).payers).toMatch(/how much/);
    const many = errs({ title: '', amount: 'x', participantIds: [], payerAmounts: {} });
    expect(Object.keys(many).sort()).toEqual(['amount', 'participants', 'payers', 'title']);
  });

  it('with the trip and the current members known, a day outside the trip and a former member are refused', () => {
    const ctx = { tripStart: '2026-12-27', tripEnd: '2026-12-30', activeMemberIds: [A, B, C] };
    const outside = formToDraft(form({ date: '31/12/2026' }), ctx);
    expect(outside.ok).toBe(false);
    expect(!outside.ok && outside.errors.date).toMatch(/trip's dates/);
    const former = formToDraft(form({ participantIds: [A, D] }), ctx);
    expect(!former.ok && former.errors.participants).toMatch(/on the trip/);
    const formerPayer = formToDraft(form({ payerAmounts: { [D]: '' } }), ctx);
    expect(formerPayer.ok).toBe(false);
  });
});

describe('editing a stored expense', () => {
  it('fills the form from what was stored (single payer = no typed amount), former members dropped', () => {
    const cats = [{ id: 'cat1', key: 'food', name: 'Food', icon: 'x' }];
    const f = expenseToForm(stored(), cats, [A, B, C]);
    expect(f).toMatchObject({ title: 'Taxi', amount: '6', date: '28/12/2026', categoryKey: 'food', participantIds: [A, B], payerAmounts: { [B]: '' } });
    const multi = expenseToForm(stored({ payers: [{ memberId: A, paidMinor: 200 }, { memberId: B, paidMinor: 400 }] }), cats, [A, B, C]);
    expect(multi.payerAmounts).toEqual({ [A]: '2', [B]: '4' });
    const gone = expenseToForm(stored({ shares: [{ memberId: D, shareMinor: 300, inputValue: null }, { memberId: A, shareMinor: 300, inputValue: null }], payers: [{ memberId: D, paidMinor: 600 }] }), cats, [A, B, C]);
    expect(gone.participantIds).toEqual([A]);
    expect(gone.payerAmounts).toEqual({}); // the person must choose who paid: nothing is silently reassigned
    expect(formToDraft(gone).ok).toBe(false);
  });

  it('round-trips: an untouched edit form gives back the same draft the expense was saved with', () => {
    const cats = [{ id: 'cat1', key: 'food', name: 'Food', icon: 'x' }];
    const e = stored({ amountMinor: 120050, payers: [{ memberId: A, paidMinor: 120050 }], shares: [{ memberId: A, shareMinor: 60025, inputValue: null }, { memberId: B, shareMinor: 60025, inputValue: null }] });
    const r = formToDraft(expenseToForm(e, cats, [A, B, C]));
    expect(r.ok && r.draft).toMatchObject({ title: 'Taxi', amountMinor: 120050, spentOn: '2026-12-28', categoryKey: 'food', participants: [A, B], payers: [{ memberId: A, paidMinor: 120050 }] });
  });
});

describe('who may change an expense (display only; the database decides)', () => {
  it('an administrator may change any expense; a member only their own; deleted ones can be restored, not edited', () => {
    const admin = expenseActions(details({ role: 'admin' }), ME, stored({ createdBy: B }));
    expect(admin).toEqual({ canEdit: true, canDelete: true, canRestore: false, reason: null });
    const memberOther = expenseActions(details({ role: 'member' }), ME, stored({ createdBy: B }));
    expect(memberOther).toEqual({ canEdit: false, canDelete: false, canRestore: false, reason: 'not_yours' });
    const memberOwn = expenseActions(details({ role: 'member' }), ME, stored({ createdBy: A }));
    expect(memberOwn).toMatchObject({ canEdit: true, canDelete: true });
    expect(expenseActions(details(), ME, stored({ deleted: true }))).toEqual({ canEdit: false, canDelete: false, canRestore: true, reason: null });
    expect(expenseActions(details({ role: 'member' }), ME, stored({ deleted: true, createdBy: B })).canRestore).toBe(false);
  });

  it('an archived trip and a non-member get nothing', () => {
    expect(expenseActions(details({ archived: true }), ME, stored())).toEqual({ canEdit: false, canDelete: false, canRestore: false, reason: 'archived' });
    expect(expenseActions(details(), 'stranger', stored()).reason).toBe('not_a_member');
    expect(expenseActions(details(), null, stored()).reason).toBe('not_a_member');
  });

  it('adding is offered to members of an active trip only', () => {
    expect(canAddExpense(details(), ME)).toEqual({ canAdd: true });
    expect(canAddExpense(details({ archived: true }), ME)).toEqual({ canAdd: false, reason: 'archived' });
    expect(canAddExpense(details(), 'stranger')).toEqual({ canAdd: false, reason: 'not_a_member' });
  });
});

describe('names and labels', () => {
  const labels = personLabels(details());
  it('current members by name, former members marked "(left)", an unknown id as "Someone"', () => {
    expect(personName(labels, A)).toBe('Asha');
    expect(personName(labels, D)).toBe('Dev (left)');
    expect(personName(labels, 'zzz')).toBe('Someone');
  });

  it('"Paid by ..." for one, two and several payers', () => {
    expect(paidByLabel(stored({ payers: [{ memberId: A, paidMinor: 600 }] }), labels)).toBe('Paid by Asha');
    expect(paidByLabel(stored({ payers: [{ memberId: A, paidMinor: 300 }, { memberId: D, paidMinor: 300 }] }), labels)).toBe('Paid by Asha and Dev (left)');
    expect(paidByLabel(stored({ payers: [{ memberId: A, paidMinor: 200 }, { memberId: B, paidMinor: 200 }, { memberId: C, paidMinor: 200 }] }), labels)).toBe('Paid by Asha, Ravi and 1 other');
    expect(paidByLabel(stored({ payers: [A, B, C, D].map((m) => ({ memberId: m, paidMinor: 150 })) }), labels)).toBe('Paid by Asha, Ravi and 2 others');
  });

  it('the summary counts and adds only live expenses', () => {
    expect(expenseTotals([stored(), stored({ id: 'e2', amountMinor: 400 }), stored({ id: 'e3', amountMinor: 999, deleted: true })])).toEqual({ count: 2, totalMinor: 1000, deletedCount: 1 });
    expect(expenseTotals([])).toEqual({ count: 0, totalMinor: 0, deletedCount: 0 });
  });

  it('a balance is owed, owes or settled', () => {
    const line = (netMinor: number): TripBalanceLine => ({ memberId: A, paidMinor: 0, shareMinor: 0, netMinor });
    expect([balanceKind(line(5)), balanceKind(line(-5)), balanceKind(line(0))]).toEqual(['owed', 'owes', 'settled']);
  });
});

describe('payer gap: incomplete amounts', () => {
  it('is incomplete while any listed payer has no readable amount above zero, even if the sums happen to match', () => {
    expect(payerGap(form({ payerAmounts: { [A]: '900', [B]: '' } })).incomplete).toBe(true);
    expect(payerGap(form({ payerAmounts: { [A]: '900', [B]: '0' } })).incomplete).toBe(true);
    expect(payerGap(form({ payerAmounts: { [A]: '900', [B]: 'abc' } })).incomplete).toBe(true);
    expect(payerGap(form({ payerAmounts: { [A]: '500', [B]: '400' } })).incomplete).toBe(false);
    expect(payerGap(form({ payerAmounts: { [A]: '' } })).incomplete).toBe(false); // one payer: the total
  });
});


describe('typed split values', () => {
  it('percentages are read as whole basis points, at most two decimals, never through floating point', () => {
    expect(parsePercent('33.33')).toBe(3333);
    expect(parsePercent('33.3')).toBe(3330);
    expect(parsePercent('50')).toBe(5000);
    expect(parsePercent('50%')).toBe(5000);
    expect(parsePercent(' 100 ')).toBe(10000);
    expect(parsePercent('0.01')).toBe(1);
    expect(parsePercent('0')).toBe(0);
    for (const bad of ['', 'abc', '100.01', '101', '33.333', '-5', '1e2', '5,5', '.5']) expect(parsePercent(bad), bad).toBeNull();
    expect(parsePercent('0.07')).toBe(7); // 0.07 * 100 would be 7.000000000000001 in floating point
  });

  it('basis points turn back into the text a person would type', () => {
    expect([3333, 5000, 10000, 1, 10, 3330, 7].map(bpToPercentText)).toEqual(['33.33', '50', '100', '0.01', '0.1', '33.3', '0.07']);
    for (const bp of [1, 7, 10, 99, 100, 1234, 3333, 9999, 10000]) expect(parsePercent(bpToPercentText(bp))).toBe(bp);
  });

  it('shares are whole numbers from 1 to 1,000,000', () => {
    expect([parseWeight('1'), parseWeight(' 2 '), parseWeight('1000000')]).toEqual([1, 2, 1000000]);
    for (const bad of ['', '0', '1.5', '-1', '1000001', 'two', '1e3', '12345678']) expect(parseWeight(bad), bad).toBeNull();
  });
});

describe('choosing the split method and who shares', () => {
  it('switching to shares starts everybody at 1; exact and percentage start empty; equal clears; switching to the same method changes nothing', () => {
    const base = form();
    expect(setSplitMethod(base, 'shares').splitValues).toEqual({ [A]: '1', [B]: '1', [C]: '1' });
    expect(setSplitMethod(base, 'exact').splitValues).toEqual({ [A]: '', [B]: '', [C]: '' });
    expect(setSplitMethod(base, 'percentage').splitValues).toEqual({ [A]: '', [B]: '', [C]: '' });
    expect(setSplitMethod(setSplitMethod(base, 'shares'), 'equal').splitValues).toEqual({});
    const same = setSplitMethod(base, 'shares');
    expect(setSplitMethod(same, 'shares')).toBe(same);
    expect(setSplitMethod(base, 'exact').participantIds).toEqual([A, B, C]);
  });

  it('ticking and unticking people keeps the typed values of the people who stay and gives newcomers the starting value, in the trip order', () => {
    const order = [A, B, C];
    let v = setSplitMethod(form(), 'shares');
    v = { ...v, splitValues: { [A]: '2', [B]: '3', [C]: '4' } };
    v = toggleParticipant(v, B, order);
    expect(v.participantIds).toEqual([A, C]);
    expect(v.splitValues).toEqual({ [A]: '2', [C]: '4' });
    v = toggleParticipant(v, B, order);
    expect(v.participantIds).toEqual([A, B, C]);
    expect(v.splitValues).toEqual({ [A]: '2', [B]: '1', [C]: '4' }); // B is back at the starting value, not the old 3
    expect(setParticipants(v, [C]).splitValues).toEqual({ [C]: '4' });
    expect(toggleParticipant(form(), B, order).splitValues).toEqual({}); // equal: nothing typed
  });
});

describe('the split gap and the live preview', () => {
  const pct = (values: Record<string, string>, amount = '10') => form({ amount, splitMethod: 'percentage', splitValues: values });

  it('percentages: how many percent are still to assign, in basis points', () => {
    expect(splitGap(pct({ [A]: '50', [B]: '30', [C]: '' }))).toEqual({ method: 'percentage', assigned: 8000, target: 10000, remaining: 2000, incomplete: true });
    expect(splitGap(pct({ [A]: '50', [B]: '30', [C]: '20' }))).toMatchObject({ remaining: 0, incomplete: false });
    expect(splitGap(pct({ [A]: '60', [B]: '30', [C]: '20' }))).toMatchObject({ remaining: -1000, incomplete: false });
  });

  it('exact amounts: how much of the total is still to assign (zero is a valid amount)', () => {
    const exact = (values: Record<string, string>) => form({ amount: '10', splitMethod: 'exact', splitValues: values });
    expect(splitGap(exact({ [A]: '0', [B]: '7', [C]: '3' }))).toEqual({ method: 'exact', assigned: 1000, target: 1000, remaining: 0, incomplete: false });
    expect(splitGap(exact({ [A]: '4', [B]: '', [C]: '' }))).toMatchObject({ assigned: 400, remaining: 600, incomplete: true });
    expect(splitGap(form({ amount: 'abc', splitMethod: 'exact', splitValues: { [A]: '1', [B]: '1', [C]: '1' } })).remaining).toBeNull();
  });

  it('shares and equal have no target', () => {
    expect(splitGap(form({ splitMethod: 'shares', splitValues: { [A]: '2', [B]: '1', [C]: '1' } }))).toEqual({ method: 'shares', assigned: 4, target: null, remaining: null, incomplete: false });
    expect(splitGap(form()).target).toBeNull();
    expect(splitGap(form({ splitMethod: 'shares', splitValues: { [A]: '2', [B]: 'x', [C]: '1' } })).incomplete).toBe(true);
  });

  it('the preview uses the shared engine for every method, and is empty until the form can really be split', () => {
    expect(Object.fromEntries(splitPreview(form({ amount: '10' }))!)).toEqual({ [A]: 334, [B]: 333, [C]: 333 });
    expect(Object.fromEntries(splitPreview(form({ amount: '10', splitMethod: 'shares', splitValues: { [A]: '2', [B]: '1', [C]: '1' } }))!)).toEqual({ [A]: 500, [B]: 250, [C]: 250 });
    expect(Object.fromEntries(splitPreview(pct({ [A]: '33.33', [B]: '33.33', [C]: '33.34' }))!)).toEqual({ [A]: 333, [B]: 333, [C]: 334 });
    expect(Object.fromEntries(splitPreview(form({ amount: '10', splitMethod: 'exact', splitValues: { [A]: '0', [B]: '7', [C]: '3' } }))!)).toEqual({ [A]: 0, [B]: 700, [C]: 300 });
    expect(splitPreview(pct({ [A]: '50', [B]: '30', [C]: '' }))).toBeNull(); // incomplete
    expect(splitPreview(pct({ [A]: '50', [B]: '30', [C]: '10' }))).toBeNull(); // adds up to 90%
    expect(splitPreview(form({ amount: '10', splitMethod: 'exact', splitValues: { [A]: '1', [B]: '1', [C]: '1' } }))).toBeNull(); // adds up to 3
    expect(splitPreview(form({ amount: '' }))).toBeNull();
    expect(splitPreview(form({ amount: '10', participantIds: [] }))).toBeNull();
  });
});

describe('formToDraft with a split method', () => {
  it('builds the typed values as whole numbers for each method, and the draft is accepted', () => {
    const pctDraft = formToDraft(form({ amount: '10', splitMethod: 'percentage', splitValues: { [A]: '33.33', [B]: '33.33', [C]: '33.34' } }));
    expect(pctDraft.ok && pctDraft.draft).toMatchObject({ splitMethod: 'percentage', splitInputs: [{ memberId: A, value: 3333 }, { memberId: B, value: 3333 }, { memberId: C, value: 3334 }] });
    const exactDraft = formToDraft(form({ amount: '10', splitMethod: 'exact', splitValues: { [A]: '0', [B]: '7', [C]: '3' } }));
    expect(exactDraft.ok && exactDraft.draft).toMatchObject({ splitMethod: 'exact', splitInputs: [{ memberId: A, value: 0 }, { memberId: B, value: 700 }, { memberId: C, value: 300 }] });
    const sharesDraft = formToDraft(form({ splitMethod: 'shares', splitValues: { [A]: '2', [B]: '1', [C]: '1' } }));
    expect(sharesDraft.ok && sharesDraft.draft).toMatchObject({ splitMethod: 'shares', splitInputs: [{ memberId: A, value: 2 }, { memberId: B, value: 1 }, { memberId: C, value: 1 }] });
    const eq = formToDraft(form());
    expect(eq.ok && eq.draft.splitMethod).toBe('equal');
    expect(eq.ok && eq.draft.splitInputs).toBeUndefined();
  });

  it('each way a split can be wrong gets a plain message on the "split" field, and nothing else changes', () => {
    const errs = (over: Partial<ExpenseFormValues>) => {
      const r = formToDraft(form({ amount: '10', ...over }));
      if (r.ok) throw new Error('expected a refusal');
      return r.errors;
    };
    expect(errs({ splitMethod: 'exact', splitValues: { [A]: '4', [B]: '', [C]: '' } }).split).toBe('Enter how much each person owes.');
    expect(errs({ splitMethod: 'exact', splitValues: { [A]: '4', [B]: '3', [C]: '2' } }).split).toBe('The amounts each person owes have to add up to the total.');
    expect(errs({ splitMethod: 'percentage', splitValues: { [A]: '50', [B]: '30', [C]: '10' } }).split).toBe('The percentages have to add up to 100%.');
    expect(errs({ splitMethod: 'percentage', splitValues: { [A]: '50', [B]: 'x', [C]: '10' } }).split).toMatch(/percentage/);
    expect(errs({ splitMethod: 'percentage', splitValues: { [A]: '100', [B]: '0', [C]: '0' } }).split).toMatch(/percentage/); // zero percent is not a share
    expect(errs({ splitMethod: 'shares', splitValues: { [A]: '2', [B]: '0', [C]: '1' } }).split).toMatch(/shares as a whole number/);
    expect(errs({ splitMethod: 'shares', splitValues: { [A]: '1.5', [B]: '1', [C]: '1' } }).split).toBeDefined();
    expect(errs({ title: '', splitMethod: 'shares', splitValues: { [A]: '1', [B]: '1', [C]: '0' } })).toMatchObject({ title: expect.any(String), split: expect.any(String) });
  });

  it('with no one sharing there is no split error (the participants message is enough)', () => {
    const r = formToDraft(form({ participantIds: [], splitMethod: 'shares', splitValues: {} }));
    expect(!r.ok && r.errors).toEqual({ participants: 'Choose at least one person to share the cost.' });
  });

  it('a stored expense with typed values fills the form with them (as typed), and an untouched edit gives back the same draft', () => {
    const cats = [{ id: 'cat1', key: 'food', name: 'Food', icon: 'x' }];
    const e = stored({ amountMinor: 1000, splitMethod: 'percentage', payers: [{ memberId: A, paidMinor: 1000 }], shares: [{ memberId: A, shareMinor: 500, inputValue: 5000 }, { memberId: B, shareMinor: 333, inputValue: 3333 }, { memberId: C, shareMinor: 167, inputValue: 1667 }] });
    const f = expenseToForm(e, cats, [A, B, C]);
    expect(f).toMatchObject({ splitMethod: 'percentage', splitValues: { [A]: '50', [B]: '33.33', [C]: '16.67' } });
    const r = formToDraft(f);
    expect(r.ok && r.draft).toMatchObject({ splitMethod: 'percentage', splitInputs: [{ memberId: A, value: 5000 }, { memberId: B, value: 3333 }, { memberId: C, value: 1667 }] });
    const ex = stored({ amountMinor: 1000, splitMethod: 'exact', payers: [{ memberId: A, paidMinor: 1000 }], shares: [{ memberId: A, shareMinor: 0, inputValue: 0 }, { memberId: B, shareMinor: 1000, inputValue: 1000 }] });
    expect(expenseToForm(ex, cats, [A, B]).splitValues).toEqual({ [A]: '0', [B]: '10' });
    const sh = stored({ splitMethod: 'shares', shares: [{ memberId: A, shareMinor: 400, inputValue: 2 }, { memberId: B, shareMinor: 200, inputValue: 1 }] });
    expect(expenseToForm(sh, cats, [A, B]).splitValues).toEqual({ [A]: '2', [B]: '1' });
    // a person who has left is dropped, and what remains no longer adds up: the person must fix it
    const gone = expenseToForm(e, cats, [A, B]);
    expect(Object.keys(gone.splitValues)).toEqual([A, B]);
    expect(formToDraft(gone).ok).toBe(false);
  });
});
