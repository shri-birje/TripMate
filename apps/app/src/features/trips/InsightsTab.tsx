import { useMemo } from 'react';
import { View } from 'react-native';
import { formatTenthsOfPercent, summarizeByCategory, type CategoryInsight, type TripDetails } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { donutTiles } from '../../lib/donut';
import { formatMoney } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';
import { useWindowDimensions } from 'react-native';
import { categoryColor, categoryIconName } from './chartColors';
import { useExpenseCategories, useExpenses } from './expenseApi';

const RING = 200; // donut outer diameter
const THICKNESS = 34;
const TILES = 240;

/**
 * Insights: a read-only look at where the trip's money went, by category. It re-adds the same expenses the Expenses tab lists (deleted ones
 * left out, each amount counted once) and draws them as bars and a donut. Nothing here writes anything or changes any figure, so it works the
 * same on an archived trip. If the expenses or the categories could not be read, it says so instead of showing partial totals.
 */
export function InsightsTab({ details }: { details: TripDetails }) {
  const { trip } = details;
  const expenses = useExpenses(trip.id);
  const categories = useExpenseCategories();
  const insights = useMemo(
    () => (expenses.data && categories.data ? summarizeByCategory(expenses.data, categories.data) : null),
    [expenses.data, categories.data],
  );

  if (expenses.isPending || categories.isPending) {
    return (
      <AppText tone="secondary" testID="insights-loading">
        Loading insights…
      </AppText>
    );
  }
  if (!insights) {
    const failed = expenses.error ?? categories.error;
    return (
      <Card>
        <Banner kind="error" testID="insights-error">
          {failed?.message ?? 'Insights could not be loaded.'}
        </Banner>
        <Button
          testID="insights-retry"
          label="Try again"
          variant="secondary"
          onPress={() => {
            void expenses.refetch();
            void categories.refetch();
          }}
          loading={expenses.isFetching || categories.isFetching}
        />
      </Card>
    );
  }

  const money = (minor: number) => formatMoney(minor, trip.currency);
  if (insights.expenseCount === 0) {
    return (
      <Card>
        <AppText variant="heading" testID="insights-empty-title">
          No spending to show yet
        </AppText>
        <AppText tone="secondary" testID="insights-empty">
          Once expenses are added, you will see where the money went, by category.
        </AppText>
      </Card>
    );
  }
  return (
    <>
      <SummaryCard total={money(insights.totalMinor)} count={insights.expenseCount} categoryCount={insights.categories.length} />
      <BarsCard items={insights.categories} money={money} />
      <DonutCard items={insights.categories} total={money(insights.totalMinor)} money={money} />
    </>
  );
}

function SummaryCard({ total, count, categoryCount }: { total: string; count: number; categoryCount: number }) {
  const cell = (label: string, value: string, id: string) => (
    <View style={{ flex: 1, minWidth: 110, gap: 2 }}>
      <AppText variant="eyebrow" tone="secondary">
        {label}
      </AppText>
      <AppText variant="heading" testID={id}>
        {value}
      </AppText>
    </View>
  );
  return (
    <Card tone="strong" testID="insights-summary">
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
        {cell('Total spent', total, 'insights-total')}
        {cell('Expenses', String(count), 'insights-count')}
        {cell('Categories', String(categoryCount), 'insights-categories')}
      </View>
    </Card>
  );
}

