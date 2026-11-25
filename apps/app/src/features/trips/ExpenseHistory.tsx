import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { formatDateRange, historyEntries, personLabels, personName, type ExpenseCategory, type HistoryFormatters, type TripDetails } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { formatMoney } from '../../lib/format';
import { spacing } from '../../theme/tokens';
import { useExpenseHistory } from './expenseApi';

interface Props {
  details: TripDetails;
  expenseId: string;
  categories: readonly ExpenseCategory[];
}

/**
 * The history of one expense: when it was added, edited, deleted or restored, who did it, and for an edit what changed with the previous
 * value. It is read-only: nothing on this screen can change or delete a record.
 *
 * Privacy: the database records member ids and amounts, never an account id or an email; names come from the trip's members here, and
 * only active members of the trip can read the history at all (the database decides). It starts closed so the page stays calm.
 */
export function ExpenseHistory({ details, expenseId, categories }: Props) {
  const { trip } = details;
  const [open, setOpen] = useState(false);
  const history = useExpenseHistory(trip.id, expenseId, open); // fetched only once it is opened
  const labels = personLabels(details);
  const formatters: HistoryFormatters = {
    money: (minor) => formatMoney(minor, trip.currency),
    person: (id) => personName(labels, id),
    category: (key) => (key === null ? 'None' : (categories.find((c) => c.key === key)?.name ?? key)),
    day: (iso) => formatDateRange(iso, iso),
  };
  const entries = history.data ? historyEntries(history.data, formatters) : [];
  const count = history.data ? entries.length : null; // known once it has been opened

  return (
    <Card>
      <Pressable
        testID="expense-history-toggle"
        onPress={() => setOpen((v) => !v)}
        role="button"
        aria-expanded={open}
        aria-label={`History${count !== null ? `, ${count} ${count === 1 ? 'entry' : 'entries'}` : ''}. ${open ? 'Hide' : 'Show'}`}
        style={{ minHeight: 44, justifyContent: 'center' }}
      >
        <AppText variant="heading">{`${open ? '▾' : '▸'} History${count !== null ? ` (${count})` : ''}`}</AppText>
      </Pressable>

      {open && history.isPending && history.fetchStatus !== 'idle' && (
        <AppText tone="secondary" testID="expense-history-loading">
          Loading history…
        </AppText>
      )}
      {open && history.error && !history.data && (
        <View style={{ gap: spacing.sm }}>
          <Banner kind="error" testID="expense-history-error">
            {history.error.message}
          </Banner>
          {history.error.kind !== 'unavailable' && <Button testID="expense-history-retry" label="Try again" variant="secondary" onPress={() => void history.refetch()} loading={history.isFetching} />}
        </View>
      )}
      {open && history.data && entries.length === 0 && (
        <AppText tone="secondary" testID="expense-history-empty">
          No history has been recorded for this expense.
        </AppText>
      )}
      {open && entries.length > 0 && (
        <View style={{ gap: spacing.md }} testID="expense-history-list">
          {entries.map((e) => (
            <View key={e.version} testID={`history-entry-${e.version}`} style={{ gap: spacing.xs }}>
              <AppText style={{ fontWeight: '600' }} testID={`history-headline-${e.version}`}>
                {`${e.headline} by ${e.who}`}
              </AppText>
              <AppText variant="small" tone="secondary" testID={`history-when-${e.version}`}>
                {e.when}
              </AppText>
              {e.summary && (
                <AppText variant="small" testID={`history-summary-${e.version}`}>
                  {e.summary}
                </AppText>
              )}
              {e.lines.map((l, i) => (
                <AppText key={`${l.label}-${i}`} variant="small" testID={`history-line-${e.version}-${i}`}>
                  {`${l.label}: ${l.before} → ${l.after}`}
                </AppText>
              ))}
              {e.action === 'update' && e.lines.length === 0 && (
                <AppText variant="small" tone="secondary" testID={`history-nodetails-${e.version}`}>
                  Details of this change are not available.
                </AppText>
              )}
            </View>
          ))}
        </View>
      )}
    </Card>
  );
}
