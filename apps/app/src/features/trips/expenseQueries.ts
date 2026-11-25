import type { MutationOptions, QueryClient } from '@tanstack/react-query';
import type { ExpenseCategory, ExpenseRevision, StoredExpense, TripBalanceLine } from '@tripmate/core';
import {
  ExpenseError,
  createExpense,
  deleteExpense,
  getExpenseHistory,
  getTripBalances,
  listCategories,
  listExpenses,
  restoreExpense,
  updateExpense,
  type ChangedExpense,
  type CreateExpenseVars,
  type CreatedExpense,
  type ExpenseClient,
  type ExpenseRef,
  type UpdateExpenseVars,
} from './expenseService';

/**
 * The query and mutation OPTIONS behind the expense hooks (expenseApi.ts), kept free of React and of the real Supabase client so they
 * can be tested directly with a fake client.
 *
 * Cache keys include the signed-in user, so one person's expenses can never be served from the cache to another account on the same device.
 *
 * After EVERY write attempt, successful or not, the trip's expenses and balances are marked out of date and re-read, so a screen shows
 * what the database really holds: after a success the new state, after a refused attempt (someone changed it first, your rights
 * changed, the trip was archived) the current truth. Nothing is ever patched into the cache by guesswork, because the database,
 * not the app, decides every amount.
 */
export const expensesKey = (userId: string | null, tripId: string) => ['expenses', userId, tripId] as const;
export const balancesKey = (userId: string | null, tripId: string) => ['expense-balances', userId, tripId] as const;
export const categoriesKey = (userId: string | null) => ['expense-categories', userId] as const;
/** One expense's history; the key starts with the trip so every history of the trip can be refreshed at once. */
export const historyKey = (userId: string | null, tripId: string, expenseId: string) => ['expense-history', userId, tripId, expenseId] as const;

/** Retry a read once for a connection hiccup only. Retrying "not available" or a setup problem would not help. */
export const retryRead = (count: number, error: unknown) => error instanceof ExpenseError && error.kind === 'network' && count < 1;

export function expensesQueryOptions(client: ExpenseClient, userId: string | null, tripId: string) {
  return {
    queryKey: expensesKey(userId, tripId),
    queryFn: (): Promise<StoredExpense[]> => listExpenses(client, tripId),
    staleTime: 10_000,
    retry: retryRead,
  };
}

export function balancesQueryOptions(client: ExpenseClient, userId: string | null, tripId: string) {
  return {
    queryKey: balancesKey(userId, tripId),
    queryFn: (): Promise<TripBalanceLine[]> => getTripBalances(client, tripId),
    staleTime: 10_000,
    retry: retryRead,
  };
}

export function historyQueryOptions(client: ExpenseClient, userId: string | null, tripId: string, expenseId: string) {
  return {
    queryKey: historyKey(userId, tripId, expenseId),
    queryFn: (): Promise<ExpenseRevision[]> => getExpenseHistory(client, tripId, expenseId),
    staleTime: 10_000,
    retry: retryRead,
  };
}

export function categoriesQueryOptions(client: ExpenseClient, userId: string | null) {
  return {
    queryKey: categoriesKey(userId),
    queryFn: (): Promise<ExpenseCategory[]> => listCategories(client),
    staleTime: 60 * 60_000, // the system categories almost never change
    retry: retryRead,
  };
}

export interface ExpenseMutations {
  create: MutationOptions<CreatedExpense, ExpenseError, CreateExpenseVars>;
  update: MutationOptions<ChangedExpense, ExpenseError, UpdateExpenseVars>;
  remove: MutationOptions<ChangedExpense, ExpenseError, ExpenseRef>;
  restore: MutationOptions<ChangedExpense, ExpenseError, ExpenseRef>;
}

/** The trip is fixed by the hook (so one hook can never write to another trip); the caller supplies the rest. */
export function expenseMutations(client: ExpenseClient, queryClient: QueryClient, userId: string | null, tripId: string): ExpenseMutations {
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: expensesKey(userId, tripId) }),
      queryClient.invalidateQueries({ queryKey: balancesKey(userId, tripId) }),
      queryClient.invalidateQueries({ queryKey: ['expense-history', userId, tripId] }), // every expense's history of this trip
    ]);
  return {
    create: { mutationFn: (v) => createExpense(client, { ...v, tripId }), onSettled: refresh },
    update: { mutationFn: (v) => updateExpense(client, { ...v, tripId }), onSettled: refresh },
    remove: { mutationFn: (v) => deleteExpense(client, { ...v, tripId }), onSettled: refresh },
    restore: { mutationFn: (v) => restoreExpense(client, { ...v, tripId }), onSettled: refresh },
  };
}
