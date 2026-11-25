import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { bpToPercentText, expenseActions, formatDateRange, personLabels, personName, splitMethodLabel, type ExpenseCategory, type StoredExpense, type TripDetails } from '@tripmate/core';
import { AppText } from '../../../../../../components/AppText';
import { Banner } from '../../../../../../components/Banner';
import { Button } from '../../../../../../components/Button';
import { Card } from '../../../../../../components/Card';
import { ConfirmDialog } from '../../../../../../components/ConfirmDialog';
import { useUserId } from '../../../../../../features/auth/AuthProvider';
import { useDeleteExpense, useExpense, useExpenseCategories, useRestoreExpense } from '../../../../../../features/trips/expenseApi';
import { ExpenseHistory } from '../../../../../../features/trips/ExpenseHistory';
import type { ExpenseError } from '../../../../../../features/trips/expenseService';
import { TripScope } from '../../../../../../features/trips/TripScope';
import { formatMoney } from '../../../../../../lib/format';
import { spacing } from '../../../../../../theme/tokens';

const NOTICES: Record<string, string> = { saved: 'Expense saved.' };

/**
 * One expense: what it was, who paid, how it was split (the amounts the database stored), and the actions you may take.
 * Hiding actions from people who may not use them is a convenience: the database refuses the change unless the caller is an
 * active member who is an administrator or added the expense, and the trip is not archived.
 */
export default function ExpenseDetailScreen() {
  const params = useLocalSearchParams<{ tripId?: string | string[]; expenseId?: string | string[]; notice?: string | string[] }>();
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const tripId = first(params.tripId);
  const expenseId = first(params.expenseId);
  const notice = NOTICES[first(params.notice)] ?? null;
  return (
    <TripScope tripId={tripId} backHref={`/trips/${tripId}/expenses`} backLabel="← Back to expenses" title="Expense">
      {(details, reload) => <DetailBody details={details} expenseId={expenseId} reload={reload} notice={notice} />}
    </TripScope>
  );
}

function DetailBody({ details, expenseId, reload, notice }: { details: TripDetails; expenseId: string; reload: () => void; notice: string | null }) {
  const { trip } = details;
  const router = useRouter();
  const expense = useExpense(trip.id, expenseId);
  const categories = useExpenseCategories();

  if (expense.isPending) {
    return (
      <AppText tone="secondary" testID="expense-loading">
        Loading expense…
      </AppText>
    );
  }
  if (expense.error && !expense.data) {
    return (
      <Card>
        <Banner kind="error" testID="expense-load-error">
          {expense.error.message}
        </Banner>
        {expense.error.kind !== 'unavailable' && <Button testID="expense-retry" label="Try again" variant="secondary" onPress={() => void expense.refetch()} loading={expense.isFetching} />}
      </Card>
    );
  }
  if (!expense.data) {
    return (
      <Card>
        <AppText variant="heading" testID="expense-not-found-title">
          Expense not found
        </AppText>
        <AppText testID="expense-not-found">It may have been removed, or you may not be able to see it.</AppText>
        <Button testID="expense-not-found-back" label="Back to expenses" onPress={() => router.replace(`/trips/${trip.id}/expenses`)} />
      </Card>
    );
  }
  const categoryName = expense.data.categoryId === null ? null : (categories.data?.find((c) => c.id === expense.data!.categoryId)?.name ?? null);
  return <Detail details={details} expense={expense.data} categoryName={categoryName} categories={categories.data ?? []} reload={() => { reload(); void expense.refetch(); }} notice={notice} />;
}

type Pending = 'delete' | null;

