import {
  balanceLineFromRow,
  categoryFromRow,
  createExpenseRpcArgs,
  deleteExpenseRpcArgs,
  expensesFromRows,
  isValidTripId,
  restoreExpenseRpcArgs,
  revisionsFromRows,
  tripBalancesRpcArgs,
  updateExpenseRpcArgs,
  validateExpenseDraft,
  type BalanceRowRecord,
  type CategoryRowRecord,
  type DraftContext,
  type ExpenseCategory,
  type ExpenseDraft,
  type ExpenseRevision,
  type ExpenseRowRecord,
  type PayerRowRecord,
  type RevisionRowRecord,
  type ShareRowRecord,
  type StoredExpense,
  type TripBalanceLine,
} from '@tripmate/core';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';

/**
 * Shared expenses: the app's service layer (M5, ADR-063).
 *
 * POSTGRESQL IS THE FINANCIAL SOURCE OF TRUTH.
 *   - Every write goes through ONE of four database functions (create_expense, update_expense, delete_expense, restore_expense).
 *     This file never writes to the expense, payer, share or history tables. The app has no right to.
 *   - The app sends only the participants and the payers: it never sends shares. The database derives and stores them
 *     (largest remainder, lowest member id first) and keeps every balance (trip_member_balances).
 *   - TypeScript here only shapes requests, gives early friendly checks, and reflects what the database says.
 *   - WHO may do what (active members create; an admin changes any expense; a member only their own; archived trips are read-only;
 *     former members can never be chosen) is decided by the database. These functions add friendly checks and messages: they
 *     are NOT the only line of defence.
 *
 * RETRIES AND STALE SCREENS
 *   - Creating: the caller makes ONE expense id when the form opens and sends the same id on every try. If a try fails with a
 *     connection problem the result is UNKNOWN (it may have been saved): trying again with the same id is safe, because the database
 *     answers "already saved" (created = false) for the same complete content and never makes a second expense.
 *   - Editing, deleting and restoring send the version the person was looking at. If someone else changed it first the database
 *     refuses ('conflict') and nothing changes; the hooks then re-read so the screen shows the truth.
 *
 * SECRECY: every message below is a fixed sentence. No raw database text, id or amount from an error is ever put into a message.
 * Nothing here logs anything.
 *
 * `ExpenseClient` describes only the slice of Supabase's client we use, so tests can supply a fake.
 */
interface PgError {
  code?: string | undefined;
  message?: string | undefined;
  details?: string | undefined;
}

type Reply<T> = PromiseLike<{ data: T | null; error: PgError | null }>;

interface ReadQuery<T> extends PromiseLike<{ data: T[] | null; error: PgError | null; count?: number | null }> {
  eq(column: string, value: string): ReadQuery<T>;
  order(column: string, options?: { ascending?: boolean }): ReadQuery<T>;
  /** Rows `from` to `to`, both included (zero based). */
  range(from: number, to: number): ReadQuery<T>;
}

interface SelectOptions {
  count?: 'exact';
}

export type ExpenseFunction = 'create_expense' | 'update_expense' | 'delete_expense' | 'restore_expense' | 'trip_member_balances';

export interface ExpenseClient {
  rpc(fn: ExpenseFunction, args: Record<string, unknown>): Reply<unknown>;
  from(table: 'expenses'): { select(columns: string, options?: SelectOptions): ReadQuery<ExpenseRowRecord> };
  from(table: 'expense_payers'): { select(columns: string, options?: SelectOptions): ReadQuery<PayerRowRecord> };
  from(table: 'expense_splits'): { select(columns: string, options?: SelectOptions): ReadQuery<ShareRowRecord> };
  from(table: 'categories'): { select(columns: string): ReadQuery<CategoryRowRecord> };
  from(table: 'expense_revisions'): { select(columns: string): ReadQuery<RevisionRowRecord> };
}

/** Exactly what is asked of each table. No "*": a column added later can never reach a screen by accident. */
export const EXPENSE_COLUMNS = 'id, trip_id, title, amount_minor, category_id, spent_on, notes, split_method, created_by, updated_by, created_at, updated_at, version, deleted_at, deleted_by';
export const PAYER_COLUMNS = 'expense_id, trip_member_id, paid_minor';
export const SHARE_COLUMNS = 'expense_id, trip_member_id, share_minor, input_value';
export const CATEGORY_COLUMNS = 'id, key, name, icon, sort_order';
/** History: the member who made each change (a member id, never an account) and what the expense looked like after it. */
export const REVISION_COLUMNS = 'version, action, snapshot, changed_by, changed_at';

