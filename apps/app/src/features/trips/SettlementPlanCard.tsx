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
import { formatMoney } from '../../lib/format';
import { spacing } from '../../theme/tokens';
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
    <Card>
      <View testID="settlement-card" style={{ gap: spacing.md }}>
      <AppText variant="heading">Suggested payments</AppText>
      {outcome.state === 'working' && (
        <AppText tone="secondary" testID="settlement-working">
          Working out the payments…
        </AppText>
      )}
      {outcome.state === 'failed' && (
        <View testID={`settlement-error-${outcome.kind}`}>
          <Banner kind="error" testID="settlement-error">
            {settlementFailureMessage(outcome.kind)}
          </Banner>
        </View>
      )}
      {view && (
        <>
          <View style={{ gap: spacing.xs }} testID="settlement-mine">
            {view.mine.map((text, i) => (
              <AppText key={`${text}-${i}`} style={{ fontWeight: '700' }} testID={`settlement-mine-${i}`}>
                {text}
              </AppText>
            ))}
          </View>
          <AppText tone={view.lines.length === 0 ? 'ok' : 'secondary'} testID="settlement-headline">
            {view.headline}
          </AppText>
          {view.lines.length > 0 && (
            <View style={{ gap: spacing.sm }} testID="settlement-list">
              {view.lines.map((l, i) => (
                <AppText key={l.key} testID={`settlement-line-${i}`} style={{ fontWeight: l.involvesMe ? '600' : '400' }}>
                  {l.text}
                </AppText>
              ))}
            </View>
          )}
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
    </Card>
  );
}
