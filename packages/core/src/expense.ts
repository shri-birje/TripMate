import { partsOfIso } from './calendar';
import { BASIS_POINTS_TOTAL, computeSplit, type SplitSpec } from './split';
import { isValidTripId } from './tripDetails';

/**
 * Rules and helpers for shared expenses (M5, ADR-063).
 *
 * THE DATABASE IS THE AUTHORITY. The database functions create_expense, update_expense, delete_expense and restore_expense
 * validate everything again (who may do it, whether the trip is archived, who is an active member, the dates, the version),
 * DERIVE the shares themselves, and keep every balance (trip_member_balances). Nothing here decides money:
 *   - `validateExpenseDraft` only gives friendly, early messages for mistakes the database would also refuse;
 *   - `previewEqualSplit` is a PREVIEW (and the reference implementation the database is tested against). The database never
 *     receives shares from the app, and the shares it stores are the ones it derives;
 *   - the argument builders only shape what is sent (names must match the SQL).
 *
 * Split methods (all derived by the database; the shares are never sent):
 *   equal       the listed participants share the total equally (largest remainder, lowest member id first for leftover paise)
 *   exact       each participant's amount is typed; the amounts must add up to the total (a person may owe zero)
 *   percentage  each participant's percentage is typed (whole basis points, 100% = 10000, at least 1 each) and must add up to 100%
 *   shares      each participant's weight is typed (a whole number from 1 to 1,000,000, for example 2 : 1 : 1)
 * Percentage and shares use the SAME largest-remainder rule as the equal split, with those numbers as weights.
 */

export const EXPENSE_TITLE_MAX = 120;
export const EXPENSE_NOTES_MAX = 1000;
export const EXPENSE_AMOUNT_MAX = 1_000_000_000_000; // paise (10^12), the database limit
export const EXPENSE_MAX_PEOPLE = 50;
export const EXPENSE_SPLIT_METHOD = 'equal';
export const SPLIT_METHODS = ['equal', 'exact', 'percentage', 'shares'] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];
export const SHARES_WEIGHT_MAX = 1_000_000; // an input limit (the engine itself accepts any positive whole weight)
export const isSplitMethod = (v: unknown): v is SplitMethod => typeof v === 'string' && (SPLIT_METHODS as readonly string[]).includes(v);

/** One participant's typed value: paise (exact), basis points (percentage) or a weight (shares). */
export interface SplitInput {
  memberId: string;
  value: number;
}
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** One payer: how much this member paid (paise). */
export interface ExpensePayer {
  memberId: string;
  paidMinor: number;
}

/** What the person typed into the form (money in paise, the day as YYYY-MM-DD). */
export interface ExpenseDraft {
  title: string;
  amountMinor: number;
  spentOn: string;
  /** A system category's key (for example "food"), or null for none. */
  categoryKey: string | null;
  notes: string | null;
  /** The members who share the cost equally. */
  participants: readonly string[];
  /** Who paid, and how much each; the amounts must add up to `amountMinor`. */
  payers: readonly ExpensePayer[];
  /** How the cost is split. Absent means equal. */
  splitMethod?: SplitMethod;
  /** For exact, percentage and shares: the typed value of EVERY participant. Absent (or empty) for equal. */
  splitInputs?: readonly SplitInput[];
}

/** The same draft after trimming and checking: exactly what is sent to the database. */
export interface CleanExpense {
  title: string;
  amountMinor: number;
  spentOn: string;
  categoryKey: string | null;
  notes: string | null;
  participants: string[];
  payers: ExpensePayer[];
  splitMethod: SplitMethod;
  /** null for equal. */
  splitInputs: SplitInput[] | null;
}

export interface DraftContext {
  /** When given, the day must lie inside the trip (the database checks this again). */
  tripStart?: string;
  tripEnd?: string;
  /** When given, every participant and payer must be one of these (current members; the database checks this again). */
  activeMemberIds?: readonly string[];
}

/** On a refusal: the plain sentence, and which part of the form it is about (for the form to point at). */
export type DraftField = 'title' | 'amount' | 'date' | 'category' | 'notes' | 'participants' | 'payers' | 'split';
export type DraftCheck = { ok: true; value: CleanExpense } | { ok: false; message: string; field: DraftField };

