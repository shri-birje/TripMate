import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import {
  dayHeadingLong,
  formatDateRange,
  paidByLabel,
  type ExpenseCategory,
  type ExpenseDayGroup,
  type personLabels,
  type StoredExpense,
  type TripDetails,
} from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Icon } from '../../components/Icon';
import { SurfaceContext } from '../../components/Surface';
import { formatMoney } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';
import { categoryIconName } from './chartColors';
import { Collapsible } from './Collapsible';

type Labels = ReturnType<typeof personLabels>;

/** One expense as a compact card: category icon, title, category and date, amount, who paid. Opens the expense's detail screen. */
export function ExpenseRow({ details, expense: e, categories, labels }: { details: TripDetails; expense: StoredExpense; categories: readonly ExpenseCategory[]; labels: Labels }) {
  const router = useRouter();
  const { colors } = useTheme();
  const cat = e.categoryId === null ? null : (categories.find((c) => c.id === e.categoryId) ?? null);
  const category = cat?.name ?? null;
  return (
    <SurfaceContext.Provider value="surface">
      <Pressable
        testID={`expense-row-${e.id}`}
        onPress={() => router.push(`/trips/${details.trip.id}/expenses/${e.id}`)}
        role="link"
        aria-label={`${e.title}, ${formatMoney(e.amountMinor, details.trip.currency)}${e.deleted ? ', deleted' : ''}`}
        style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm + 2, paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.sm + 2, borderRadius: radius.md, backgroundColor: colors.surface2, opacity: e.deleted ? 0.7 : 1 }}
      >
        <View testID={`expense-icon-${e.id}`} style={{ width: 36, height: 36, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={categoryIconName(cat?.icon)} color={colors.primaryText} size={20} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
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
        </View>
      </Pressable>
    </SurfaceContext.Provider>
  );
}

/**
 * A trip day as a card that opens and closes. Closed it shows only the day number, the weekday and date, the number of expenses, the day's total
 * and a chevron; open it also lists that day's expenses. The open/closed state belongs to the screen, so several days can be open at once.
 */
export function ExpenseDayCard({
  group,
  details,
  categories,
  labels,
  open,
  onToggle,
}: {
  group: ExpenseDayGroup<StoredExpense>;
  details: TripDetails;
  categories: readonly ExpenseCategory[];
  labels: Labels;
  open: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const g = group;
  const title = g.dayNumber !== null && g.dayNumber >= 1 ? `Day ${g.dayNumber}` : 'Before the trip';
  const count = `${g.expenses.length} ${g.expenses.length === 1 ? 'expense' : 'expenses'}`;
  const total = formatMoney(g.totalMinor, details.trip.currency);
  return (
    <SurfaceContext.Provider value="surface">
      <View testID={`expense-day-${g.dateIso}`} style={{ borderRadius: radius.lg, backgroundColor: colors.surface, overflow: 'hidden' }}>
        <Pressable
          testID={`expense-day-toggle-${g.dateIso}`}
          onPress={onToggle}
          role="button"
          aria-expanded={open}
          aria-label={`${title}, ${dayHeadingLong(g.dateIso)}, ${count}, total ${total}. ${open ? 'Collapse' : 'Expand'}`}
          style={{ padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 64 }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <AppText variant="heading" testID={`expense-day-title-${g.dateIso}`}>
              {title}
            </AppText>
            <AppText variant="small" tone="secondary" testID={`expense-day-date-${g.dateIso}`}>
              {dayHeadingLong(g.dateIso)}
            </AppText>
            <AppText variant="small" tone="secondary" testID={`expense-day-count-${g.dateIso}`}>
              {count}
            </AppText>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 2 }}>
            <AppText variant="heading" testID={`expense-day-total-${g.dateIso}`}>
              {total}
            </AppText>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <AppText variant="small" tone="brand" style={{ fontWeight: '600' }} testID={`expense-day-hint-${g.dateIso}`}>
                {open ? 'Collapse' : 'Expand'}
              </AppText>
              <View testID={`expense-day-chevron-${g.dateIso}`} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
                <Icon name="chevron" color={colors.primaryText} size={22} />
              </View>
            </View>
          </View>
        </Pressable>
        <Collapsible open={open} testID={`expense-day-body-${g.dateIso}`}>
          <View style={{ gap: spacing.xs, paddingHorizontal: spacing.md, paddingBottom: spacing.md }}>
            {g.expenses.map((e) => (
              <ExpenseRow key={e.id} details={details} expense={e} categories={categories} labels={labels} />
            ))}
          </View>
        </Collapsible>
      </View>
    </SurfaceContext.Provider>
  );
}
