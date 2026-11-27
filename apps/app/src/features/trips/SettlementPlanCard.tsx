import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  SETTLEMENT_DISCLAIMER,
  classifySettlementFailure,
  personLabels,
  personName,
  planSettlement,
  settlementFailureMessage,
  settlementView,
  type SettlementFailureKind,
  type SettlementPlan,
  type TripBalanceLine,
  type TripDetails,
} from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { formatMoney } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';
import { DirectionBadge } from './BalancesView';
import { useUserId } from '../auth/AuthProvider';

interface Props {
  details: TripDetails;
  lines: readonly TripBalanceLine[];
}

type Outcome = { state: 'working' } | { state: 'ready'; plan: SettlementPlan } | { state: 'failed'; kind: SettlementFailureKind };

/** Plans with more people than this are worked out just after the screen has drawn, so the screen never waits for them. */
const DEFER_ABOVE = 12;

function tryPlan(input: Parameters<typeof planSettlement>[0]): Outcome {
  try {
    return { state: 'ready', plan: planSettlement(input) };
  } catch (e) {
    return { state: 'failed', kind: classifySettlementFailure(e) }; // each kind has its own message; no partial plan is ever shown
  }
}

/**
 * "Suggested payments": who should pay whom to settle the trip, worked out here from the balances the database reports (the shared
 * `planSettlement`). It is a SUGGESTION only: it moves no money and records nothing, and it can change when expenses change. It says so.
 */