const fail = (message: string, field: DraftField): DraftCheck => ({ ok: false, message, field });
const isMinor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

/** What to say when a typed split value is missing, out of range, or does not add up. */
export const SPLIT_MESSAGES: Record<Exclude<SplitMethod, 'equal'>, { missing: string; invalid: string; total: string }> = {
  exact: { missing: 'Enter how much each person owes.', invalid: 'Each amount has to be zero or more.', total: 'The amounts each person owes have to add up to the total.' },
  percentage: { missing: 'Enter each person\'s percentage, for example 33.33.', invalid: 'Each percentage has to be between 0.01 and 100.', total: 'The percentages have to add up to 100%.' },
  shares: { missing: 'Enter each person\'s shares as a whole number, for example 2.', invalid: `Each person's shares have to be a whole number from 1 to ${SHARES_WEIGHT_MAX.toLocaleString('en-US')}.`, total: '' },
};

/** Friendly early checks. A pass here is NOT approval: the database decides. */
export function validateExpenseDraft(draft: ExpenseDraft, ctx: DraftContext = {}): DraftCheck {
  const title = typeof draft.title === 'string' ? draft.title.trim() : '';
  if (title.length < 1) return fail('Give the expense a name.', 'title');
  if (title.length > EXPENSE_TITLE_MAX) return fail(`The name can be at most ${EXPENSE_TITLE_MAX} characters.`, 'title');

  if (!isMinor(draft.amountMinor) || draft.amountMinor < 1) return fail('Enter an amount greater than zero.', 'amount');
  if (draft.amountMinor > EXPENSE_AMOUNT_MAX) return fail('That amount is too large.', 'amount');

  if (typeof draft.spentOn !== 'string' || !ISO_DAY.test(draft.spentOn) || partsOfIso(draft.spentOn) === null) return fail('Choose the day the money was spent.', 'date');
  if (ctx.tripStart && draft.spentOn < ctx.tripStart) return fail("The day has to fall within the trip's dates.", 'date');
  if (ctx.tripEnd && draft.spentOn > ctx.tripEnd) return fail("The day has to fall within the trip's dates.", 'date');

  if (draft.categoryKey !== null && (typeof draft.categoryKey !== 'string' || !KEY.test(draft.categoryKey))) return fail('Pick a category from the list.', 'category');

  const notes = draft.notes === null || draft.notes === undefined ? null : String(draft.notes).trim() || null;
  if (notes !== null && notes.length > EXPENSE_NOTES_MAX) return fail(`The notes can be at most ${EXPENSE_NOTES_MAX} characters.`, 'notes');

  if (!Array.isArray(draft.participants) || draft.participants.length < 1) return fail('Choose at least one person to share the cost.', 'participants');
  if (draft.participants.length > EXPENSE_MAX_PEOPLE) return fail(`At most ${EXPENSE_MAX_PEOPLE} people can share an expense.`, 'participants');
  if (!draft.participants.every(isValidTripId)) return fail('Someone chosen is not valid. Reload and try again.', 'participants');
  const participants = draft.participants.map((id) => id.toLowerCase());
  if (new Set(participants).size !== participants.length) return fail('Each person can be chosen only once.', 'participants');

  if (!Array.isArray(draft.payers) || draft.payers.length < 1) return fail('Say who paid.', 'payers');
  if (draft.payers.length > EXPENSE_MAX_PEOPLE) return fail(`At most ${EXPENSE_MAX_PEOPLE} people can have paid.`, 'payers');
  const payers: ExpensePayer[] = [];
  for (const p of draft.payers) {
    if (!p || !isValidTripId(p.memberId)) return fail('Someone who paid is not valid. Reload and try again.', 'payers');
    if (!isMinor(p.paidMinor) || p.paidMinor < 1) return fail('Each person who paid must have paid more than zero.', 'payers');
    payers.push({ memberId: p.memberId.toLowerCase(), paidMinor: p.paidMinor });
  }
  if (new Set(payers.map((p) => p.memberId)).size !== payers.length) return fail('Each person can be listed as a payer only once.', 'payers');
  if (payers.reduce((sum, p) => sum + p.paidMinor, 0) !== draft.amountMinor) return fail('What was paid has to add up to the total.', 'payers');

  const splitMethod: SplitMethod = draft.splitMethod ?? 'equal';
  if (!isSplitMethod(splitMethod)) return fail('Choose how to split the cost.', 'split');
  let splitInputs: SplitInput[] | null = null;
  if (splitMethod !== 'equal') {
    const raw = draft.splitInputs;
    if (!Array.isArray(raw) || raw.length !== participants.length) return fail(SPLIT_MESSAGES[splitMethod].missing, 'split');
    splitInputs = [];
    for (const i of raw) {
      if (!i || !isValidTripId(i.memberId) || !participants.includes(i.memberId.toLowerCase())) return fail('Each person who shares needs a value.', 'split');
      if (!Number.isSafeInteger(i.value)) return fail(SPLIT_MESSAGES[splitMethod].invalid, 'split');
      splitInputs.push({ memberId: i.memberId.toLowerCase(), value: i.value });
    }
    if (new Set(splitInputs.map((i) => i.memberId)).size !== participants.length) return fail('Each person who shares needs exactly one value.', 'split');
    const values = splitInputs.map((i) => i.value);
    if (splitMethod === 'exact') {
      if (values.some((v) => v < 0 || v > EXPENSE_AMOUNT_MAX)) return fail(SPLIT_MESSAGES.exact.invalid, 'split');
      if (values.reduce((a, v) => a + v, 0) !== draft.amountMinor) return fail(SPLIT_MESSAGES.exact.total, 'split');
    } else if (splitMethod === 'percentage') {
      if (values.some((v) => v < 1 || v > BASIS_POINTS_TOTAL)) return fail(SPLIT_MESSAGES.percentage.invalid, 'split');
      if (values.reduce((a, v) => a + v, 0) !== BASIS_POINTS_TOTAL) return fail(SPLIT_MESSAGES.percentage.total, 'split');
    } else if (values.some((v) => v < 1 || v > SHARES_WEIGHT_MAX)) {
      return fail(SPLIT_MESSAGES.shares.invalid, 'split');
    }
  } else if (draft.splitInputs && draft.splitInputs.length > 0) {
    return fail('An equal split takes no typed values.', 'split');
  }

  if (ctx.activeMemberIds) {
    const active = new Set(ctx.activeMemberIds.map((id) => id.toLowerCase()));
    if (!participants.every((id) => active.has(id))) return fail('Only people who are on the trip can share an expense.', 'participants');
    if (!payers.every((p) => active.has(p.memberId))) return fail('Only people who are on the trip can have paid.', 'payers');
  }
  return { ok: true, value: { title, amountMinor: draft.amountMinor, spentOn: draft.spentOn, categoryKey: draft.categoryKey, notes, participants, payers, splitMethod, splitInputs } };
}

