import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { balancesKey, expensesKey } from './expenseQueries';
import { memberChangeExpenseKeys } from './memberChangeKeys';

const USER = 'user-1';
const TRIP = 'trip-1';

describe('cache refresh after a member change', () => {
  it("covers this trip's expense list and balances", () => {
    expect(memberChangeExpenseKeys(USER, TRIP)).toEqual([expensesKey(USER, TRIP), balancesKey(USER, TRIP)]);
  });

  it('marks this trip\'s cached expenses and balances out of date, and leaves another trip and another person alone', async () => {
    const client = new QueryClient();
    const seed = (key: readonly unknown[]) => client.setQueryData(key, ['cached']);
    seed(expensesKey(USER, TRIP));
    seed(balancesKey(USER, TRIP));
    seed(expensesKey(USER, 'trip-2'));
    seed(balancesKey('user-2', TRIP));
    await Promise.all(memberChangeExpenseKeys(USER, TRIP).map((queryKey) => client.invalidateQueries({ queryKey, refetchType: 'none' })));
    const stale = (key: readonly unknown[]) => client.getQueryState(key)!.isInvalidated;
    expect(stale(expensesKey(USER, TRIP))).toBe(true);
    expect(stale(balancesKey(USER, TRIP))).toBe(true);
    expect(stale(expensesKey(USER, 'trip-2'))).toBe(false);
    expect(stale(balancesKey('user-2', TRIP))).toBe(false);
  });
});
