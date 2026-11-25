import { isSplitMethod, type ExpensePayer, type SplitMethod } from './expense';
import { bpToPercentText } from './expenseView';

/**
 * Expense history: what the database recorded each time an expense was added, edited, deleted or restored (M5, Checkpoint 5).
 *
 * WHAT IS IN A REVISION (privacy): the database stores, for each change, the expense as it was after the change (title, amount, day,
 * category, notes, split method, who paid how much, who owes how much, the typed split values) and the member id of the person who made
 * the change. It stores NO user id, email or name: names are looked up here from the trip's members, so a deleted account never leaves
 * personal data behind in history. Only active members of the trip can read it, and nobody can change or delete a revision.
 *
 * Nothing here calculates money: amounts are shown exactly as the database recorded them.
 */

export type RevisionAction = 'create' | 'update' | 'delete' | 'restore';

export interface ExpenseSnapshot {
  title: string;
  amountMinor: number;
  spentOn: string;
  categoryKey: string | null;
  notes: string | null;
  splitMethod: SplitMethod;
  payers: ExpensePayer[];
  shares: { memberId: string; shareMinor: number; inputValue: number | null }[];
  deleted: boolean;
}

export interface RevisionRowRecord {
  version: number;
  action: string;
  snapshot: unknown;
  changed_by: string;
  changed_at: string;
}

export interface ExpenseRevision {
  version: number;
  action: RevisionAction;
  /** The member (not the account) who made the change. */
  changedBy: string;
  changedAt: string;
  /** The expense as it was after this change, or null if the record could not be read. */
  snapshot: ExpenseSnapshot | null;
}

const ACTIONS: readonly string[] = ['create', 'update', 'delete', 'restore'];
const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/** Reads a stored snapshot strictly; anything unexpected gives null (the entry is then shown without details, never guessed at). */
export function snapshotFromJson(value: unknown): ExpenseSnapshot | null {
  const v = rec(value);
  if (!v) return null;
  if (typeof v.title !== 'string' || !int(v.amount_minor) || typeof v.spent_on !== 'string' || !isSplitMethod(v.split_method)) return null;
  if (!(v.category_key === null || typeof v.category_key === 'string') || !(v.notes === null || typeof v.notes === 'string')) return null;
  if (!Array.isArray(v.payers) || !Array.isArray(v.splits)) return null;
  const payers: ExpensePayer[] = [];
  for (const p of v.payers) {
    const r = rec(p);
    if (!r || typeof r.member_id !== 'string' || !int(r.paid_minor)) return null;
    payers.push({ memberId: r.member_id, paidMinor: r.paid_minor });
  }
  const shares: ExpenseSnapshot['shares'] = [];
  for (const sp of v.splits) {
    const r = rec(sp);
    if (!r || typeof r.member_id !== 'string' || !int(r.share_minor)) return null;
    if (r.input_value !== undefined && r.input_value !== null && !int(r.input_value)) return null;
    shares.push({ memberId: r.member_id, shareMinor: r.share_minor, inputValue: typeof r.input_value === 'number' ? r.input_value : null });
  }
  return {
    title: v.title, amountMinor: v.amount_minor, spentOn: v.spent_on, categoryKey: v.category_key, notes: v.notes, splitMethod: v.split_method,
    payers, shares, deleted: v.deleted === true,
  };
}

/** The revisions of one expense, oldest first. A row with an unknown action is dropped (it cannot happen: the database only allows four). */
export function revisionsFromRows(rows: readonly RevisionRowRecord[]): ExpenseRevision[] {
  return rows
    .filter((r) => ACTIONS.includes(r.action) && int(r.version) && typeof r.changed_by === 'string')
    .map((r) => ({ version: r.version, action: r.action as RevisionAction, changedBy: r.changed_by, changedAt: r.changed_at, snapshot: snapshotFromJson(r.snapshot) }))
    .sort((a, b) => a.version - b.version);
}