// ---- the exact arguments each database function takes (names must match the SQL) ----
function sharedFields(e: CleanExpense) {
  return {
    p_title: e.title,
    p_amount_minor: e.amountMinor,
    p_spent_on: e.spentOn,
    p_category_key: e.categoryKey,
    p_notes: e.notes,
    p_split_method: e.splitMethod,
    p_participants: e.participants,
    p_payers: e.payers.map((p) => ({ member_id: p.memberId, paid_minor: p.paidMinor })),
    p_split_inputs: e.splitInputs ? e.splitInputs.map((i) => ({ member_id: i.memberId, value: i.value })) : null,
  };
}
export const createExpenseRpcArgs = (tripId: string, expenseId: string, e: CleanExpense) => ({ p_trip_id: tripId, p_expense_id: expenseId, ...sharedFields(e) });
export const updateExpenseRpcArgs = (tripId: string, expenseId: string, expectedVersion: number, e: CleanExpense) => ({
  p_trip_id: tripId,
  p_expense_id: expenseId,
  p_expected_version: expectedVersion,
  ...sharedFields(e),
});
export const deleteExpenseRpcArgs = (tripId: string, expenseId: string, expectedVersion: number) => ({ p_trip_id: tripId, p_expense_id: expenseId, p_expected_version: expectedVersion });
export const restoreExpenseRpcArgs = deleteExpenseRpcArgs;
export const tripBalancesRpcArgs = (tripId: string) => ({ p_trip_id: tripId });

