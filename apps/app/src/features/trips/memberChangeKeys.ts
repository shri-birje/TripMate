import { balancesKey, expensesKey } from './expenseQueries';

/**
 * The expense-side answers a change to who is on a trip makes out of date: who is on the trip decides who can be charged, who can edit
 * and who is a former member, so the trip's expense list and its balances must be refreshed along with the people (which the member
 * hooks refresh themselves). Kept apart from the hooks so it can be tested without React.
 */
export const memberChangeExpenseKeys = (userId: string | null, tripId: string) => [expensesKey(userId, tripId), balancesKey(userId, tripId)] as const;
