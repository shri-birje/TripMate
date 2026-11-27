import { View } from 'react-native';
import { formatDateRange, tripPhase, type Trip } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { PressableScale } from '../../components/PressableScale';
import { SurfaceContext } from '../../components/Surface';
import { TripScene, sceneFor } from '../../components/TripScene';
import { formatMoney, peopleLabel } from '../../lib/format';
import { todayIso } from '../../lib/today';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';
import { StatusChip } from './PhaseBadge';

/**
 * One trip as an editorial, image-led card: a destination illustration, the status on it, then the trip name, place,
 * dates, how many people, and the budget if one was set. Only data the app already has is shown.
 * When `onPress` is given the whole card is a button that opens the trip (and eases down to 98 % while pressed).
 */
export function TripCard({ trip, onPress }: { trip: Trip; onPress?: () => void }) {
  const { colors } = useTheme();
  const archived = trip.status === 'archived';
  const phase = tripPhase(trip.startDate, trip.endDate, todayIso());
  const dates = formatDateRange(trip.startDate, trip.endDate);

  const card = (
    <SurfaceContext.Provider value="surface">
      <View style={{ backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' }}>
        <View>
          <TripScene kind={sceneFor(trip.id, `${trip.destination} ${trip.name}`)} height={136} />
          <View style={{ position: 'absolute', left: spacing.md - 4, bottom: spacing.md - 4 }}>
            {archived ? <StatusChip kind="archived" testID={`archived-tag-${trip.id}`} /> : <StatusChip kind={phase} />}
          </View>
        </View>
        <View style={{ padding: spacing.md, gap: spacing.xs }}>
          <AppText variant="heading" tone={archived ? 'secondary' : 'primary'} style={{ fontSize: 21, lineHeight: 27 }}>
            {trip.name}
          </AppText>
          <AppText variant="small" tone="secondary">
            {`${trip.destination} · ${dates}`}
          </AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: spacing.md, rowGap: 2, marginTop: spacing.xs }}>
            {trip.memberCount !== null && (
              <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
                {peopleLabel(trip.memberCount)}
              </AppText>
            )}
            {trip.budgetMinor !== null && (
              <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
                {`Budget ${formatMoney(trip.budgetMinor, trip.currency)}`}
              </AppText>
            )}
          </View>
        </View>
      </View>
    </SurfaceContext.Provider>
  );

  if (!onPress) return <View testID={`trip-card-${trip.id}`}>{card}</View>;
  return (
    <PressableScale
      testID={`trip-card-${trip.id}`}
      onPress={onPress}
      role="button"
      // Screen readers read this instead of the card's contents, so it carries the essentials.
      aria-label={`Open ${archived ? 'archived ' : ''}trip ${trip.name}, ${trip.destination}, ${dates}`}
    >
      {card}
    </PressableScale>
  );
}
