import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  balanceKind,
  canAddExpense,
  dayHeading,
  expenseTotals,
  groupExpensesByDay,
  formatDateRange,
  paidByLabel,
  personLabels,
  personName,
  type ExpenseCategory,
  type StoredExpense,
  type TripDetails,
} from '@tripmate/core';
import { AppText } from '../../../../../components/AppText';
import { Banner } from '../../../../../components/Banner';
import { Button } from '../../../../../components/Button';
import { Card } from '../../../../../components/Card';
import { SurfaceContext } from '../../../../../components/Surface';
import { UnderlineTabs } from '../../../../../components/UnderlineTabs';
import { useUserId } from '../../../../../features/auth/AuthProvider';
import { useExpenseCategories, useExpenses, useTripBalances } from '../../../../../features/trips/expenseApi';
import { MemberBalances } from '../../../../../features/trips/BalancesView';
import { ExpenseDayCard, ExpenseRow } from '../../../../../features/trips/ExpenseDayCard';
import { InsightsTab } from '../../../../../features/trips/InsightsTab';
import { SettlementPlanCard } from '../../../../../features/trips/SettlementPlanCard';
import { TripScope } from '../../../../../features/trips/TripScope';
import { formatMoney } from '../../../../../lib/format';
import { useTheme } from '../../../../../theme/ThemeProvider';
import { spacing } from '../../../../../theme/tokens';

type Tab = 'list' | 'balances' | 'insights';

const NOTICES: Record<string, string> = {
  added: 'Expense added.',
  saved: 'Expense saved.',
  deleted: 'Expense deleted. You can restore it from the Deleted section.',
  restored: 'Expense restored.',
};

/**
 * The trip's expenses and who owes whom, on one screen with two tabs.
 *
 * Everything shown comes from the database: the expenses, the shares it stored, and the balances it computes. Who may open this is
 * decided by the database (only active members of the trip can read anything).
 */
export default function ExpensesScreen() {
  const params = useLocalSearchParams<{ tripId?: string | string[]; notice?: string | string[] }>();
  const tripId = (Array.isArray(params.tripId) ? params.tripId[0] : params.tripId) ?? '';
  const notice = (Array.isArray(params.notice) ? params.notice[0] : params.notice) ?? '';
  return (
    <TripScope tripId={tripId} backHref={`/trips/${tripId}`} backLabel="← Back to trip" title="Expenses">
      {(details, reload) => <ExpensesBody details={details} reload={reload} notice={NOTICES[notice] ?? null} />}
    </TripScope>
  );
}

