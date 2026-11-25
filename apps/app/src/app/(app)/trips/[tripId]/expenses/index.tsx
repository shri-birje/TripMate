import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import {
  balanceKind,
  canAddExpense,
  expenseTotals,
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
import { SegmentedControl } from '../../../../../components/SegmentedControl';
import { useUserId } from '../../../../../features/auth/AuthProvider';
import { useExpenseCategories, useExpenses, useTripBalances } from '../../../../../features/trips/expenseApi';
import { SettlementPlanCard } from '../../../../../features/trips/SettlementPlanCard';
import { TripScope } from '../../../../../features/trips/TripScope';
import { formatMoney } from '../../../../../lib/format';
import { useTheme } from '../../../../../theme/ThemeProvider';
import { radius, spacing } from '../../../../../theme/tokens';

type Tab = 'list' | 'balances';

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
      <SegmentedControl<Tab>
        label="Show"
        testIDPrefix="expenses-tab"
        options={[
          { value: 'list', label: 'Expenses' },
          { value: 'balances', label: 'Balances' },
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
          {expenses.data && <ExpenseList details={details} expenses={expenses.data} categories={categories.data ?? []} />}
        </>
      ) : (
        <BalancesTab details={details} reload={reload} />
      )}
    </>
  );
}

function ExpenseList({ details, expenses, categories }: { details: TripDetails; expenses: StoredExpense[]; categories: readonly ExpenseCategory[] }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const labels = personLabels(details);
  const live = expenses.filter((e) => !e.deleted);
  const deleted = expenses.filter((e) => e.deleted);
  const totals = expenseTotals(expenses);

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
      <View style={{ gap: spacing.sm }} testID="expenses-list">
        {live.map((e) => (
          <ExpenseRow key={e.id} details={details} expense={e} categories={categories} labels={labels} />
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
            <View style={{ gap: spacing.sm }} testID="expenses-deleted-list">
              {deleted.map((e) => (
                <ExpenseRow key={e.id} details={details} expense={e} categories={categories} labels={labels} />
              ))}
            </View>
          )}
        </View>
      )}
    </>
  );
}

function ExpenseRow({ details, expense: e, categories, labels }: { details: TripDetails; expense: StoredExpense; categories: readonly ExpenseCategory[]; labels: ReturnType<typeof personLabels> }) {
  const router = useRouter();
  const { colors } = useTheme();
  const category = e.categoryId === null ? null : (categories.find((c) => c.id === e.categoryId)?.name ?? null);
  return (
    <Pressable
      testID={`expense-row-${e.id}`}
      onPress={() => router.push(`/trips/${details.trip.id}/expenses/${e.id}`)}
      role="link"
      aria-label={`${e.title}, ${formatMoney(e.amountMinor, details.trip.currency)}${e.deleted ? ', deleted' : ''}`}
      style={{ padding: spacing.md, gap: spacing.xs, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, opacity: e.deleted ? 0.7 : 1 }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
        <AppText testID={`expense-title-${e.id}`} style={{ flex: 1, fontWeight: '600', textDecorationLine: e.deleted ? 'line-through' : 'none' }}>
          {e.title}
        </AppText>
        <AppText testID={`expense-amount-${e.id}`} style={{ fontWeight: '700' }}>
          {formatMoney(e.amountMinor, details.trip.currency)}
        </AppText>
      </View>
      <AppText variant="small" tone="secondary" testID={`expense-meta-${e.id}`}>
        {[category, formatDateRange(e.spentOn, e.spentOn)].filter(Boolean).join(' · ')}
      </AppText>
      <AppText variant="small" tone="secondary" testID={`expense-paidby-${e.id}`}>
        {paidByLabel(e, labels)}
      </AppText>
      {e.deleted && (
        <AppText variant="small" tone="error" testID={`expense-deleted-${e.id}`}>
          Deleted
        </AppText>
      )}
    </Pressable>
  );
}

function BalancesTab({ details, reload }: { details: TripDetails; reload: () => void }) {
  const { trip } = details;
  const { colors } = useTheme();
  const balances = useTripBalances(trip.id);
  const labels = personLabels(details);
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
  const everyoneSettled = lines.every((l) => balanceKind(l) === 'settled');
  const ordered = [...lines].sort((a, b) => {
    const fa = labels.get(a.memberId)?.former ? 1 : 0;
    const fb = labels.get(b.memberId)?.former ? 1 : 0;
    return fa - fb || b.netMinor - a.netMinor;
  });
  return (
    <>
      <Card>
        <AppText variant="heading">Who owes whom</AppText>
        <AppText variant="small" tone="secondary" testID="balances-note">
          Each balance adds up every expense on the trip: what a person paid, minus their share.
        </AppText>
        {everyoneSettled && (
          <AppText tone="ok" testID="balances-settled">
            {lines.length > 0 && expenseLinesExist(lines) ? 'Everyone is settled.' : 'Nobody owes anything yet.'}
          </AppText>
        )}
        <View style={{ gap: spacing.sm }} testID="balances-list">
          {ordered.map((l) => {
            const kind = balanceKind(l);
            const name = personName(labels, l.memberId);
            const sentence = kind === 'owes' ? `${name} owes ${formatMoney(-l.netMinor, trip.currency)}` : kind === 'owed' ? `${name} is owed ${formatMoney(l.netMinor, trip.currency)}` : `${name} is settled`;
            return (
              <View key={l.memberId} testID={`balance-${l.memberId}`} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: spacing.sm }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <AppText testID={`balance-text-${l.memberId}`} tone={kind === 'owed' ? 'ok' : kind === 'owes' ? 'error' : 'secondary'} style={{ fontWeight: '600' }}>
                    {sentence}
                  </AppText>
                  <AppText variant="small" tone="secondary" testID={`balance-detail-${l.memberId}`}>
                    {`Paid ${formatMoney(l.paidMinor, trip.currency)} · share ${formatMoney(l.shareMinor, trip.currency)}`}
                  </AppText>
                </View>
              </View>
            );
          })}
        </View>
      </Card>
      <SettlementPlanCard details={details} lines={lines} />
      <AppText variant="small" tone="secondary" testID="balances-later">
        Recording repayments is not part of the app yet. These figures only show where everyone stands.
      </AppText>
    </>
  );
}

/** Whether any money has moved at all (someone paid or owes), so "settled" reads right for an empty trip. */
const expenseLinesExist = (lines: { paidMinor: number; shareMinor: number }[]) => lines.some((l) => l.paidMinor > 0 || l.shareMinor > 0);
