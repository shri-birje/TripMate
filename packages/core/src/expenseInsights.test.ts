import { describe, expect, it } from 'vitest';
import { formatTenthsOfPercent, summarizeByCategory, tenthsOfPercent, UNCATEGORIZED_KEY } from './expenseInsights';
import { expenseTotals } from './expenseView';

const cats = [
  { id: 'c-trans', key: 'transportation', name: 'Transportation', icon: 'bus' },
  { id: 'c-food', key: 'food', name: 'Food', icon: 'utensils' },
  { id: 'c-other', key: 'other', name: 'Other', icon: 'dots' },
];
const x = (categoryId: string | null, amountMinor: number, deleted = false) => ({ categoryId, amountMinor, deleted });

describe('summarizeByCategory', () => {
  it('empty data gives no categories and zero totals, without dividing by zero', () => {
    expect(summarizeByCategory([], cats)).toEqual({ totalMinor: 0, expenseCount: 0, categories: [] });
  });

  it('one category holds 100%', () => {
    const r = summarizeByCategory([x('c-food', 1500), x('c-food', 500)], cats);
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0]).toMatchObject({ key: 'food', totalMinor: 2000, count: 2, tenthsOfPercent: 1000 });
  });

  it('several categories, biggest first, adding up to the trip total', () => {
    const list = [x('c-trans', 30000), x('c-food', 50000), x('c-other', 20000), x('c-food', 10000)];
    const r = summarizeByCategory(list, cats);
    expect(r.categories.map((c) => c.key)).toEqual(['food', 'transportation', 'other']);
    expect(r.categories.map((c) => c.totalMinor)).toEqual([60000, 30000, 20000]);
    expect(r.categories.reduce((a, c) => a + c.totalMinor, 0)).toBe(r.totalMinor);
    expect(r.totalMinor).toBe(110000);
    expect(r.expenseCount).toBe(4);
  });

  it('the sum of the categories equals the existing trip total', () => {
    const list = [x('c-trans', 12345), x(null, 99), x('c-food', 1), x('c-other', 7)];
    const asExpenses = list.map((e) => ({ ...e })) as never;
    expect(summarizeByCategory(list, cats).totalMinor).toBe(expenseTotals(asExpenses).totalMinor);
  });

  it('deleted expenses are excluded from totals, counts and categories', () => {
    const r = summarizeByCategory([x('c-food', 1000), x('c-trans', 9999, true)], cats);
    expect(r.totalMinor).toBe(1000);
    expect(r.expenseCount).toBe(1);
    expect(r.categories.map((c) => c.key)).toEqual(['food']);
  });

  it('uncategorized is its own bucket and stays distinct from a real Other category', () => {
    const r = summarizeByCategory([x(null, 400), x('c-other', 600)], cats);
    const keys = r.categories.map((c) => c.key);
    expect(keys).toContain(UNCATEGORIZED_KEY);
    expect(keys).toContain('other');
    expect(r.categories.find((c) => c.key === UNCATEGORIZED_KEY)).toMatchObject({ name: 'Uncategorized', totalMinor: 400 });
    expect(r.categories.find((c) => c.key === 'other')).toMatchObject({ name: 'Other', totalMinor: 600 });
  });

  it('a category id that is not in the list is counted as uncategorized, never dropped', () => {
    const r = summarizeByCategory([x('missing', 700)], cats);
    expect(r.totalMinor).toBe(700);
    expect(r.categories[0]!.key).toBe(UNCATEGORIZED_KEY);
  });

  it('each expense is counted once, however many people paid or shared it (the input has one amount per expense)', () => {
    // an expense paid by three people and split five ways is still ONE amount of 9,000 paise
    const r = summarizeByCategory([{ categoryId: 'c-food', amountMinor: 9000, deleted: false }], cats);
    expect(r.totalMinor).toBe(9000);
    expect(r.categories[0]!.count).toBe(1);
  });

  it('changing an expense category moves its amount between categories and keeps the total', () => {
    const before = summarizeByCategory([x('c-food', 5000), x('c-trans', 1000)], cats);
    const after = summarizeByCategory([x('c-trans', 5000), x('c-trans', 1000)], cats);
    expect(before.totalMinor).toBe(after.totalMinor);
    expect(after.categories).toHaveLength(1);
    expect(after.categories[0]).toMatchObject({ key: 'transportation', totalMinor: 6000 });
  });

  it('a category keeps the same colour index whatever its size', () => {
    const a = summarizeByCategory([x('c-food', 1), x('c-trans', 100)], cats);
    const b = summarizeByCategory([x('c-food', 100), x('c-trans', 1)], cats);
    expect(a.categories.find((c) => c.key === 'food')!.colorIndex).toBe(b.categories.find((c) => c.key === 'food')!.colorIndex);
  });

  it('very small spending still gets a share and the shares add up exactly', () => {
    const r = summarizeByCategory([x('c-food', 1), x('c-trans', 99999)], cats);
    expect(r.categories.reduce((a, c) => a + c.tenthsOfPercent, 0)).toBe(1000);
  });

  it('refuses to add beyond exact whole numbers', () => {
    expect(() => summarizeByCategory([x('c-food', Number.MAX_SAFE_INTEGER), x('c-food', 1)], cats)).toThrow();
  });
});

describe('a full trip (2,000 expenses, as read across several pages)', () => {
  it('the category totals add up to the active expense total, deleted ones are left out, and the shares are exactly 100%', () => {
    const list = Array.from({ length: 2000 }, (_, i) => x(i % 9 === 0 ? null : cats[i % 3]!.id, 100 + (i % 17) * 7, i % 10 === 0));
    const r = summarizeByCategory(list, cats);
    const active = list.filter((e) => !e.deleted);
    expect(r.expenseCount).toBe(active.length);
    expect(r.totalMinor).toBe(active.reduce((a, e) => a + e.amountMinor, 0));
    expect(r.categories.reduce((a, c) => a + c.totalMinor, 0)).toBe(r.totalMinor);
    expect(r.categories.reduce((a, c) => a + c.count, 0)).toBe(active.length);
    expect(r.categories.reduce((a, c) => a + c.tenthsOfPercent, 0)).toBe(1000);
  });
});

describe('tenthsOfPercent', () => {
  it('thirds add up to exactly 100%', () => {
    const t = tenthsOfPercent([1, 1, 1]);
    expect(t.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(t).toEqual([334, 333, 333]);
  });
  it('is all zeros when there is no spending', () => {
    expect(tenthsOfPercent([0, 0])).toEqual([0, 0]);
    expect(tenthsOfPercent([])).toEqual([]);
  });
  it('exact halves', () => {
    expect(tenthsOfPercent([50, 50])).toEqual([500, 500]);
  });
});

describe('formatTenthsOfPercent', () => {
  it('shows whole percentages without a decimal and others with one', () => {
    expect(formatTenthsOfPercent(1000)).toBe('100%');
    expect(formatTenthsOfPercent(375)).toBe('37.5%');
    expect(formatTenthsOfPercent(0)).toBe('0%');
    expect(formatTenthsOfPercent(5)).toBe('0.5%');
  });
});
