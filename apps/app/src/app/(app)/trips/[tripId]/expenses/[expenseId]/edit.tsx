import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { expenseActions, expenseToForm, type ExpenseCategory, type ExpenseDraft, type ExpenseFormValues, type StoredExpense, type TripDetails } from '@tripmate/core';
import { AppText } from '../../../../../../components/AppText';
import { Banner } from '../../../../../../components/Banner';
import { Button } from '../../../../../../components/Button';
import { Card } from '../../../../../../components/Card';
import { useUserId } from '../../../../../../features/auth/AuthProvider';
import { ExpenseForm } from '../../../../../../features/trips/ExpenseForm';
import { useExpense, useExpenseCategories, useUpdateExpense } from '../../../../../../features/trips/expenseApi';
import { TripScope } from '../../../../../../features/trips/TripScope';

/**
 * Edit an expense (an administrator, or the person who added it; never on an archived trip or a deleted expense).
 *
 * The screen hides the form from people who may not use it, but that is a convenience: the database refuses the change unless
 * the caller is allowed, and re-checks everything else.
 *
 * CONCURRENCY: the form remembers the version of the expense it STARTED from. If someone else changed the expense in the meantime the
 * database refuses the save (nothing is overwritten) and this page offers "Reload latest", which starts the form again from the
 * newest saved version. Only people still on the trip can stay selected: nothing is silently reassigned.
 */
export default function EditExpenseScreen() {
  const params = useLocalSearchParams<{ tripId?: string | string[]; expenseId?: string | string[] }>();
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const tripId = first(params.tripId);
  const expenseId = first(params.expenseId);
  return (
    <TripScope tripId={tripId} backHref={`/trips/${tripId}/expenses/${expenseId}`} backLabel="← Back to expense" title="Edit expense">
      {(details) => <EditBody details={details} expenseId={expenseId} />}
    </TripScope>
  );
}

function EditBody({ details, expenseId }: { details: TripDetails; expenseId: string }) {
  const { trip } = details;
  const router = useRouter();
  const expense = useExpense(trip.id, expenseId);
  // The category list is needed to pre-fill the form: without it a save could silently drop the expense's category.
  const categories = useExpenseCategories();
  if (expense.isPending || categories.isPending) {
    return (
      <AppText tone="secondary" testID="expense-edit-loading">
        Loading expense…
      </AppText>
    );
  }
  if (expense.error && !expense.data) {
    return (
      <Card>
        <Banner kind="error" testID="expense-edit-load-error">
          {expense.error.message}
        </Banner>
        {expense.error.kind !== 'unavailable' && <Button testID="expense-edit-retry" label="Try again" variant="secondary" onPress={() => void expense.refetch()} loading={expense.isFetching} />}
      </Card>
    );
  }
  if (!expense.data) {
    return (
      <Card>
        <AppText testID="expense-edit-not-found">That expense is no longer there.</AppText>
        <Button testID="expense-edit-not-found-back" label="Back to expenses" onPress={() => router.replace(`/trips/${trip.id}/expenses`)} />
      </Card>
    );
  }
  if (categories.error && !categories.data) {
    return (
      <Card>
        <Banner kind="error" testID="expense-edit-categories-error">
          {categories.error.message}
        </Banner>
        <Button testID="expense-edit-categories-retry" label="Try again" variant="secondary" onPress={() => void categories.refetch()} loading={categories.isFetching} />
      </Card>
    );
  }
  return <EditSection details={details} initialExpense={expense.data} categories={categories.data ?? []} refetch={() => expense.refetch().then((r) => r.data)} />;
}

function EditSection({ details, initialExpense, categories, refetch }: { details: TripDetails; initialExpense: StoredExpense; categories: readonly ExpenseCategory[]; refetch: () => Promise<StoredExpense | undefined> }) {
  const { trip } = details;
  const router = useRouter();
  const userId = useUserId();
  const update = useUpdateExpense(trip.id);
  const activeIds = details.members.map((m) => m.id);

  // What the person started from: the form's initial values AND the version they came from.
  const [base, setBase] = useState<{ expense: StoredExpense; values: ExpenseFormValues; key: number }>(() => ({
    expense: initialExpense,
    values: expenseToForm(initialExpense, categories, activeIds),
    key: 0,
  }));
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const actions = expenseActions(details, userId, base.expense);
  const backToExpense = (notice?: string) => router.replace(`/trips/${trip.id}/expenses/${base.expense.id}${notice ? `?notice=${notice}` : ''}`);

  if (base.expense.deleted) {
    return (
      <Card>
        <Banner kind="info" testID="expense-edit-deleted">
          This expense is deleted. Restore it first if you want to change it.
        </Banner>
        <Button testID="expense-edit-deleted-back" label="Back to expense" variant="secondary" onPress={() => backToExpense()} />
      </Card>
    );
  }
  if (actions.reason === 'archived' || actions.reason === 'not_yours' || actions.reason === 'not_a_member') {
    return (
      <Card>
        <Banner kind="info" testID="expense-edit-blocked">
          {actions.reason === 'archived' ? 'This trip is archived. Restore it from the trip page to change expenses.' : 'Only a trip admin or the person who added this expense can change it.'}
        </Banner>
        <Button testID="expense-edit-blocked-back" label="Back to expense" variant="secondary" onPress={() => backToExpense()} />
      </Card>
    );
  }

  function save(draft: ExpenseDraft) {
    setError(null);
    setConflict(false);
    update.mutate(
      { tripId: trip.id, expenseId: base.expense.id, expectedVersion: base.expense.version, draft, context: { tripStart: trip.startDate, tripEnd: trip.endDate, activeMemberIds: activeIds } },
      {
        onSuccess: () => backToExpense('saved'),
        onError: (e) => {
          setError(e.message);
          setConflict(e.kind === 'conflict' || e.kind === 'deleted' || e.kind === 'not_found');
        },
      },
    );
  }

  /** Throws away what was typed and starts again from the latest saved version. */
  async function reloadLatest() {
    const latest = await refetch();
    if (!latest) {
      router.replace(`/trips/${trip.id}/expenses`);
      return;
    }
    setBase((b) => ({ expense: latest, values: expenseToForm(latest, categories, activeIds), key: b.key + 1 }));
    setError(null);
    setConflict(false);
  }

  return (
    <>
      {conflict && (
        <Card>
          <Banner kind="error" testID="expense-edit-conflict">
            {error ?? ''}
          </Banner>
          <Button testID="expense-edit-reload" label="Reload latest" variant="secondary" onPress={() => void reloadLatest()} />
        </Card>
      )}
      <ExpenseForm
        key={base.key}
        details={details}
        categories={categories}
        categoriesLoading={false}
        initial={base.values}
        submitLabel="Save changes"
        busy={update.isPending}
        error={conflict ? null : error}
        requireChange
        onSubmit={save}
        onCancel={() => backToExpense()}
      />
    </>
  );
}