export const splitMethodLabel = (m: SplitMethod): string => (m === 'equal' ? 'Equally' : m === 'exact' ? 'Exact amounts' : m === 'percentage' ? 'Percentages' : 'Shares');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "23 Nov 2026, 10:15 am" in the viewer's own time zone; "an unknown time" if the moment is unreadable. */
export function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an unknown time';
  const hours = d.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hour12}:${String(d.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`;
}

export interface HistoryFormatters {
  money(minor: number): string;
  /** A member id as a name (and "(left)" for someone who left). */
  person(memberId: string): string;
  /** A category key as its name; null as "None". */
  category(key: string | null): string;
  /** An ISO day as "28 Dec 2026". */
  day(iso: string): string;
}

export interface ChangeLine {
  label: string;
  before: string;
  after: string;
}

const MAX_NAMED = 4;
const sortByMember = <T extends { memberId: string }>(xs: readonly T[]) => [...xs].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
const clip = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const listed = (parts: string[]) => (parts.length <= MAX_NAMED ? parts.join(', ') : `${parts.slice(0, MAX_NAMED).join(', ')} and ${parts.length - MAX_NAMED} more`);

/** "Asha ₹500, Ravi ₹400". */
export function describePayers(s: ExpenseSnapshot, f: HistoryFormatters): string {
  return listed(sortByMember(s.payers).map((p) => `${f.person(p.memberId)} ${f.money(p.paidMinor)}`));
}

/** "Asha 50% (₹500), Ravi 30% (₹300)": each person with what was typed for them (when anything was) and what they owe. */
export function describeShares(s: ExpenseSnapshot, f: HistoryFormatters): string {
  const typed = (v: number | null) => (v === null ? '' : s.splitMethod === 'percentage' ? ` ${bpToPercentText(v)}%` : s.splitMethod === 'shares' ? ` ${v} ${v === 1 ? 'share' : 'shares'}` : '');
  return listed(sortByMember(s.shares).map((x) => `${f.person(x.memberId)}${typed(x.inputValue)} (${f.money(x.shareMinor)})`));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What is different between two versions of an expense, in plain words (before and after). Empty when nothing a person would care about changed. */
export function changeLines(before: ExpenseSnapshot, after: ExpenseSnapshot, f: HistoryFormatters): ChangeLine[] {
  const lines: ChangeLine[] = [];
  if (before.title !== after.title) lines.push({ label: 'Name', before: before.title, after: after.title });
  if (before.amountMinor !== after.amountMinor) lines.push({ label: 'Amount', before: f.money(before.amountMinor), after: f.money(after.amountMinor) });
  if (before.spentOn !== after.spentOn) lines.push({ label: 'Day', before: f.day(before.spentOn), after: f.day(after.spentOn) });
  if (before.categoryKey !== after.categoryKey) lines.push({ label: 'Category', before: f.category(before.categoryKey), after: f.category(after.categoryKey) });
  if (before.notes !== after.notes) lines.push({ label: 'Notes', before: before.notes === null ? 'None' : clip(before.notes), after: after.notes === null ? 'None' : clip(after.notes) });
  if (!same(sortByMember(before.payers), sortByMember(after.payers))) lines.push({ label: 'Who paid', before: describePayers(before, f), after: describePayers(after, f) });
  if (before.splitMethod !== after.splitMethod) lines.push({ label: 'Split method', before: splitMethodLabel(before.splitMethod), after: splitMethodLabel(after.splitMethod) });
  if (!same(sortByMember(before.shares), sortByMember(after.shares))) lines.push({ label: 'How it was split', before: describeShares(before, f), after: describeShares(after, f) });
  return lines;
}

export interface HistoryEntry {
  version: number;
  action: RevisionAction;
  /** "Added", "Edited", "Deleted" or "Restored". */
  headline: string;
  /** The member's name (never an account id or email). */
  who: string;
  when: string;
  /** For an edit: what changed, with the previous value. */
  lines: ChangeLine[];
  /** For an addition: a one-line summary of what was added. */
  summary: string | null;
}

const HEADLINE: Record<RevisionAction, string> = { create: 'Added', update: 'Edited', delete: 'Deleted', restore: 'Restored' };

/** The history as people read it: newest first, each edit compared with the version before it. */
export function historyEntries(revisions: readonly ExpenseRevision[], f: HistoryFormatters): HistoryEntry[] {
  const ordered = [...revisions].sort((a, b) => a.version - b.version);
  const entries = ordered.map((r, i): HistoryEntry => {
    const prev = i > 0 ? ordered[i - 1]!.snapshot : null;
    const lines = r.action === 'update' && prev && r.snapshot ? changeLines(prev, r.snapshot, f) : [];
    const summary =
      r.action === 'create' && r.snapshot ? `${f.money(r.snapshot.amountMinor)} · ${f.category(r.snapshot.categoryKey)} · ${f.day(r.snapshot.spentOn)} · ${splitMethodLabel(r.snapshot.splitMethod).toLowerCase()}` : null;
    return { version: r.version, action: r.action, headline: HEADLINE[r.action], who: f.person(r.changedBy), when: whenLabel(r.changedAt), lines, summary };
  });
  return entries.reverse();
}
