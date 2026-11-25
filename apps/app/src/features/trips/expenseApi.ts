import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExpenseCategory, ExpenseRevision, StoredExpense, TripBalanceLine } from '@tripmate/core';
import { supabase } from '../../lib/supabase';
import { useUserId } from '../auth/AuthProvider';
import type { ChangedExpense, CreateExpenseVars, CreatedExpense, ExpenseClient, ExpenseError, ExpenseRef, UpdateExpenseVars } from './expenseService';
import { balancesQueryOptions, categoriesQueryOptions, expenseMutations, expensesQueryOptions, historyQueryOptions } from './expenseQueries';

/**
 * React hooks over the expense service. All logic lives in expenseService.ts and expenseQueries.ts (tested without React); these only
 * attach the signed-in user and the real Supabase client.
 *
 * The single cast is the only place the real Supabase client meets the small `ExpenseClient` interface the service is written against.
 * The signed-in user scopes every query, and nothing is fetched until there is a user.
 *
 * Making an expense: create ONE id with `newExpenseId()` when the form opens (keep it in state) and send the same id on every try, so a
 * retry after a connection failure can never save the expense twice. A failed write whose `error.outcomeUnknown` is true may have
 * been saved; the lists are re-read automatically and trying again with the same id is safe.
 */
const client = supabase as unknown as ExpenseClient | null;

/** The trip's expenses (deleted ones flagged), newest day first, with payers and the shares the database stored. */
export function useExpenses(tripId: string) {
  const userId = useUserId();
  return useQuery<StoredExpense[], ExpenseError>({ ...expensesQueryOptions(client!, userId, tripId), enabled: userId !== null && client !== null });
}

/** One expense, read from the trip's list (so it is always consistent with it). `data` is undefined while loading and when it is not found. */
export function useExpense(tripId: string, expenseId: string | null) {
  const userId = useUserId();
  return useQuery<StoredExpense[], ExpenseError, StoredExpense | undefined>({
    ...expensesQueryOptions(client!, userId, tripId),
    enabled: userId !== null && client !== null && expenseId !== null,
    select: (all) => all.find((e) => e.id === expenseId?.toLowerCase()),
  });
}

/** One expense's history (who added, edited, deleted or restored it, and what changed). Nothing here can change a revision. */
export function useExpenseHistory(tripId: string, expenseId: string, enabled = true) {
  const userId = useUserId();
  return useQuery<ExpenseRevision[], ExpenseError>({ ...historyQueryOptions(client!, userId, tripId, expenseId), enabled: enabled && userId !== null && client !== null });
}

/** The system categories. */
export function useExpenseCategories() {
  const userId = useUserId();
  return useQuery<ExpenseCategory[], ExpenseError>({ ...categoriesQueryOptions(client!, userId), enabled: userId !== null && client !== null });
}

/** What every member paid, owes and nets, computed by the database. Former members are included. */
export function useTripBalances(tripId: string) {
  const userId = useUserId();
  return useQuery<TripBalanceLine[], ExpenseError>({ ...balancesQueryOptions(client!, userId, tripId), enabled: userId !== null && client !== null });
}

function useOptions(tripId: string) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMemo(() => expenseMutations(client!, queryClient, userId, tripId), [queryClient, userId, tripId]);
}

export function useCreateExpense(tripId: string) {
  const options = useOptions(tripId);
  return useMutation<CreatedExpense, ExpenseError, CreateExpenseVars>(options.create);
}

export function useUpdateExpense(tripId: string) {
  const options = useOptions(tripId);
  return useMutation<ChangedExpense, ExpenseError, UpdateExpenseVars>(options.update);
}

export function useDeleteExpense(tripId: string) {
  const options = useOptions(tripId);
  return useMutation<ChangedExpense, ExpenseError, ExpenseRef>(options.remove);
}

export function useRestoreExpense(tripId: string) {
  const options = useOptions(tripId);
  return useMutation<ChangedExpense, ExpenseError, ExpenseRef>(options.restore);
}
