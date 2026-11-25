import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { canAddExpense, expenseTotals, type TripDetails } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { formatMoney } from '../../lib/format';
import { spacing } from '../../theme/tokens';
import { useExpenses } from './expenseApi';

interface Props {
  details: TripDetails;
  userId: string | null;
}

/**
 * A short summary of the trip's expenses with the two ways in: see them all, or add one. The detail lives on its own screens so this
 * page stays calm. Who may add is decided by the database (active members of an active trip); this only decides what to show.
 */
export function ExpensesCard({ details, userId }: Props) {
  const { trip } = details;
  const router = useRouter();
  const expenses = useExpenses(trip.id);
  const add = canAddExpense(details, userId);
  const totals = expenses.data ? expenseTotals(expenses.data) : null;

  return (
    <Card>
      <AppText variant="heading">Expenses</AppText>

      {expenses.isPending && (
        <AppText tone="secondary" testID="expenses-card-loading">
          Loading expenses…
        </AppText>
      )}

      {expenses.error && !expenses.data && (
        <View style={{ gap: spacing.sm }}>
          <Banner kind="error" testID="expenses-card-error">
            {expenses.error.message}
          </Banner>
          {expenses.error.kind !== 'unavailable' && <Button testID="expenses-card-retry" label="Try again" variant="secondary" onPress={() => void expenses.refetch()} loading={expenses.isFetching} />}
        </View>
      )}

      {totals && (
        <View style={{ gap: 2 }}>
          {totals.count === 0 ? (
            <AppText tone="secondary" testID="expenses-summary">
              No expenses yet.
            </AppText>
          ) : (
            <>
              <AppText testID="expenses-summary">{`${totals.count} ${totals.count === 1 ? 'expense' : 'expenses'} · ${formatMoney(totals.totalMinor, trip.currency)} in total`}</AppText>
              {totals.deletedCount > 0 && (
                <AppText variant="small" tone="secondary" testID="expenses-deleted-summary">
                  {`${totals.deletedCount} deleted`}
                </AppText>
              )}
            </>
          )}
        </View>
      )}

      {totals && (
        <View style={{ gap: spacing.sm }}>
          {add.canAdd ? (
            <Button testID="expense-add" label="Add expense" onPress={() => router.push(`/trips/${trip.id}/expenses/new`)} />
          ) : (
            <AppText variant="small" tone="secondary" testID="expense-add-note">
              {add.reason === 'archived' ? 'This trip is archived. Restore it to add expenses.' : 'Only people on the trip can add expenses.'}
            </AppText>
          )}
          <Button testID="expenses-open" label={totals.count === 0 && !add.canAdd ? 'Open expenses' : 'See expenses and balances'} variant="secondary" onPress={() => router.push(`/trips/${trip.id}/expenses`)} />
        </View>
      )}
    </Card>
  );
}