/**
 * A new expense id, chosen by the app so that a retry of the same save can never create two expenses. The caller makes ONE id
 * per new expense (when the form opens) and sends the same id on every retry.
 */
export function newExpenseId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID().toLowerCase();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256); // last resort: only uniqueness matters here, and the database refuses a clash
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The engine's description of how an expense is split (used for previews and as the reference the database is tested against). */
function specOf(method: SplitMethod, participants: readonly string[], inputs: readonly SplitInput[] | null | undefined): SplitSpec {
  const ids = participants.map((id) => id.toLowerCase());
  if (method === 'equal') return { method, participants: ids };
  const valueOf = (id: string) => inputs?.find((i) => i.memberId.toLowerCase() === id)?.value ?? Number.NaN;
  if (method === 'percentage') return { method, inputs: ids.map((memberId) => ({ memberId, basisPoints: valueOf(memberId) })) };
  if (method === 'exact') return { method, inputs: ids.map((memberId) => ({ memberId, amountMinor: valueOf(memberId) })) };
  return { method, inputs: ids.map((memberId) => ({ memberId, weight: valueOf(memberId) })) };
}

/**
 * PREVIEW of any split method (the same engine and the same rounding the database is tested against). Throws a CoreError for
 * values the engine refuses. Never send this to the database: it derives and stores the real shares itself.
 */