function ExpensesBody({ details, reload, notice }: { details: TripDetails; reload: () => void; notice: string | null }) {
  const { trip } = details;
  const router = useRouter();
  const userId = useUserId();
  const [tab, setTab] = useState<Tab>('list');
  const add = canAddExpense(details, userId);
  const expenses = useExpenses(trip.id);
  const categories = useExpenseCategories();

  return (
    <>
      {notice && (
        <Banner kind="success" testID="expenses-notice">
          {notice}
        </Banner>
      )}
      <UnderlineTabs<Tab>
        label="Show"
        testIDPrefix="expenses-tab"
        options={[
          { value: 'list', label: 'Expenses' },
          { value: 'balances', label: 'Balances' },
          { value: 'insights', label: 'Insights' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'list' ? (
        <>
          {add.canAdd ? (
            <Button testID="expense-add" label="Add expense" onPress={() => router.push(`/trips/${trip.id}/expenses/new`)} />
          ) : (
            <AppText variant="small" tone="secondary" testID="expense-add-note">
              {add.reason === 'archived' ? 'This trip is archived. Restore it to add expenses.' : 'Only people on the trip can add expenses.'}
            </AppText>
          )}
          {expenses.isPending && (
            <AppText tone="secondary" testID="expenses-loading">
              Loading expenses…
            </AppText>
          )}
          {expenses.error && !expenses.data && (
            <Card>
              <Banner kind="error" testID="expenses-error">
                {expenses.error.message}
              </Banner>
              {expenses.error.kind !== 'unavailable' && <Button testID="expenses-retry" label="Try again" variant="secondary" onPress={() => void expenses.refetch()} loading={expenses.isFetching} />}
            </Card>
          )}
          {expenses.data && <ExpenseList key={trip.id} details={details} expenses={expenses.data} categories={categories.data ?? []} />}
        </>
      ) : tab === 'balances' ? (
        <BalancesTab details={details} reload={reload} />
      ) : (
        <InsightsTab details={details} />
      )}
    </>
  );
}

function ExpenseList({ details, expenses, categories }: { details: TripDetails; expenses: StoredExpense[]; categories: readonly ExpenseCategory[] }) {
  const [showDeleted, setShowDeleted] = useState(false);
  // Which trip days are open. All start closed; several can be open together. Held here so a refresh of the data keeps them as they are.
  const [expandedDays, setExpandedDays] = useState<ReadonlySet<string>>(() => new Set());
  const toggleDay = (iso: string) =>
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });
  const labels = personLabels(details);
  const live = expenses.filter((e) => !e.deleted);
  const deleted = expenses.filter((e) => e.deleted);
  const totals = expenseTotals(expenses);
  const days = groupExpensesByDay(live, details.trip.startDate);

  if (expenses.length === 0) {
    return (
      <Card>
        <AppText variant="heading" testID="expenses-empty-title">
          No expenses yet
        </AppText>
        <AppText tone="secondary" testID="expenses-empty">
          Add the first shared expense and the trip&apos;s balances will start to fill in.
        </AppText>
      </Card>
    );
  }
  return (
    <>
      <AppText variant="small" tone="secondary" testID="expenses-count">
        {`${totals.count} ${totals.count === 1 ? 'expense' : 'expenses'} · ${formatMoney(totals.totalMinor, details.trip.currency)} in total`}
      </AppText>
      {live.length === 0 && (
        <AppText tone="secondary" testID="expenses-none-live">
          Every expense has been deleted. You can restore them below.
        </AppText>
      )}
      {/* One panel per trip day that has expenses: Day 1 is the trip's start day, worked out from each expense's own date. */}
      <View style={{ gap: spacing.lg }} testID="expenses-list">
        {days.map((g) => (
          <ExpenseDayCard
            key={g.dateIso}
            group={g}
            details={details}
            categories={categories}
            labels={labels}
            open={expandedDays.has(g.dateIso)}
            onToggle={() => toggleDay(g.dateIso)}
          />
        ))}
      </View>
      {deleted.length > 0 && (
        <View style={{ gap: spacing.sm }}>
          <Pressable
            testID="expenses-deleted-toggle"
            onPress={() => setShowDeleted((v) => !v)}
            role="button"
            aria-expanded={showDeleted}
            aria-label={`Deleted expenses, ${deleted.length}. ${showDeleted ? 'Hide' : 'Show'}`}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
              {`${showDeleted ? '▾' : '▸'} Deleted (${deleted.length})`}
            </AppText>
          </Pressable>
          {showDeleted && (
            <Card>
              <View style={{ gap: spacing.xs }} testID="expenses-deleted-list">
                {deleted.map((e) => (
                  <ExpenseRow key={e.id} details={details} expense={e} categories={categories} labels={labels} />
                ))}
              </View>
            </Card>
          )}
        </View>
      )}
    </>
  );
}

function BalancesTab({ details, reload }: { details: TripDetails; reload: () => void }) {
  const { trip } = details;
  const balances = useTripBalances(trip.id);
  void reload;

  if (balances.isPending) {
    return (
      <AppText tone="secondary" testID="balances-loading">
        Loading balances…
      </AppText>
    );
  }
  if (balances.error && !balances.data) {
    return (
      <Card>
        <Banner kind="error" testID="balances-error">
          {balances.error.message}
        </Banner>
        {balances.error.kind !== 'unavailable' && <Button testID="balances-retry" label="Try again" variant="secondary" onPress={() => void balances.refetch()} loading={balances.isFetching} />}
      </Card>
    );
  }
  const lines = balances.data ?? [];
  return (
    <>
      <MemberBalances details={details} lines={lines} />
      <SettlementPlanCard details={details} lines={lines} />
      <AppText variant="small" tone="secondary" testID="balances-later">
        Recording repayments is not part of the app yet. These figures only show where everyone stands.
      </AppText>
    </>
  );
}
