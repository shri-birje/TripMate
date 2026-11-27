import { addMinor } from './money';

/**
 * Insights: a read-only, presentation-level summary of a trip's expenses by category. It only re-adds the amounts that are already
 * stored (each expense counted exactly once, whoever paid and however it was split), and never changes an expense, a split, a balance
 * or a settlement. Repayments and suggested payments are not expenses and never appear here.
 */

/** The bucket for expenses with no category. Kept apart from a real "Other" category. */
export const UNCATEGORIZED_KEY = 'uncategorized';
export const UNCATEGORIZED_NAME = 'Uncategorized';

export interface InsightCategoryInput {
  id: string;
  key: string;
  name: string;
  icon: string;
}

export interface InsightExpenseInput {
  categoryId: string | null;
  amountMinor: number;
  deleted: boolean;
}

export interface CategoryInsight {
  /** The category's own key, or `uncategorized`. */
  key: string;
  name: string;
  /** The category's icon name as stored (`bus`, `utensils`...), or `tag` for uncategorized. */
  icon: string;
  totalMinor: number;
  count: number;
  /** Share of the trip total in tenths of a percent (1000 = 100%). Whole numbers; across all categories they add up to exactly 1000 (or 0 when there is no spending). */
  tenthsOfPercent: number;
  /** A stable position for choosing a colour: the category's place in the category list, with uncategorized last. The same category always gets the same colour. */
  colorIndex: number;
}

export interface ExpenseInsights {
  totalMinor: number;
  expenseCount: number;
  /** Biggest first; categories with no expenses are left out. */
  categories: CategoryInsight[];
}

/** Splits 1000 tenths between the totals in proportion, so the whole numbers add up to exactly 1000 (largest remainder). Safe for zero. */
export function tenthsOfPercent(totals: readonly number[]): number[] {
  const sum = totals.reduce((a, b) => addMinor(a, b), 0);
  if (sum <= 0) return totals.map(() => 0);
  const whole = BigInt(sum);
  const parts = totals.map((t, i) => {
    const scaled = BigInt(Math.max(0, t)) * 1000n;
    return { i, floor: Number(scaled / whole), rem: scaled % whole };
  });
  let left = 1000 - parts.reduce((a, p) => a + p.floor, 0);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  const out = parts.map((p) => p.floor);
  for (const p of order) {
    if (left <= 0) break;
    out[p.i]! += 1;
    left -= 1;
  }
  return out;
}

export function summarizeByCategory(expenses: readonly InsightExpenseInput[], categories: readonly InsightCategoryInput[]): ExpenseInsights {
  const byId = new Map(categories.map((c, i) => [c.id, { c, index: i }] as const));
  const buckets = new Map<string, { key: string; name: string; icon: string; totalMinor: number; count: number; colorIndex: number }>();
  let totalMinor = 0;
  let expenseCount = 0;
  for (const e of expenses) {
    if (e.deleted) continue;
    const hit = e.categoryId === null ? undefined : byId.get(e.categoryId);
    const key = hit ? hit.c.key : UNCATEGORIZED_KEY;
    let b = buckets.get(key);
    if (!b) {
      b = hit
        ? { key, name: hit.c.name, icon: hit.c.icon, totalMinor: 0, count: 0, colorIndex: hit.index }
        : { key, name: UNCATEGORIZED_NAME, icon: 'tag', totalMinor: 0, count: 0, colorIndex: categories.length };
      buckets.set(key, b);
    }
    b.totalMinor = addMinor(b.totalMinor, e.amountMinor);
    b.count += 1;
    totalMinor = addMinor(totalMinor, e.amountMinor);
    expenseCount += 1;
  }
  const list = [...buckets.values()].sort((a, b) => b.totalMinor - a.totalMinor || a.colorIndex - b.colorIndex);
  const tenths = tenthsOfPercent(list.map((b) => b.totalMinor));
  return { totalMinor, expenseCount, categories: list.map((b, i) => ({ ...b, tenthsOfPercent: tenths[i]! })) };
}

/** "37.5%" or "40%" from tenths of a percent. */
export function formatTenthsOfPercent(tenths: number): string {
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return frac === 0 ? `${whole}%` : `${whole}.${frac}%`;
}
