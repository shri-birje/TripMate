import { parseRupees, sumMinor } from './money';
import { CoreError } from './errors';
import { isoToDmy } from './tripEdit';
import {
  SHARES_WEIGHT_MAX,
  SPLIT_MESSAGES,
  previewSplit,
  validateExpenseDraft,
  type DraftContext,
  type ExpenseCategory,
  type ExpenseDraft,
  type SplitInput,
  type SplitMethod,
  type StoredExpense,
  type TripBalanceLine,
} from './expense';
import { BASIS_POINTS_TOTAL } from './split';
import type { TripDetails } from './tripDetails';
import { parseDateInput } from './trip';

/**
 * What the expense screens need that is not money arithmetic of their own (M5, Checkpoint 4).
 *
 * THE SCREENS NEVER DECIDE MONEY. Every amount shown after saving comes from the database. The only calculations here are:
 *   - turning what a person typed ("1,200.50") into whole paise with the approved parser (parseRupees);
 *   - adding up what the listed payers typed so the form can say how much is still missing;
 *   - counting and summing the expenses that were read, for the summary line.
 * The equal split itself (previewEqualSplit) and the balances come from expense.ts and the database.
 */

export interface ExpenseFormValues {
  title: string;
  /** The total, in rupees as typed (for example "1200" or "1,200.50"). */
  amount: string;
  /** The day, DD/MM/YYYY as typed. */
  date: string;
  categoryKey: string | null;
  notes: string;
  /** The members who share the cost equally. */
  participantIds: string[];
  /** Who paid: a member id is a key when that member paid; the value is what they typed. With ONE payer the amount is the total and is not typed. */
  payerAmounts: Record<string, string>;
  /** How the cost is split between the participants. */
  splitMethod: SplitMethod;
  /** For exact, percentage and shares: what was typed for each participant (rupees, a percentage like "33.33", or a whole number of shares). Empty for equal. */
  splitValues: Record<string, string>;
}

// ---- reading what was typed for a split (text to whole numbers; no floating point) ----
/** "33.33" or "50%" or "100" to whole basis points (3333, 5000, 10000). Null if it is not a percentage with at most two decimals between 0 and 100. */
export function parsePercent(text: string): number | null {
  const t = text.trim().replace(/%$/, '').trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[1]);
  const bp = whole * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bp > BASIS_POINTS_TOTAL ? null : bp;
}

/**
 * Paise as the text a person would type into an amount box: no grouping commas, no symbol (the boxes only accept digits and one point):
 * 120000 -> "1200", 120050 -> "1200.50". Whole-number arithmetic only.
 */