export function previewSplit(amountMinor: number, method: SplitMethod, participants: readonly string[], inputs: readonly SplitInput[] | null = null): { memberId: string; shareMinor: number }[] {
  return computeSplit(amountMinor, specOf(method, participants, inputs))
    .map((r) => ({ memberId: r.memberId, shareMinor: r.shareMinor }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/**
 * PREVIEW of the equal split (largest remainder, lowest member id first for the leftover paise). The database derives and stores the
 * real shares with the same rule; the two are tested against each other. Never send this to the database.
 */
export function previewEqualSplit(amountMinor: number, participants: readonly string[]): { memberId: string; shareMinor: number }[] {
  return computeSplit(amountMinor, { method: 'equal', participants: participants.map((id) => id.toLowerCase()) })
    .map((r) => ({ memberId: r.memberId, shareMinor: r.shareMinor }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

// ---- stored expenses, as the database sends them back ----
export interface ExpenseRowRecord {
  id: string;
  trip_id: string;
  title: string;
  amount_minor: number;
  category_id: string | null;
  spent_on: string;
  notes: string | null;
  split_method: string;
  created_by: string;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  deleted_by: string | null;
}
export interface PayerRowRecord {
  expense_id: string;
  trip_member_id: string;
  paid_minor: number;
}
export interface ShareRowRecord {
  expense_id: string;
  trip_member_id: string;
  share_minor: number;
  /** The typed value (paise, basis points or a weight); null for an equal split. */
  input_value: number | string | null;
}
export interface CategoryRowRecord {
  id: string;
  key: string;
  name: string;
  icon: string;
  sort_order: number;
}

export interface StoredExpense {
  id: string;
  tripId: string;
  title: string;
  amountMinor: number;
  categoryId: string | null;
  spentOn: string;
  notes: string | null;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Send this back as the expected version when editing, deleting or restoring. */
  version: number;
  deleted: boolean;
  deletedAt: string | null;
  /** How the cost was split. */
  splitMethod: SplitMethod;
  payers: ExpensePayer[];
  /** What each participant owes, as DERIVED AND STORED by the database, with the value that was typed for them (null for an equal split). */
  shares: { memberId: string; shareMinor: number; inputValue: number | null }[];
}

export interface ExpenseCategory {
  id: string;
  key: string;
  name: string;
  icon: string;
}

const byMember = <T extends { memberId: string }>(a: T, b: T) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);

/**
 * Joins expenses with their payer and share rows. Returns null when the three reads do not agree (an expense without payers or shares,
 * or amounts that do not add up), which can happen only if a change landed between the reads: the caller should read again.
 */
export function expensesFromRows(expenses: readonly ExpenseRowRecord[], payers: readonly PayerRowRecord[], shares: readonly ShareRowRecord[]): StoredExpense[] | null {
  const payersBy = new Map<string, ExpensePayer[]>();
  for (const p of payers) (payersBy.get(p.expense_id) ?? payersBy.set(p.expense_id, []).get(p.expense_id)!).push({ memberId: p.trip_member_id, paidMinor: p.paid_minor });
  const sharesBy = new Map<string, { memberId: string; shareMinor: number; inputValue: number | null }[]>();
  for (const s of shares) (sharesBy.get(s.expense_id) ?? sharesBy.set(s.expense_id, []).get(s.expense_id)!).push({ memberId: s.trip_member_id, shareMinor: s.share_minor, inputValue: s.input_value === null || s.input_value === undefined ? null : Number(s.input_value) });

  const result: StoredExpense[] = [];
  for (const e of expenses) {
    const ps = (payersBy.get(e.id) ?? []).sort(byMember);
    const ss = (sharesBy.get(e.id) ?? []).sort(byMember);
    if (ps.length === 0 || ss.length === 0 || !isSplitMethod(e.split_method)) return null;
    if (e.split_method !== 'equal' && ss.some((x) => x.inputValue === null || !Number.isSafeInteger(x.inputValue))) return null;
    if (ps.reduce((a, p) => a + p.paidMinor, 0) !== e.amount_minor || ss.reduce((a, s) => a + s.shareMinor, 0) !== e.amount_minor) return null;
    result.push({
      id: e.id,
      tripId: e.trip_id,
      title: e.title,
      amountMinor: e.amount_minor,
      categoryId: e.category_id,
      spentOn: e.spent_on,
      notes: e.notes,
      createdBy: e.created_by,
      updatedBy: e.updated_by,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      version: e.version,
      deleted: e.deleted_at !== null,
      deletedAt: e.deleted_at,
      splitMethod: e.split_method,
      payers: ps,
      shares: ss,
    });
  }
  return result;
}

export const categoryFromRow = (r: CategoryRowRecord): ExpenseCategory => ({ id: r.id, key: r.key, name: r.name, icon: r.icon });

/** The key to send for an expense's category (an edit sends the key), or null. */
export function categoryKeyOf(categories: readonly ExpenseCategory[], categoryId: string | null): string | null {
  return categoryId === null ? null : (categories.find((c) => c.id === categoryId)?.key ?? null);
}

/** Turns a stored expense back into a draft, for an edit form. Only members who are still active can stay selected (the database refuses former members). */
export function draftFromExpense(e: StoredExpense, categories: readonly ExpenseCategory[], activeMemberIds: readonly string[]): ExpenseDraft {
  const active = new Set(activeMemberIds);
  return {
    title: e.title,
    amountMinor: e.amountMinor,
    spentOn: e.spentOn,
    categoryKey: categoryKeyOf(categories, e.categoryId),
    notes: e.notes,
    participants: e.shares.map((s) => s.memberId).filter((id) => active.has(id)),
    payers: e.payers.filter((p) => active.has(p.memberId)),
    splitMethod: e.splitMethod,
    splitInputs: e.splitMethod === 'equal' ? [] : e.shares.filter((s) => active.has(s.memberId) && s.inputValue !== null).map((s) => ({ memberId: s.memberId, value: s.inputValue! })),
  };
}

// ---- balances ----
/** One row of trip_member_balances(): what a member paid, owes and nets (paise). Former members are included. */
export interface BalanceRowRecord {
  member_id: string;
  paid_minor: number;
  share_minor: number;
  net_minor: number;
}
export interface TripBalanceLine {
  memberId: string;
  paidMinor: number;
  shareMinor: number;
  /** paid - owed. Positive: should receive money. Negative: owes money. Zero: settled. */
  netMinor: number;
}
export const balanceLineFromRow = (r: BalanceRowRecord): TripBalanceLine => ({ memberId: r.member_id, paidMinor: r.paid_minor, shareMinor: r.share_minor, netMinor: r.net_minor });
export const isSettled = (line: TripBalanceLine): boolean => line.netMinor === 0;
