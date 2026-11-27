import { useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  bpToPercentText,
  formToDraft,
  parseDateInput,
  payerGap,
  setParticipants,
  setSplitMethod,
  splitGap,
  splitPreview,
  toggleParticipant,
  togglePayer,
  type ExpenseCategory,
  type ExpenseDraft,
  type ExpenseFormValues,
  type SplitMethod,
  type TripDetails,
} from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CheckRow } from '../../components/CheckRow';
import { Reveal } from '../../components/Reveal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { NumericField } from '../../components/NumericField';
import { TextField } from '../../components/TextField';
import { formatMoney } from '../../lib/format';
import { spacing } from '../../theme/tokens';
import { DateField } from './DateField';

interface Props {
  details: TripDetails;
  categories: readonly ExpenseCategory[];
  categoriesLoading: boolean;
  initial: ExpenseFormValues;
  submitLabel: string;
  busy: boolean;
  /** A message from the last save attempt (the database's answer in plain words). */
  error: string | null;
  /** When true (editing), Save stays off until something has changed. */
  requireChange?: boolean;
  onSubmit: (draft: ExpenseDraft) => void;
  onCancel: () => void;
}

const NONE = 'none';

/**
 * The form for a shared, equally split expense (used to add and to edit).
 *
 * Split methods: equally, exact amounts, percentages, or shares. The person types only their own numbers for each method.
 *
 * WHAT THIS DOES NOT DO: decide money. It collects what was typed, checks it with the shared rules (formToDraft), and shows a
 * PREVIEW from the shared engine. The database derives, stores and balances the real amounts when you save, and the app never
 * sends a calculated share. Only CURRENT members can be chosen, as payers or as people who share. Former members are never offered.
 */