export type ExpenseErrorKind =
  | 'invalid' // the details are not acceptable (checked here first, and by the database)
  | 'amounts' // what was paid does not add up to the total
  | 'split_total' // the typed split (amounts or percentages) does not add up
  | 'split_value' // a typed split value is not acceptable (zero shares, a percentage out of range, ...)
  | 'outside_dates' // the day is outside the trip's dates
  | 'participant_inactive' // someone chosen to share has left the trip
  | 'payer_inactive' // someone who paid has left the trip
  | 'category' // unknown category
  | 'too_many' // the trip is at its limit of expenses
  | 'conflict' // someone else changed it first (stale version)
  | 'taken' // this expense id belongs to a DIFFERENT expense: start a new one
  | 'deleted' // the expense is deleted: restore it first
  | 'not_found' // the expense is gone
  | 'not_allowed' // not an admin and not the person who added it
  | 'archived' // the trip is archived (read-only until restored)
  | 'former_member' // the change would leave someone who left the trip with a balance (rule I-1)
  | 'unavailable' // not on the trip / no such trip: the single combined answer
  | 'auth' // sign in again
  | 'network' // connection problem: the result of a write is UNKNOWN, retrying is safe
  | 'setup' // the database update has not been applied
  | 'unknown';

export const EXPENSE_MESSAGES: Record<ExpenseErrorKind, string> = {
  invalid: 'Please check the expense details and try again.',
  amounts: 'What was paid has to add up to the total.',
  split_total: 'The split does not add up: amounts must add up to the total and percentages to 100%.',
  split_value: 'Check the numbers typed for each person: percentages from 0.01 to 100, shares as whole numbers from 1, amounts zero or more.',
  outside_dates: "The day has to fall within the trip's dates.",
  participant_inactive: 'Someone you chose to share this has left the trip. Choose only people who are still on it.',
  payer_inactive: 'Someone you listed as a payer has left the trip. Choose only people who are still on it.',
  category: 'Pick a category from the list.',
  too_many: 'This trip already has the most expenses it can hold.',
  conflict: 'Someone else changed this expense. Reload to see the latest, then try again.',
  taken: 'This expense could not be saved because its id is already used by a different expense. Start a new expense.',
  deleted: 'This expense was deleted. Restore it first if you want to change it.',
  not_found: 'That expense is no longer there. Reload to see the latest.',
  not_allowed: 'Only a trip admin or the person who added an expense can change it.',
  archived: 'This trip is archived. Restore it to change expenses.',
  former_member: 'This change would leave someone who has left the trip with an unsettled balance. Expenses involving them can only change if their balance stays at zero.',
  unavailable: UNAVAILABLE_MESSAGE,
  auth: 'Please sign in again to continue.',
  network: "Can't reach the server. Check your internet connection and try again.",
  setup: "Expenses aren't set up on the server yet. The database update for expenses still needs to be applied.",
  unknown: 'Something went wrong. Please try again.',
};

export class ExpenseError extends Error {
  constructor(
    public readonly kind: ExpenseErrorKind,
    message: string,
    /** For 'former_member' only: the balance (paise, signed) the change would have left, when the database said so. */
    public readonly netMinor: number | null = null,
  ) {
    super(message);
    this.name = 'ExpenseError';
  }
  /** True when a WRITE may have been saved although it failed (a connection problem or an unknown failure): re-reading shows the truth. */
  get outcomeUnknown(): boolean {
    return this.kind === 'network' || this.kind === 'unknown';
  }
}

const E = (kind: ExpenseErrorKind, netMinor: number | null = null) => new ExpenseError(kind, EXPENSE_MESSAGES[kind], netMinor);

