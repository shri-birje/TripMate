import { View } from 'react-native';
import { balanceKind, personLabels, personName, type TripBalanceLine, type TripDetails } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Avatar } from '../../components/Avatar';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { formatMoney } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';
import { useUserId } from '../auth/AuthProvider';

/** Whether any money has moved at all (someone paid or owes), so "settled" reads right for an empty trip. */
const expenseLinesExist = (lines: readonly { paidMinor: number; shareMinor: number }[]) => lines.some((l) => l.paidMinor > 0 || l.shareMinor > 0);

/** Tiny pill used for You / Guest / status. */
export function Pill({ label, tone, testID }: { label: string; tone: 'neutral' | 'ok' | 'error'; testID?: string }) {
  const { colors } = useTheme();
  const color = tone === 'ok' ? colors.statusOkOnSurface : tone === 'error' ? colors.statusErrorOnSurface : colors.textSecondaryOnSurface;
  return (
    <View testID={testID} style={{ backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: spacing.sm + 2, paddingVertical: 2 }}>
      <AppText variant="small" style={{ color, fontWeight: '700', fontSize: 12, lineHeight: 16 }}>
        {label}
      </AppText>
    </View>
  );
}

/**
 * The "Who owes whom" section: one card per member with their avatar, name, You/Guest label, a clear status and the amount. The figures are
 * exactly the ones the database reports (paid, share, net); this only arranges them. Red = owes, green = is owed, grey = settled.
 */
export function MemberBalances({ details, lines }: { details: TripDetails; lines: readonly TripBalanceLine[] }) {
  const { colors } = useTheme();
  const userId = useUserId();
  const { trip } = details;
  const labels = personLabels(details);
  const everyoneSettled = lines.every((l) => balanceKind(l) === 'settled');
  const ordered = [...lines].sort((a, b) => {
    const fa = labels.get(a.memberId)?.former ? 1 : 0;
    const fb = labels.get(b.memberId)?.former ? 1 : 0;
    return fa - fb || b.netMinor - a.netMinor;
  });
  const guestIds = new Set([...details.members, ...details.formerMembers].filter((m) => m.isGuest).map((m) => m.id));
  const meIds = new Set(details.members.filter((m) => m.userId !== null && m.userId === userId).map((m) => m.id));

  return (
    <Card testID="balances-card">
      <View style={{ gap: 2 }}>
        <AppText variant="heading">Who owes whom</AppText>
        <AppText variant="small" tone="secondary" testID="balances-note">
          Each balance adds up every expense on the trip: what a person paid, minus their share.
        </AppText>
      </View>
      {everyoneSettled && (
        <AppText tone="ok" testID="balances-settled">
          {lines.length > 0 && expenseLinesExist(lines) ? 'Everyone is settled.' : 'Nobody owes anything yet.'}
        </AppText>
      )}
      <View style={{ gap: spacing.sm }} testID="balances-list">
        {ordered.map((l) => {
          const kind = balanceKind(l);
          const name = personName(labels, l.memberId);
          const amountColor = kind === 'owed' ? colors.statusOkOnSurface : kind === 'owes' ? colors.statusErrorOnSurface : colors.textSecondaryOnSurface;
          const status = kind === 'owed' ? 'Is owed' : kind === 'owes' ? 'Owes' : 'Settled';
          const amount = kind === 'owed' ? formatMoney(l.netMinor, trip.currency) : kind === 'owes' ? formatMoney(-l.netMinor, trip.currency) : null;
          return (
            <View
              key={l.memberId}
              testID={`balance-${l.memberId}`}
              style={{ gap: spacing.sm, padding: spacing.sm + 2, borderRadius: radius.md, backgroundColor: colors.surface2, borderLeftWidth: 4, borderLeftColor: amountColor }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 }}>
                <Avatar name={labels.get(l.memberId)?.name ?? null} size={40} />
                <View style={{ flex: 1, gap: 4 }}>
                  <AppText testID={`balance-name-${l.memberId}`} style={{ fontWeight: '700' }}>
                    {name}
                  </AppText>
                  {(meIds.has(l.memberId) || guestIds.has(l.memberId)) && (
                    <View style={{ flexDirection: 'row', gap: spacing.xs }}>
                      {meIds.has(l.memberId) && <Pill label="You" tone="neutral" />}
                      {guestIds.has(l.memberId) && <Pill label="Guest" tone="neutral" />}
                    </View>
                  )}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <AppText testID={`balance-status-${l.memberId}`} variant="small" style={{ color: amountColor, fontWeight: '700' }}>
                    {status}
                  </AppText>
                  {amount !== null && (
                    <AppText testID={`balance-amount-${l.memberId}`} variant="heading" style={{ color: amountColor, fontSize: 18, lineHeight: 24 }}>
                      {amount}
                    </AppText>
                  )}
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: spacing.md }} testID={`balance-detail-${l.memberId}`}>
                <AppText variant="small" tone="secondary" testID={`balance-paid-${l.memberId}`}>
                  {`Paid ${formatMoney(l.paidMinor, trip.currency)}`}
                </AppText>
                <AppText variant="small" tone="secondary">
                  ·
                </AppText>
                <AppText variant="small" tone="secondary" testID={`balance-share-${l.memberId}`}>
                  {`Share ${formatMoney(l.shareMinor, trip.currency)}`}
                </AppText>
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

/** A circular direction icon: pay (arrow leaving) or receive (arrow arriving), in the status colour. */
export function DirectionBadge({ kind }: { kind: 'pay' | 'receive' | 'transfer' }) {
  const { colors } = useTheme();
  const color = kind === 'pay' ? colors.statusWarnOnSurface : kind === 'receive' ? colors.statusOkOnSurface : colors.textSecondaryOnSurface;
  const rotate = kind === 'pay' ? '-45deg' : kind === 'receive' ? '135deg' : '0deg';
  return (
    <View aria-hidden style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ transform: [{ rotate }] }}>
        <Icon name="arrowRight" color={color} size={22} />
      </View>
    </View>
  );
}