function BarsCard({ items, money }: { items: CategoryInsight[]; money: (m: number) => string }) {
  const { colors, scheme } = useTheme();
  const max = Math.max(...items.map((i) => i.totalMinor), 1);
  return (
    <Card>
      <View style={{ gap: 2 }}>
        <AppText variant="heading">Spending by category</AppText>
        <AppText variant="small" tone="secondary">
          The longest bar is the category with the most spending.
        </AppText>
      </View>
      <View style={{ gap: spacing.md }} testID="insights-bars" role="list">
        {items.map((c) => {
          const color = categoryColor(c.key, c.colorIndex, scheme);
          const pct = Math.max(2, Math.round((c.totalMinor / max) * 100)); // a tiny category still gets a visible sliver
          return (
            <View key={c.key} role="listitem" testID={`insights-bar-${c.key}`} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Icon name={categoryIconName(c.icon)} color={color} size={20} />
                <AppText style={{ flex: 1, fontWeight: '600' }} testID={`insights-bar-name-${c.key}`}>
                  {c.name}
                </AppText>
                <AppText style={{ fontWeight: '700' }} testID={`insights-bar-amount-${c.key}`}>
                  {money(c.totalMinor)}
                </AppText>
              </View>
              <View style={{ height: 14, borderRadius: 7, backgroundColor: colors.surface2, overflow: 'hidden' }}>
                <View testID={`insights-bar-fill-${c.key}`} style={{ width: `${pct}%`, height: 14, borderRadius: 7, backgroundColor: color }} />
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

function DonutCard({ items, total, money }: { items: CategoryInsight[]; total: string; money: (m: number) => string }) {
  const { colors, scheme } = useTheme();
  const { width } = useWindowDimensions();
  const sideBySide = width >= 760;
  const tiles = useMemo(() => donutTiles(items.map((i) => i.tenthsOfPercent), TILES), [items]);
  const mid = RING / 2 - THICKNESS / 2; // radius of the ring's centre line
  const arc = (2 * Math.PI * mid) / TILES + 1.5; // tile length along the ring, with a little overlap so no gaps show
  const summary = items.map((c) => `${c.name} ${money(c.totalMinor)}, ${formatTenthsOfPercent(c.tenthsOfPercent)}`).join('; ');
  return (
    <Card>
      <View style={{ gap: 2 }}>
        <AppText variant="heading">Share of spending</AppText>
        <AppText variant="small" tone="secondary">
          How the trip&apos;s total divides between categories.
        </AppText>
      </View>
      <View style={{ flexDirection: sideBySide ? 'row' : 'column', alignItems: sideBySide ? 'center' : 'stretch', gap: spacing.lg }}>
        <View style={{ alignItems: 'center' }}>
          <View testID="insights-donut" role="img" aria-label={`Donut chart of spending by category. Total ${total}. ${summary}`} style={{ width: RING, height: RING }}>
            <View aria-hidden style={{ width: RING, height: RING }}>
              {tiles.map((t, i) => {
                const rad = (t.angle * Math.PI) / 180;
                const cx = RING / 2 + mid * Math.sin(rad);
                const cy = RING / 2 - mid * Math.cos(rad);
                const item = items[t.segment]!;
                return (
                  <View
                    key={i}
                    style={{
                      position: 'absolute',
                      left: cx - THICKNESS / 2,
                      top: cy - arc / 2,
                      width: THICKNESS,
                      height: arc,
                      backgroundColor: categoryColor(item.key, item.colorIndex, scheme),
                      transform: [{ rotate: `${t.angle}deg` }],
                    }}
                  />
                );
              })}
            </View>
            <View style={{ position: 'absolute', left: THICKNESS, top: THICKNESS, width: RING - THICKNESS * 2, height: RING - THICKNESS * 2, alignItems: 'center', justifyContent: 'center' }}>
              <AppText variant="small" tone="secondary">
                Total
              </AppText>
              <AppText variant="heading" testID="insights-donut-total" style={{ fontSize: 18, lineHeight: 24 }}>
                {total}
              </AppText>
            </View>
          </View>
        </View>
        <View style={{ flex: sideBySide ? 1 : undefined, gap: spacing.sm }} testID="insights-legend" role="list">
          {items.map((c) => (
            <View key={c.key} role="listitem" testID={`insights-legend-${c.key}`} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface2 }}>
              <View style={{ width: 14, height: 14, borderRadius: 4, backgroundColor: categoryColor(c.key, c.colorIndex, scheme) }} />
              <AppText style={{ flex: 1, fontWeight: '600' }} testID={`insights-legend-name-${c.key}`}>
                {c.name}
              </AppText>
              <AppText testID={`insights-legend-amount-${c.key}`}>{money(c.totalMinor)}</AppText>
              <AppText tone="secondary" style={{ minWidth: 52, textAlign: 'right' }} testID={`insights-legend-percent-${c.key}`}>
                {formatTenthsOfPercent(c.tenthsOfPercent)}
              </AppText>
            </View>
          ))}
        </View>
      </View>
    </Card>
  );
}