/** The database's own words first (exact), then generic codes. Only fixed sentences are ever used; raw text is never passed on. */
function toError(error: PgError): ExpenseError {
  const code = error.code ?? '';
  const text = error.message ?? '';
  if (text.includes('trip_not_found')) return E('unavailable');
  if (text.includes('trip_archived')) return E('archived');
  if (text.includes('not_allowed')) return E('not_allowed');
  if (text.includes('expense_not_found')) return E('not_found');
  if (text.includes('version_conflict')) return E('conflict');
  if (text.includes('expense_deleted')) return E('deleted');
  if (text.includes('expense_id_taken')) return E('taken');
  if (text.includes('former_member_balance')) {
    const m = /net_minor=(-?\d{1,16})/.exec(error.details ?? '');
    return E('former_member', m ? Number(m[1]) : null);
  }
  if (text.includes('participant_not_active')) return E('participant_inactive');
  if (text.includes('payer_not_active')) return E('payer_inactive');
  if (text.includes('outside_trip_dates')) return E('outside_dates');
  if (text.includes('category_not_found')) return E('category');
  if (text.includes('too_many_expenses')) return E('too_many');
  if (text.includes('split_total_mismatch')) return E('split_total');
  if (text.includes('invalid_split_value')) return E('split_value');
  if (text.includes('payers_total_mismatch') || text.includes('shares_total_mismatch')) return E('amounts');
  if (text.includes('invalid_expense') || text.includes('shares_not_equal_split') || text.includes('split_not_derived') || ['23514', '22P02', '22003'].includes(code)) return E('invalid');
  if (code === '28000' || text.includes('not_authenticated') || code === '42501') return E('auth');
  if (['PGRST202', '42883', 'PGRST205', '42P01'].includes(code)) return E('setup');
  if (/failed to fetch|network request failed|load failed|networkerror/i.test(text)) return E('network');
  return E('unknown');
}

async function rpc(client: ExpenseClient, fn: ExpenseFunction, args: Record<string, unknown>): Promise<unknown[]> {
  let reply: Awaited<ReturnType<ExpenseClient['rpc']>>;
  try {
    reply = await client.rpc(fn, args);
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' });
  }
  if (reply.error) throw toError(reply.error);
  if (reply.data === null || reply.data === undefined) return [];
  return Array.isArray(reply.data) ? reply.data : [reply.data];
}

async function read<T>(query: ReadQuery<T>): Promise<T[]> {
  let reply: Awaited<typeof query>;
  try {
    reply = await query;
  } catch (e) {
    throw toError({ message: e instanceof Error ? e.message : '' });
  }
  if (reply.error) throw toError(reply.error);
  return reply.data ?? [];
}

/** How many rows are asked for per request. Supabase caps one response (1,000 rows by default), so a trip is read in pages of this size. */
export const EXPENSE_PAGE_SIZE = 1000;

/** Raised inside a paged read when the data moved while the pages were being read; the whole read is simply started again. */
class MovedWhileReading extends Error {}

/**
 * Reads EVERY row of a query, page by page, and proves it did:
 *  - every request asks the database for the exact total (`count`), and the total must be the same on every page (if it moves,
 *    something was added or removed meanwhile, so the read starts again);
 *  - paging stops only when the rows collected equal that total, never because a page "looked short" (so a server that caps a response
 *    below the page size cannot make the read stop early);
 *  - a row seen twice (the data shifted under the pages) or an empty page before the total is reached starts the read again;
 *  - a failed page fails the whole read. Rows from earlier pages are never returned as if they were the full list.
 * The query must have a unique, stable ORDER so pages never overlap or leave gaps.
 */
async function readAllPages<T>(page: (from: number, to: number) => ReadQuery<T>, keyOf: (row: T) => string): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let total: number | null = null;
  for (;;) {
    let reply: Awaited<ReturnType<typeof page>>;
    try {
      reply = await page(rows.length, rows.length + EXPENSE_PAGE_SIZE - 1);
    } catch (e) {
      throw toError({ message: e instanceof Error ? e.message : '' });
    }
    if (reply.error) throw toError(reply.error);
    const count = reply.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw E('unknown'); // cannot prove completeness
    if (total === null) total = count;
    else if (count !== total) throw new MovedWhileReading();
    const data = reply.data ?? [];
    for (const row of data) {
      const key = keyOf(row);
      if (seen.has(key)) throw new MovedWhileReading();
      seen.add(key);
      rows.push(row);
    }
    if (rows.length === total) return rows;
    if (rows.length > total || data.length === 0) throw new MovedWhileReading();
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null);
const badTrip = () => E('unavailable');
const badId = () => E('not_found');
const validVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