const METHODS: { value: SplitMethod; label: string }[] = [
  { value: 'equal', label: 'Equally' },
  { value: 'exact', label: 'Exact amounts' },
  { value: 'percentage', label: 'Percentages' },
  { value: 'shares', label: 'Shares' },
];
const METHOD_NOTE: Record<SplitMethod, string> = {
  equal: 'Everyone ticked below pays the same.',
  exact: 'Type exactly what each person owes. The amounts must add up to the total.',
  percentage: 'Type each person\'s share as a percentage, for example 33.33. They must add up to 100%.',
  shares: 'Type shares, for example 2 : 1 : 1. Each person pays in proportion to their shares.',
};
export function ExpenseForm({ details, categories, categoriesLoading, initial, submitLabel, busy, error, requireChange = false, onSubmit, onCancel }: Props) {
  const { trip, members } = details;
  const [values, setValues] = useState<ExpenseFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submitting = useRef(false); // stops two quick taps sending two saves

  const set = <K extends keyof ExpenseFormValues>(key: K, value: ExpenseFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const gap = payerGap(values);
  const payerIds = Object.keys(values.payerAmounts);
  const severalPayers = payerIds.length > 1;
  const tripStartIso = trip.startDate;

  const split = splitGap(values);
  const preview = useMemo(() => splitPreview(values), [values]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    if (submitting.current || busy) return;
    const checked = formToDraft(values, { tripStart: trip.startDate, tripEnd: trip.endDate, activeMemberIds: members.map((m) => m.id) });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    submitting.current = true;
    try {
      onSubmit(checked.draft);
    } finally {
      // released on the next tick: the parent's mutation then reports busy
      setTimeout(() => { submitting.current = false; }, 0);
    }
  }

  const memberOrder = members.map((m) => m.id);
  const percentOf = (bp: number) => `${bpToPercentText(bp)}%`;

  const categoryOptions = [{ value: NONE, label: 'None' }, ...categories.map((c) => ({ value: c.key, label: c.name }))];
  const money = (minor: number) => formatMoney(minor, trip.currency);

  /** The live "still to assign" line for the typed split values. */
  function splitGapText(): string {
    if (split.method === 'exact') {
      if (split.remaining === null) return 'Enter the total amount first.';
      if (split.remaining > 0) return `${money(split.remaining)} of the total is still to assign.`;
      if (split.remaining < 0) return `${money(-split.remaining)} more than the total has been assigned.`;
      return split.incomplete ? 'Enter how much each person owes.' : 'The amounts add up to the total.';
    }
    if (split.method === 'percentage') {
      const rem = split.remaining ?? 0;
      if (rem > 0) return `${percentOf(rem)} is still to assign.`;
      if (rem < 0) return `${percentOf(-rem)} more than 100% has been assigned.`;
      return split.incomplete ? 'Enter each person\'s percentage.' : 'The percentages add up to 100%.';
    }
    return split.incomplete ? 'Enter each person\'s shares as a whole number.' : `${split.assigned} ${split.assigned === 1 ? 'share' : 'shares'} in total.`;
  }

  return (
    <>
      <Card>
        <AppText variant="heading">The expense</AppText>
        <TextField testID="expense-title" label="What was it for?" value={values.title} onChangeText={(v) => set('title', v)} error={errors.title} placeholder="Beach dinner" autoCapitalize="sentences" maxLength={120} />
        <NumericField
          kind="money"
          testID="expense-amount"
          label={`Total amount (${trip.currency})`}
          value={values.amount}
          onChangeText={(v) => set('amount', v)}
          error={errors.amount}
          placeholder="1200"
        />
        <DateField
          testID="expense-date"
          label="Day"
          value={values.date}
          onChangeText={(v) => set('date', v)}
          error={errors.date}
          minIso={trip.startDate}
          maxIso={trip.endDate}
          limitTyping
          helper={`Within the trip: ${trip.startDate.split('-').reverse().join('/')} to ${trip.endDate.split('-').reverse().join('/')}`}
          placeholder="28/12/2026"
          initialViewIso={parseDateInput(values.date) ?? tripStartIso}
        />
        <View style={{ gap: spacing.xs }}>
          <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
            Category
          </AppText>
          {categoriesLoading && categories.length === 0 ? (
            <AppText variant="small" tone="secondary" testID="expense-categories-loading">
              Loading categories…
            </AppText>
          ) : (
            <SegmentedControl label="Category" testIDPrefix="expense-category" options={categoryOptions} value={values.categoryKey ?? NONE} onChange={(v) => set('categoryKey', v === NONE ? null : v)} />
          )}
        </View>
        <TextField testID="expense-notes" label="Notes (optional)" value={values.notes} onChangeText={(v) => set('notes', v)} error={errors.notes} multiline maxLength={1000} />
      </Card>

      <Card>
        <AppText variant="heading">Who paid?</AppText>
        <AppText variant="small" tone="secondary">
          Choose one person, or several if the bill was split between payers.
        </AppText>
        {members.map((m) => {
          const paid = m.id in values.payerAmounts;
          return (
            <View key={m.id}>
              <CheckRow testID={`expense-payer-${m.id}`} label={m.displayName} note={m.isGuest ? 'Guest' : undefined} checked={paid} onToggle={() => setValues(togglePayer(values, m.id))} />
              {paid && severalPayers && (
                <NumericField
                  kind="money"
                  testID={`expense-payer-amount-${m.id}`}
                  label={`${m.displayName} paid (${trip.currency})`}
                  value={values.payerAmounts[m.id] ?? ''}
                  onChangeText={(v) => set('payerAmounts', { ...values.payerAmounts, [m.id]: v })}
                  placeholder="0"
                />
              )}
            </View>
          );
        })}
        {severalPayers && gap.remainingMinor !== null && (
          <AppText variant="small" tone={gap.remainingMinor === 0 && !gap.incomplete ? 'ok' : 'secondary'} testID="expense-payer-gap">
            {gap.remainingMinor === 0
              ? gap.incomplete
                ? 'Enter how much each person paid.'
                : 'What was paid adds up to the total.'
              : gap.remainingMinor > 0
                ? `${money(gap.remainingMinor)} of the total is still to assign.`
                : `${money(-gap.remainingMinor)} more than the total has been assigned.`}
          </AppText>
        )}
        {!severalPayers && payerIds.length === 1 && gap.totalMinor !== null && gap.totalMinor > 0 && (
          <AppText variant="small" tone="secondary" testID="expense-payer-single">
            {`${members.find((m) => m.id === payerIds[0])?.displayName ?? 'They'} paid the full ${money(gap.totalMinor)}.`}
          </AppText>
        )}
        {errors.payers && (
          <AppText variant="small" tone="error" testID="expense-payers-error">
            {errors.payers}
          </AppText>
        )}
      </Card>

      <Card>
        <AppText variant="heading">How is it split?</AppText>
        <SegmentedControl<SplitMethod> label="How is it split?" testIDPrefix="expense-method" options={METHODS} value={values.splitMethod} onChange={(m) => setValues(setSplitMethod(values, m))} />
        <AppText variant="small" tone="secondary" testID="expense-method-note">
          {METHOD_NOTE[values.splitMethod]}
        </AppText>
        <AppText variant="heading">Who shares it?</AppText>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Button testID="expense-participants-all" label="Everyone" variant="secondary" onPress={() => setValues(setParticipants(values, memberOrder))} />
          </View>
          <View style={{ flex: 1 }}>
            <Button testID="expense-participants-none" label="Nobody" variant="secondary" onPress={() => setValues(setParticipants(values, []))} />
          </View>
        </View>
        {members.map((m) => {
          const sharing = values.participantIds.includes(m.id);
          return (
            <View key={m.id}>
              <CheckRow testID={`expense-participant-${m.id}`} label={m.displayName} note={m.isGuest ? 'Guest' : undefined} checked={sharing} onToggle={() => setValues(toggleParticipant(values, m.id, memberOrder))} />
              {sharing && values.splitMethod !== 'equal' && (
                <Reveal key={values.splitMethod}>
                <NumericField
                  kind={values.splitMethod === 'exact' ? 'money' : values.splitMethod === 'percentage' ? 'percent' : 'shares'}
                  testID={`expense-split-value-${m.id}`}
                  label={values.splitMethod === 'exact' ? `${m.displayName} owes (${trip.currency})` : values.splitMethod === 'percentage' ? `${m.displayName} (%)` : `${m.displayName} (shares)`}
                  value={values.splitValues[m.id] ?? ''}
                  onChangeText={(v) => set('splitValues', { ...values.splitValues, [m.id]: v })}
                  placeholder={values.splitMethod === 'shares' ? '1' : '0'}
                />
                </Reveal>
              )}
            </View>
          );
        })}
        {values.splitMethod !== 'equal' && values.participantIds.length > 0 && (
          <AppText variant="small" tone={split.remaining === 0 && !split.incomplete ? 'ok' : 'secondary'} testID="expense-split-gap">
            {splitGapText()}
          </AppText>
        )}
        {errors.split && (
          <AppText variant="small" tone="error" testID="expense-split-error">
            {errors.split}
          </AppText>
        )}
        {errors.participants && (
          <AppText variant="small" tone="error" testID="expense-participants-error">
            {errors.participants}
          </AppText>
        )}
      </Card>

      {preview && (
        <Card>
          <AppText variant="heading">How it splits</AppText>
          <AppText variant="small" tone="secondary" testID="expense-preview-note">
            A preview. The final amounts are worked out when you save.
          </AppText>
          <View testID="expense-preview" style={{ gap: spacing.xs }}>
            {members.filter((m) => preview.has(m.id)).map((m) => (
              <View key={m.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
                <AppText style={{ flex: 1 }}>{m.displayName}</AppText>
                <AppText testID={`expense-share-${m.id}`} style={{ fontWeight: '600' }}>
                  {money(preview.get(m.id)!)}
                </AppText>
              </View>
            ))}
          </View>
        </Card>
      )}

      {errors.form && (
        <Banner kind="error" testID="expense-form-error">
          {errors.form}
        </Banner>
      )}
      {error && (
        <Banner kind="error" testID="expense-error">
          {error}
        </Banner>
      )}
      <Button testID="expense-save" label={submitLabel} loading={busy} disabled={requireChange && !dirty} onPress={submit} />
      <Button testID="expense-cancel" label="Cancel" variant="secondary" disabled={busy} onPress={onCancel} />
    </>
  );
}