function Detail({ details, expense: e, categoryName, categories, reload, notice: initialNotice }: { details: TripDetails; expense: StoredExpense; categoryName: string | null; categories: readonly ExpenseCategory[]; reload: () => void; notice: string | null }) {
  const { trip } = details;
  const router = useRouter();
  const userId = useUserId();
  const labels = personLabels(details);
  const actions = expenseActions(details, userId, e);
  const del = useDeleteExpense(trip.id);
  const restore = useRestoreExpense(trip.id);
  const busy = del.isPending || restore.isPending;
  const submitting = useRef(false); // stops two quick taps sending two requests
  const [pending, setPending] = useState<Pending>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);
  const [actionError, setActionError] = useState<ExpenseError | null>(null);
  const money = (minor: number) => formatMoney(minor, trip.currency);
  /** What was typed for a person under this split (a percentage or a number of shares); nothing extra for equal and exact. */
  const typedValue = (v: number | null): string | undefined =>
    v === null ? undefined : e.splitMethod === 'percentage' ? `${bpToPercentText(v)}%` : e.splitMethod === 'shares' ? `${v} ${v === 1 ? 'share' : 'shares'}` : undefined;
  const splitNote = `${e.splitMethod === 'equal' ? 'Split equally' : e.splitMethod === 'exact' ? 'Split by exact amounts' : e.splitMethod === 'percentage' ? 'Split by percentage' : 'Split by shares'} between ${e.shares.length} ${e.shares.length === 1 ? 'person' : 'people'}.`;

  function failed(err: ExpenseError, inDialog: boolean) {
    submitting.current = false;
    // A connection problem can simply be tried again; everything else explains itself on the page.
    if (inDialog && err.outcomeUnknown) setDialogError(err.message);
    else {
      setPending(null);
      setActionError(err);
    }
  }

  function confirmDelete() {
    if (submitting.current) return;
    submitting.current = true;
    setDialogError(null);
    setActionError(null);
    setNotice(null);
    del.mutate(
      { tripId: trip.id, expenseId: e.id, expectedVersion: e.version },
      {
        onSuccess: () => {
          submitting.current = false;
          setPending(null);
          setNotice('Expense deleted. You can restore it from here.');
        },
        onError: (err) => failed(err, true),
      },
    );
  }

  function doRestore() {
    if (submitting.current) return;
    submitting.current = true;
    setActionError(null);
    setNotice(null);
    restore.mutate(
      { tripId: trip.id, expenseId: e.id, expectedVersion: e.version },
      {
        onSuccess: () => {
          submitting.current = false;
          setNotice('Expense restored.');
        },
        onError: (err) => failed(err, false),
      },
    );
  }

  return (
    <>
      {notice && (
        <Banner kind="success" testID="expense-notice">
          {notice}
        </Banner>
      )}
      {e.deleted && (
        <Banner kind="info" testID="expense-deleted-banner">
          This expense is deleted. It does not count in the balances.
        </Banner>
      )}
      {actionError && (
        <Card>
          <Banner kind="error" testID="expense-action-error">
            {actionError.message}
          </Banner>
          <Button testID="expense-reload" label="Reload latest" variant="secondary" onPress={() => { setActionError(null); reload(); }} />
        </Card>
      )}

      <Card>
        <AppText variant="title" testID="expense-detail-title">
          {e.title}
        </AppText>
        <AppText variant="heading" testID="expense-detail-amount">
          {money(e.amountMinor)}
        </AppText>
        <Field label="Day" testID="expense-detail-date" value={formatDateRange(e.spentOn, e.spentOn)} />
        <Field label="Category" testID="expense-detail-category" value={categoryName ?? 'None'} muted={categoryName === null} />
        {e.notes !== null && <Field label="Notes" testID="expense-detail-notes" value={e.notes} />}
        <Field label="Split" testID="expense-detail-method" value={splitMethodLabel(e.splitMethod)} />
        <Field label="Added by" testID="expense-detail-added-by" value={personName(labels, e.createdBy)} />
      </Card>

      <Card>
        <AppText variant="heading">Who paid</AppText>
        <View style={{ gap: spacing.xs }} testID="expense-detail-payers">
          {e.payers.map((p) => (
            <Row key={p.memberId} testID={`expense-payer-row-${p.memberId}`} name={personName(labels, p.memberId)} amount={money(p.paidMinor)} />
          ))}
        </View>
      </Card>

      <Card>
        <AppText variant="heading">How it was split</AppText>
        <AppText variant="small" tone="secondary" testID="expense-detail-split-note">
          {splitNote}
        </AppText>
        <View style={{ gap: spacing.xs }} testID="expense-detail-shares">
          {e.shares.map((s) => (
            <Row key={s.memberId} testID={`expense-share-row-${s.memberId}`} name={personName(labels, s.memberId)} detail={typedValue(s.inputValue)} amount={money(s.shareMinor)} />
          ))}
        </View>
      </Card>

      <ExpenseHistory details={details} expenseId={e.id} categories={categories} />

      {(actions.canEdit || actions.canDelete || actions.canRestore) && (
        <Card>
          <AppText variant="heading">Manage</AppText>
          {actions.canEdit && <Button testID="expense-edit" label="Edit expense" disabled={busy} onPress={() => router.push(`/trips/${trip.id}/expenses/${e.id}/edit`)} />}
          {actions.canRestore && <Button testID="expense-restore" label="Restore expense" loading={restore.isPending} disabled={busy} onPress={doRestore} />}
          {actions.canDelete && <Button testID="expense-delete" label="Delete expense" variant="secondary" disabled={busy} onPress={() => { setDialogError(null); setActionError(null); setNotice(null); setPending('delete'); }} />}
        </Card>
      )}
      {actions.reason === 'archived' && (
        <AppText variant="small" tone="secondary" testID="expense-readonly-note">
          This trip is archived, so expenses are read-only. Restore the trip to change them.
        </AppText>
      )}
      {actions.reason === 'not_yours' && (
        <AppText variant="small" tone="secondary" testID="expense-readonly-note">
          Only a trip admin or the person who added this expense can change it.
        </AppText>
      )}

      <ConfirmDialog
        visible={pending === 'delete'}
        title="Delete this expense?"
        message={`"${e.title}" (${money(e.amountMinor)}) will stop counting in the balances. Nothing is lost: you can restore it later.`}
        confirmLabel="Delete expense"
        cancelLabel="Keep it"
        busy={del.isPending}
        error={dialogError}
        onConfirm={confirmDelete}
        onCancel={() => setPending(null)}
      />
    </>
  );
}

function Field({ label, value, testID, muted = false }: { label: string; value: string; testID: string; muted?: boolean }) {
  return (
    <View style={{ gap: 2 }}>
      <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
        {label}
      </AppText>
      <AppText tone={muted ? 'secondary' : 'primary'} testID={testID}>
        {value}
      </AppText>
    </View>
  );
}

function Row({ name, amount, testID, detail }: { name: string; amount: string; testID: string; detail?: string | undefined }) {
  return (
    <View testID={testID} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
      <View style={{ flex: 1 }}>
        <AppText>{name}</AppText>
        {detail ? (
          <AppText variant="small" tone="secondary">
            {detail}
          </AppText>
        ) : null}
      </View>
      <AppText style={{ fontWeight: '600' }}>{amount}</AppText>
    </View>
  );
}