export function plainRupees(minor: number): string {
  const whole = Math.floor(minor / 100);
  const frac = minor % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`;
}

/** Basis points as the text a person would type: 3333 -> "33.33", 5000 -> "50", 10000 -> "100". */
export function bpToPercentText(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

/** A whole number of shares from 1 to 1,000,000, or null. */
export function parseWeight(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,7}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= SHARES_WEIGHT_MAX ? n : null;
}

export type FormCheck = { ok: true; draft: ExpenseDraft } | { ok: false; errors: Record<string, string> };

/** The day a new expense starts on: today if it falls inside the trip, otherwise the trip's first day. Both are ISO days. */
export function defaultExpenseDay(tripStart: string, tripEnd: string, todayIso: string): string {
  return todayIso >= tripStart && todayIso <= tripEnd ? todayIso : tripStart;
}

/** An empty form: everyone on the trip shares, and the signed-in person paid (when they are on the trip). */
export function blankExpenseForm(details: TripDetails, userId: string | null, todayIso: string): ExpenseFormValues {
  const me = details.members.find((m) => userId !== null && m.userId === userId);
  return {
    title: '',
    amount: '',
    date: isoToDmy(defaultExpenseDay(details.trip.startDate, details.trip.endDate, todayIso)),
    categoryKey: null,
    notes: '',
    participantIds: details.members.map((m) => m.id),
    payerAmounts: me ? { [me.id]: '' } : {},
    splitMethod: 'equal',
    splitValues: {},
  };
}

/** The form for editing a stored expense. Former members cannot stay selected: the database refuses them, and nothing is silently rebalanced. */
export function expenseToForm(e: StoredExpense, categories: readonly ExpenseCategory[], activeMemberIds: readonly string[]): ExpenseFormValues {
  const active = new Set(activeMemberIds);
  const payers = e.payers.filter((p) => active.has(p.memberId));
  const key = e.categoryId === null ? null : (categories.find((c) => c.id === e.categoryId)?.key ?? null);
  const kept = e.shares.filter((x) => active.has(x.memberId));
  const typed = (v: number | null) => (v === null ? '' : e.splitMethod === 'exact' ? plainRupees(v) : e.splitMethod === 'percentage' ? bpToPercentText(v) : String(v));
  return {
    title: e.title,
    amount: plainRupees(e.amountMinor),
    date: isoToDmy(e.spentOn),
    categoryKey: key,
    notes: e.notes ?? '',
    participantIds: e.shares.map((s) => s.memberId).filter((id) => active.has(id)),
    payerAmounts: Object.fromEntries(payers.map((p) => [p.memberId, payers.length === 1 && payers[0]!.paidMinor === e.amountMinor ? '' : plainRupees(p.paidMinor)])),
    splitMethod: e.splitMethod,
    splitValues: e.splitMethod === 'equal' ? {} : Object.fromEntries(kept.map((x) => [x.memberId, typed(x.inputValue)])),
  };
}

// ---- the people who share, and the typed split values that go with them ----
const DEFAULT_VALUE: Record<SplitMethod, string> = { equal: '', exact: '', percentage: '', shares: '1' };

/** Changes the split method. Shares start at 1 each (an equal split by weights); the other methods start empty. Participants are kept. */
export function setSplitMethod(values: ExpenseFormValues, method: SplitMethod): ExpenseFormValues {
  if (method === values.splitMethod) return values;
  return { ...values, splitMethod: method, splitValues: method === 'equal' ? {} : Object.fromEntries(values.participantIds.map((id) => [id, DEFAULT_VALUE[method]])) };
}

/** Replaces who shares, keeping the typed values of people who stay and giving newcomers the starting value. */
export function setParticipants(values: ExpenseFormValues, ids: readonly string[]): ExpenseFormValues {
  if (values.splitMethod === 'equal') return { ...values, participantIds: [...ids], splitValues: {} };
  return { ...values, participantIds: [...ids], splitValues: Object.fromEntries(ids.map((id) => [id, values.splitValues[id] ?? DEFAULT_VALUE[values.splitMethod]])) };
}

/** Ticks or unticks one person. `order` is the trip's member order, so the list always keeps it. */
export function toggleParticipant(values: ExpenseFormValues, memberId: string, order: readonly string[]): ExpenseFormValues {
  const on = values.participantIds.includes(memberId);
  const ids = order.filter((id) => (id === memberId ? !on : values.participantIds.includes(id)));
  return setParticipants(values, ids);
}

const parserFor = (method: SplitMethod) => (method === 'exact' ? minorOf : method === 'percentage' ? parsePercent : method === 'shares' ? parseWeight : () => null);

/** Each participant's typed value as a whole number, or null for one that is blank or unreadable (for "equal" there are none). */
function typedInputs(values: ExpenseFormValues): { memberId: string; value: number | null }[] {
  if (values.splitMethod === 'equal') return [];
  const parse = parserFor(values.splitMethod);
  return values.participantIds.map((memberId) => {
    const raw = values.splitValues[memberId] ?? '';
    return { memberId, value: raw.trim() === '' ? null : parse(raw) };
  });
}

export interface SplitGap {
  method: SplitMethod;
  /** What the typed values add up to so far (paise for exact, basis points for percentage, a count of shares for shares). */
  assigned: number;
  /** What they have to add up to: the total in paise (exact), 10000 (percentage), or null (shares and equal have no target). */
  target: number | null;
  /** target - assigned, or null when there is no target (or the total is unreadable). Positive: still to assign. Negative: too much. */
  remaining: number | null;
  /** True while some participant has no readable value yet. */
  incomplete: boolean;
}

/** How far the typed split values are from being complete (for the live "still to assign" line). */
export function splitGap(values: ExpenseFormValues): SplitGap {
  const inputs = typedInputs(values);
  const assigned = inputs.reduce((a, i) => a + (i.value ?? 0), 0);
  const incomplete = inputs.some((i) => i.value === null);
  if (values.splitMethod === 'exact') {
    const total = minorOf(values.amount);
    return { method: 'exact', assigned, target: total, remaining: total === null ? null : total - assigned, incomplete };
  }
  if (values.splitMethod === 'percentage') return { method: 'percentage', assigned, target: BASIS_POINTS_TOTAL, remaining: BASIS_POINTS_TOTAL - assigned, incomplete };
  return { method: values.splitMethod, assigned, target: null, remaining: null, incomplete };
}

/**
 * The live preview of who owes what, from the shared engine, or null while the form cannot be split yet (no readable total, nobody
 * sharing, a typed value missing, or amounts and percentages that do not add up). A preview only: the database derives the real shares.
 */
export function splitPreview(values: ExpenseFormValues): Map<string, number> | null {
  const total = minorOf(values.amount);
  if (total === null || total < 1 || values.participantIds.length === 0) return null;
  try {
    if (values.splitMethod === 'equal') return new Map(previewSplit(total, 'equal', values.participantIds).map((r) => [r.memberId, r.shareMinor]));
    const typed = typedInputs(values);
    if (typed.some((i) => i.value === null)) return null;
    const inputs: SplitInput[] = typed.map((i) => ({ memberId: i.memberId, value: i.value! }));
    return new Map(previewSplit(total, values.splitMethod, values.participantIds, inputs).map((r) => [r.memberId, r.shareMinor]));
  } catch {
    return null;
  }
}

function minorOf(text: string): number | null {
  try {
    return parseRupees(text);
  } catch (e) {
    if (e instanceof CoreError) return null;
    throw e;
  }
}

/** The amount each payer paid, as text: with exactly one payer that is the whole total. */
export function effectivePayerTexts(values: ExpenseFormValues): Record<string, string> {
  const ids = Object.keys(values.payerAmounts);
  if (ids.length === 1) return { [ids[0]!]: values.amount };
  return values.payerAmounts;
}

/** Makes a member a payer, or removes them. Going from one payer to two keeps the first payer's amount (the whole total) instead of losing it. */
export function togglePayer(values: ExpenseFormValues, memberId: string): ExpenseFormValues {
  const next = { ...values.payerAmounts };
  if (memberId in next) {
    delete next[memberId];
    const left = Object.keys(next);
    if (left.length === 1) next[left[0]!] = ''; // one payer again: their amount is the total
  } else {
    const before = Object.keys(next);
    if (before.length === 1 && next[before[0]!] === '') next[before[0]!] = values.amount; // keep what the first payer paid
    next[memberId] = '';
  }
  return { ...values, payerAmounts: next };
}

export interface PayerGap {
  totalMinor: number | null;
  paidMinor: number;
  /** total - paid, or null while the total is not a readable amount. Positive: still to assign. Negative: too much. */
  remainingMinor: number | null;
  /** True while some listed payer has not typed a readable amount above zero. */
  incomplete: boolean;
}

/** How much of the total the listed payers have covered so far (for the live "still to assign" line). */
export function payerGap(values: ExpenseFormValues): PayerGap {
  const total = minorOf(values.amount);
  const texts = effectivePayerTexts(values);
  const paid = sumMinor(Object.values(texts).map((t) => minorOf(t) ?? 0));
  const incomplete = Object.values(texts).some((t) => {
    const m = t.trim() === '' ? null : minorOf(t);
    return m === null || m < 1;
  });
  return { totalMinor: total, paidMinor: paid, remainingMinor: total === null ? null : total - paid, incomplete };
}

/** Turns what was typed into a draft for the service, or one plain message per field that is wrong. */
export function formToDraft(values: ExpenseFormValues, ctx: DraftContext = {}): FormCheck {
  const errors: Record<string, string> = {};
  const title = values.title.trim();
  if (title === '') errors.title = 'Give the expense a name.';

  let amountMinor = 0;
  if (values.amount.trim() === '') errors.amount = 'Enter the amount.';
  else {
    const m = minorOf(values.amount);
    if (m === null) errors.amount = /\.$/.test(values.amount.trim()) ? 'Finish the amount: add digits after the decimal point, or remove the point.' : 'Enter an amount like 1200 or 1,200.50.';
    else if (m < 1) errors.amount = 'Enter an amount greater than zero.';
    else amountMinor = m;
  }

  const spentOn = parseDateInput(values.date);
  if (spentOn === null) errors.date = 'Enter the day as day/month/year, for example 27/12/2026.';

  if (values.participantIds.length === 0) errors.participants = 'Choose at least one person to share the cost.';

  // the typed split values: every sharing person needs a readable one
  let splitInputs: SplitInput[] | undefined;
  if (values.splitMethod !== 'equal' && values.participantIds.length > 0) {
    const typed = typedInputs(values);
    if (typed.some((i) => i.value === null)) errors.split = SPLIT_MESSAGES[values.splitMethod].missing;
    else splitInputs = typed.map((i) => ({ memberId: i.memberId, value: i.value! }));
  }

  const texts = effectivePayerTexts(values);
  const payers: { memberId: string; paidMinor: number }[] = [];
  const payerIds = Object.keys(texts);
  if (payerIds.length === 0) errors.payers = 'Say who paid.';
  else {
    for (const id of payerIds) {
      const raw = texts[id] ?? '';
      const m = raw.trim() === '' ? null : minorOf(raw);
      if (m === null || m < 1) {
        errors.payers = 'Enter how much each person who paid put in.';
        break;
      }
      payers.push({ memberId: id, paidMinor: m });
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const draft: ExpenseDraft = {
    title,
    amountMinor,
    spentOn: spentOn!,
    categoryKey: values.categoryKey,
    notes: values.notes.trim() === '' ? null : values.notes,
    participants: values.participantIds,
    payers,
    splitMethod: values.splitMethod,
    ...(splitInputs ? { splitInputs } : {}),
  };
  const checked = validateExpenseDraft(draft, ctx);
  if (!checked.ok) {
    return { ok: false, errors: { [checked.field === 'category' ? 'form' : checked.field]: checked.message } };
  }
  return { ok: true, draft };
}

// ---- who may change an expense ----
export interface ExpenseActions {
  canEdit: boolean;
  canDelete: boolean;
  canRestore: boolean;
  /** Why nothing is offered, for a one-line note. */
  reason: 'archived' | 'not_yours' | 'not_a_member' | null;
}

/**
 * Which buttons to offer. This only decides what to SHOW: the database refuses every change unless the caller is an active
 * member, an administrator or the person who added the expense, and the trip is not archived.
 */
export function expenseActions(details: TripDetails, userId: string | null, e: StoredExpense): ExpenseActions {
  const me = details.members.find((m) => userId !== null && m.userId === userId);
  if (!me) return { canEdit: false, canDelete: false, canRestore: false, reason: 'not_a_member' };
  if (details.trip.status === 'archived') return { canEdit: false, canDelete: false, canRestore: false, reason: 'archived' };
  const allowed = me.role === 'admin' || e.createdBy === me.id;
  if (!allowed) return { canEdit: false, canDelete: false, canRestore: false, reason: 'not_yours' };
  return { canEdit: !e.deleted, canDelete: !e.deleted, canRestore: e.deleted, reason: null };
}

/** Whether a new expense can be started here, and if not, why. */
export function canAddExpense(details: TripDetails, userId: string | null): { canAdd: true } | { canAdd: false; reason: 'archived' | 'not_a_member' } {
  if (!details.members.some((m) => userId !== null && m.userId === userId)) return { canAdd: false, reason: 'not_a_member' };
  if (details.trip.status === 'archived') return { canAdd: false, reason: 'archived' };
  return { canAdd: true };
}

// ---- names and labels ----
export interface PersonLabel {
  name: string;
  /** True for someone who left or was removed (their history stays). */
  former: boolean;
}

/** Every person an expense can mention, current or former, by member id. */
export function personLabels(details: TripDetails): Map<string, PersonLabel> {
  const map = new Map<string, PersonLabel>();
  for (const m of details.formerMembers) map.set(m.id, { name: m.displayName, former: true });
  for (const m of details.members) map.set(m.id, { name: m.displayName, former: false });
  return map;
}

/** The name to show for a member id. A former member gets "(left)"; someone unknown (it should never happen) is "Someone". */
export function personName(labels: ReadonlyMap<string, PersonLabel>, id: string): string {
  const p = labels.get(id);
  if (!p) return 'Someone';
  return p.former ? `${p.name} (left)` : p.name;
}

/** "Paid by Asha", "Paid by Asha and Ravi", "Paid by Asha, Ravi and 1 other". */
export function paidByLabel(e: StoredExpense, labels: ReadonlyMap<string, PersonLabel>): string {
  const names = e.payers.map((p) => personName(labels, p.memberId));
  if (names.length === 1) return `Paid by ${names[0]}`;
  if (names.length === 2) return `Paid by ${names[0]} and ${names[1]}`;
  const others = names.length - 2;
  return `Paid by ${names[0]}, ${names[1]} and ${others} ${others === 1 ? 'other' : 'others'}`;
}

/** How many live (not deleted) expenses there are and their total, for the trip summary line. */
export function expenseTotals(expenses: readonly StoredExpense[]): { count: number; totalMinor: number; deletedCount: number } {
  const live = expenses.filter((e) => !e.deleted);
  return { count: live.length, totalMinor: sumMinor(live.map((e) => e.amountMinor)), deletedCount: expenses.length - live.length };
}

export type BalanceKind = 'owed' | 'owes' | 'settled';
export const balanceKind = (line: TripBalanceLine): BalanceKind => (line.netMinor > 0 ? 'owed' : line.netMinor < 0 ? 'owes' : 'settled');