export function SettlementPlanCard({ details, lines }: Props) {
  const { trip } = details;
  const { colors } = useTheme();
  const userId = useUserId();
  const labels = useMemo(() => personLabels(details), [details]);
  const activeIds = useMemo(() => new Set(details.members.map((m) => m.id)), [details.members]);
  const meId = details.members.find((m) => m.userId !== null && m.userId === userId)?.id ?? null;
  const input = useMemo(() => lines.map((l) => ({ memberId: l.memberId, netMinor: l.netMinor, active: activeIds.has(l.memberId) })), [lines, activeIds]);
  const deferred = input.filter((b) => b.netMinor !== 0).length > DEFER_ABOVE;

  const immediate = useMemo(() => (deferred ? null : tryPlan(input)), [deferred, input]);
  const [later, setLater] = useState<Outcome>({ state: 'working' });
  useEffect(() => {
    if (!deferred) return;
    setLater({ state: 'working' });
    const handle = setTimeout(() => setLater(tryPlan(input)), 0);
    return () => clearTimeout(handle);
  }, [deferred, input]);
  const outcome: Outcome = immediate ?? later;

  const view = useMemo(
    () =>
      outcome.state === 'ready'
        ? settlementView(outcome.plan, { meId, name: (id) => personName(labels, id), money: (m) => formatMoney(m, trip.currency) }, meId !== null)
        : null,
    [outcome, meId, labels, trip.currency],
  );

  return (
    <View testID="settlement-card" style={{ gap: spacing.lg }}>
      {outcome.state === 'working' && (
        <Card>
          <AppText variant="heading">Suggested payments</AppText>
          <AppText tone="secondary" testID="settlement-working">
            Working out the payments…
          </AppText>
        </Card>
      )}
      {outcome.state === 'failed' && (
        <Card>
          <AppText variant="heading">Suggested payments</AppText>
          <View testID={`settlement-error-${outcome.kind}`}>
            <Banner kind="error" testID="settlement-error">
              {settlementFailureMessage(outcome.kind)}
            </Banner>
          </View>
        </Card>
      )}
      {view && (
        <>
          {/* 1. The personal summary: a deeper panel with a forest edge, clearly "about you". */}
          <Card tone="strong" accent testID="settlement-mine-section">
            <View style={{ gap: spacing.xs }}>
              <SectionTag text="Only you" strong />
              <AppText variant="heading" testID="settlement-mine-title">
                My Suggested Payments
              </AppText>
              <AppText variant="small" tone="secondary">
                What you personally should pay or receive.
              </AppText>
            </View>
            <View style={{ gap: spacing.sm }} testID="settlement-mine">
              {view.mine.length === 0 && (
                <AppText tone="secondary" testID="settlement-mine-none">
                  Only people on this trip have a personal summary.
                </AppText>
              )}
              {view.mine.map((text, i) => {
                const kind = text.startsWith('You pay') ? 'pay' : text.startsWith('You receive') ? 'receive' : 'settled';
                return (
                  <View key={`${text}-${i}`} testID={`settlement-mine-row-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, padding: spacing.sm + 2, borderRadius: radius.md, backgroundColor: colors.surface }}>
                    {kind === 'settled' ? (
                      <View aria-hidden style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="check" color={colors.textSecondaryOnSurface} size={22} />
                      </View>
                    ) : (
                      <DirectionBadge kind={kind} />
                    )}
                    <AppText
                      variant="heading"
                      tone={kind === 'pay' ? 'warn' : kind === 'receive' ? 'ok' : 'secondary'}
                      style={{ fontSize: 17, lineHeight: 23, flex: 1 }}
                      testID={`settlement-mine-${i}`}
                    >
                      {text}
                    </AppText>
                  </View>
                );
              })}
            </View>
          </Card>

          {/* 2. The whole group's plan: a quieter, separate surface for reference. */}
          <Card>
            <View style={{ gap: spacing.xs }}>
              <SectionTag text="Group settlement plan" />
              <AppText variant="heading" testID="settlement-all-title">
                Everyone&apos;s Payments
              </AppText>
              <AppText variant="small" tone="secondary">
                The full plan for the group, not only yours.
              </AppText>
            </View>
            <AppText tone={view.lines.length === 0 ? 'ok' : 'secondary'} style={{ fontWeight: '600' }} testID="settlement-headline">
              {view.headline}
            </AppText>
            {view.lines.length > 0 && (
              <View style={{ gap: spacing.sm }} testID="settlement-list">
                {view.lines.map((l, i) => (
                  <View
                    key={l.key}
                    testID={`settlement-line-${i}`}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, padding: spacing.sm + 2, borderRadius: radius.md, backgroundColor: colors.surface2, borderLeftWidth: l.involvesMe ? 4 : 0, borderLeftColor: colors.primaryText }}
                  >
                    <DirectionBadge kind="transfer" />
                    <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.xs }}>
                      <AppText testID={`settlement-line-from-${i}`} style={{ fontWeight: '700' }}>
                        {personName(labels, l.fromId)}
                      </AppText>
                      <AppText tone="secondary" testID={`settlement-line-verb-${i}`}>
                        pays
                      </AppText>
                      <AppText testID={`settlement-line-to-${i}`} style={{ fontWeight: '700' }}>
                        {personName(labels, l.toId)}
                      </AppText>
                    </View>
                    <AppText testID={`settlement-line-amount-${i}`} variant="heading" style={{ fontSize: 18, lineHeight: 24 }}>
                      {formatMoney(l.amountMinor, trip.currency)}
                    </AppText>
                  </View>
                ))}
              </View>
            )}
          </Card>

          {view.inexactNote && (
            <AppText variant="small" tone="secondary" testID="settlement-inexact">
              {view.inexactNote}
            </AppText>
          )}
          {trip.status === 'archived' && (
            <AppText variant="small" tone="secondary" testID="settlement-archived">
              This trip is archived, so this is for reference.
            </AppText>
          )}
        </>
      )}
      <AppText variant="small" tone="secondary" testID="settlement-disclaimer">
        {SETTLEMENT_DISCLAIMER}
      </AppText>
    </View>
  );
}

/** A small label that says whose payments a section shows. */
function SectionTag({ text, strong = false }: { text: string; strong?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ alignSelf: 'flex-start', paddingHorizontal: spacing.sm + 2, paddingVertical: 3, borderRadius: 999, backgroundColor: strong ? colors.primary : colors.surface2 }}>
      <AppText variant="small" style={{ fontSize: 11, lineHeight: 15, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', color: strong ? colors.onPrimary : colors.textSecondaryOnSurface }}>
        {text}
      </AppText>
    </View>
  );
}