function cleanDraft(draft: ExpenseDraft, ctx: DraftContext | undefined) {
  const checked = validateExpenseDraft(draft, ctx);
  if (!checked.ok) throw new ExpenseError('invalid', checked.message); // a specific, friendly sentence from the shared rules
  return checked.value;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------------------------------
export interface CreateExpenseVars {
  tripId: string;
  /** ONE id per new expense, made when the form opens and reused on every retry. */
  expenseId: string;
  draft: ExpenseDraft;
  /** Optional friendly pre-checks (trip dates, current members); the database checks again. */
  context?: DraftContext;
}

export interface CreatedExpense {
  expenseId: string;
  version: number;
  /** false = this exact expense was already saved by an earlier try: nothing new was made. */
  created: boolean;
}

/** Records a shared, equally split expense. Safe to retry with the same expense id. */
export async function createExpense(client: ExpenseClient, vars: CreateExpenseVars): Promise<CreatedExpense> {
  if (!isValidTripId(vars.tripId)) throw badTrip();
  if (!isValidTripId(vars.expenseId)) throw new ExpenseError('invalid', EXPENSE_MESSAGES.invalid);
  const clean = cleanDraft(vars.draft, vars.context);
  const row = asRecord((await rpc(client, 'create_expense', createExpenseRpcArgs(vars.tripId, vars.expenseId.toLowerCase(), clean)))[0]);
  if (!row || typeof row.expense_id !== 'string' || !validVersion(row.version) || typeof row.created !== 'boolean') throw E('unknown');
  return { expenseId: row.expense_id, version: row.version, created: row.created };
}

export interface UpdateExpenseVars {
  tripId: string;
  expenseId: string;
  /** The version the person was looking at. */
  expectedVersion: number;
  draft: ExpenseDraft;
  context?: DraftContext;
}

export interface ChangedExpense {
  expenseId: string;
  /** The version after the change (unchanged when nothing really changed). */
  version: number;
  changed: boolean;
}

function changedFrom(rowValue: unknown): ChangedExpense {
  const row = asRecord(rowValue);
  if (!row || typeof row.expense_id !== 'string' || !validVersion(row.version) || typeof row.changed !== 'boolean') throw E('unknown');
  return { expenseId: row.expense_id, version: row.version, changed: row.changed };
}

/** Replaces an expense's details, payers and participants. A stale version changes nothing ('conflict'). */
export async function updateExpense(client: ExpenseClient, vars: UpdateExpenseVars): Promise<ChangedExpense> {
  if (!isValidTripId(vars.tripId)) throw badTrip();
  if (!isValidTripId(vars.expenseId)) throw badId();
  if (!validVersion(vars.expectedVersion)) throw E('invalid');
  const clean = cleanDraft(vars.draft, vars.context);
  return changedFrom((await rpc(client, 'update_expense', updateExpenseRpcArgs(vars.tripId, vars.expenseId.toLowerCase(), vars.expectedVersion, clean)))[0]);
}

export interface ExpenseRef {
  tripId: string;
  expenseId: string;
  expectedVersion: number;
}

function checkRef(ref: ExpenseRef) {
  if (!isValidTripId(ref.tripId)) throw badTrip();
  if (!isValidTripId(ref.expenseId)) throw badId();
  if (!validVersion(ref.expectedVersion)) throw E('invalid');
}

/** Soft delete: the expense and its history stay, and balances stop counting it. Repeating it is safe. */
export async function deleteExpense(client: ExpenseClient, ref: ExpenseRef): Promise<ChangedExpense> {
  checkRef(ref);
  return changedFrom((await rpc(client, 'delete_expense', deleteExpenseRpcArgs(ref.tripId, ref.expenseId.toLowerCase(), ref.expectedVersion)))[0]);
}

/** Undo a delete. The trip's current dates and the former-member rule are re-checked by the database. */
export async function restoreExpense(client: ExpenseClient, ref: ExpenseRef): Promise<ChangedExpense> {
  checkRef(ref);
  return changedFrom((await rpc(client, 'restore_expense', restoreExpenseRpcArgs(ref.tripId, ref.expenseId.toLowerCase(), ref.expectedVersion)))[0]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads (direct under row-level security: only ACTIVE members of the trip see anything) and balances
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Every expense of the trip (deleted ones included, flagged, so they can be restored), newest day first, each with its payers and
 * the shares the database stored. Three reads are joined; if they disagree (a change landed between them) it reads once more.
 */
export async function listExpenses(client: ExpenseClient, tripId: string): Promise<StoredExpense[]> {
  if (!isValidTripId(tripId)) throw badTrip();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Each table is read in full, page by page, in a unique order (a trip holds up to 2,000 expenses and several payer and share rows each).
      const expenses = await readAllPages(
        (from, to) =>
          client.from('expenses').select(EXPENSE_COLUMNS, { count: 'exact' }).eq('trip_id', tripId)
            .order('spent_on', { ascending: false }).order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to),
        (r) => r.id,
      );
      const payers = await readAllPages(
        (from, to) => client.from('expense_payers').select(PAYER_COLUMNS, { count: 'exact' }).eq('trip_id', tripId).order('expense_id', { ascending: true }).order('trip_member_id', { ascending: true }).range(from, to),
        (r) => `${r.expense_id}/${r.trip_member_id}`,
      );
      const shares = await readAllPages(
        (from, to) => client.from('expense_splits').select(SHARE_COLUMNS, { count: 'exact' }).eq('trip_id', tripId).order('expense_id', { ascending: true }).order('trip_member_id', { ascending: true }).range(from, to),
        (r) => `${r.expense_id}/${r.trip_member_id}`,
      );
      // Every expense must have its payers and shares and the amounts must add up: if a change landed between the reads, this fails and we read again.
      const joined = expensesFromRows(expenses, payers, shares);
      if (joined) return joined;
    } catch (e) {
      if (!(e instanceof MovedWhileReading)) throw e;
    }
  }
  throw E('unknown'); // never a partial list
}

