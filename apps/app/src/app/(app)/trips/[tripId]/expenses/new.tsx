import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { blankExpenseForm, canAddExpense, newExpenseId, type ExpenseDraft, type TripDetails } from '@tripmate/core';
import { AppText } from '../../../../../components/AppText';
import { Banner } from '../../../../../components/Banner';
import { Button } from '../../../../../components/Button';
import { Card } from '../../../../../components/Card';
import { useUserId } from '../../../../../features/auth/AuthProvider';
import { ExpenseForm } from '../../../../../features/trips/ExpenseForm';
import { useCreateExpense, useExpenseCategories } from '../../../../../features/trips/expenseApi';
import { TripScope } from '../../../../../features/trips/TripScope';
import { todayIso } from '../../../../../lib/today';

/**
 * Add a shared expense. The page is only offered to people on an active trip, but that is a convenience: the database refuses the
 * expense unless the caller is an active member of an active trip, and re-checks everything else (dates, who is still on the trip).
 *
 * RETRY SAFETY: ONE expense id is made when the page opens and sent on every try. If a try fails with a connection problem the
 * expense may or may not have been saved; pressing Save again sends the same id, and the database answers "already saved" instead
 * of making a second expense.
 */
export default function NewExpenseScreen() {
  const params = useLocalSearchParams<{ tripId?: string | string[] }>();
  const tripId = (Array.isArray(params.tripId) ? params.tripId[0] : params.tripId) ?? '';
  return (
    <TripScope tripId={tripId} backHref={`/trips/${tripId}/expenses`} backLabel="← Back to expenses" title="Add expense">
      {(details) => <NewExpenseBody details={details} />}
    </TripScope>
  );
}

function NewExpenseBody({ details }: { details: TripDetails }) {
  const { trip } = details;
  const router = useRouter();
  const userId = useUserId();
  const categories = useExpenseCategories();
  const create = useCreateExpense(trip.id);
  const expenseId = useRef(newExpenseId());
  const initial = useMemo(() => blankExpenseForm(details, userId, todayIso()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null);
  const backToList = () => router.replace(`/trips/${trip.id}/expenses`);
  const add = canAddExpense(details, userId);

  if (!add.canAdd) {
    return (
      <Card>
        <Banner kind="info" testID="expense-new-blocked">
          {add.reason === 'archived' ? 'This trip is archived. Restore it from the trip page to add expenses.' : 'Only people on the trip can add expenses.'}
        </Banner>
        <Button testID="expense-new-blocked-back" label="Back to expenses" variant="secondary" onPress={backToList} />
      </Card>
    );
  }

  function submit(draft: ExpenseDraft) {
    setError(null);
    create.mutate(
      { tripId: trip.id, expenseId: expenseId.current, draft, context: { tripStart: trip.startDate, tripEnd: trip.endDate, activeMemberIds: details.members.map((m) => m.id) } },
      {
        onSuccess: () => router.replace(`/trips/${trip.id}/expenses?notice=added`),
        onError: (e) => {
          setError(e.message);
          if (e.kind === 'taken') expenseId.current = newExpenseId(); // that id belongs to a different expense: the next try starts fresh
        },
      },
    );
  }

  return (
    <>
      <AppText variant="small" tone="secondary" testID="expense-new-note">
        Shared with the whole trip. Split equally between the people you choose.
      </AppText>
      <ExpenseForm
        details={details}
        categories={categories.data ?? []}
        categoriesLoading={categories.isPending}
        initial={initial}
        submitLabel="Save expense"
        busy={create.isPending}
        error={error}
        onSubmit={submit}
        onCancel={backToList}
      />
    </>
  );
}