/** One expense of the trip, or a 'not_found' error (the same answer whether it never existed, belongs to another trip, or you may not see it). */
export async function getExpense(client: ExpenseClient, tripId: string, expenseId: string): Promise<StoredExpense> {
  if (!isValidTripId(tripId)) throw badTrip();
  if (!isValidTripId(expenseId)) throw badId();
  const found = (await listExpenses(client, tripId)).find((e) => e.id === expenseId.toLowerCase());
  if (!found) throw badId();
  return found;
}

/**
 * The history of one expense, oldest first: each time it was added, edited, deleted or restored, who did it (a member id; names are
 * looked up from the trip's members) and what the expense looked like afterwards. Only active members of the trip can read it (the
 * database decides), it holds no account id or email, and nothing here can change or delete a revision: the app has no such right.
 */
export async function getExpenseHistory(client: ExpenseClient, tripId: string, expenseId: string): Promise<ExpenseRevision[]> {
  if (!isValidTripId(tripId)) throw badTrip();
  if (!isValidTripId(expenseId)) throw badId();
  const rows = await read(client.from('expense_revisions').select(REVISION_COLUMNS).eq('trip_id', tripId).eq('expense_id', expenseId.toLowerCase()).order('version', { ascending: true }));
  return revisionsFromRows(rows);
}

/** The system categories (the same for every trip), in their display order. */
export async function listCategories(client: ExpenseClient): Promise<ExpenseCategory[]> {
  const rows = await read(client.from('categories').select(CATEGORY_COLUMNS).order('sort_order', { ascending: true }));
  return rows.map(categoryFromRow);
}

/** What every member (including former ones) paid, owes and nets, computed by the database from the ledger. */
export async function getTripBalances(client: ExpenseClient, tripId: string): Promise<TripBalanceLine[]> {
  if (!isValidTripId(tripId)) throw badTrip();
  const rows = await rpc(client, 'trip_member_balances', tripBalancesRpcArgs(tripId));
  return rows.map((r) => {
    const row = asRecord(r);
    if (!row || typeof row.member_id !== 'string' || ![row.paid_minor, row.share_minor, row.net_minor].every((n) => typeof n === 'number' && Number.isSafeInteger(n))) throw E('unknown');
    // M7: sent_minor and received_minor are optional (absent before migration #12) but, when present, must be whole safe numbers
    for (const extra of [row.sent_minor, row.received_minor]) if (extra !== undefined && !(typeof extra === 'number' && Number.isSafeInteger(extra))) throw E('unknown');
    return balanceLineFromRow(row as unknown as BalanceRowRecord);
  });
}
