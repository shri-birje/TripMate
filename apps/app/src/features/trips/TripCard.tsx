import { Pressable, View } from 'react-native';
import { formatDateRange, type Trip } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Card } from '../../components/Card';
import { formatMoney, peopleLabel } from '../../lib/format';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

/**
 * One trip on the Home screen. Shows what matters at a glance: name, place,
 * dates, how many people, and the budget if one was set. When `onPress` is
 * given the whole card is a button that opens the trip.
 */
export function TripCard({ trip, onPress }: { trip: Trip; onPress?: () => void }) {
  const { colors } = useTheme();
  const archived = trip.status === 'archived';
  const card = (
    <Card>
        <View style={{ gap: spacing.xs }}>
          {/* Archived trips are muted (secondary text colour, which keeps good contrast) and labelled. */}
          <AppText variant="heading" tone={archived ? 'secondary' : 'primary'}>
            {trip.name}
          </AppText>
          <AppText tone="secondary">{trip.destination}</AppText>
          {archived && (
            <View
              testID={`archived-tag-${trip.id}`}
              style={{ alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.textSecondary, borderRadius: 999, paddingHorizontal: spacing.sm + 2, paddingVertical: 2 }}
            >
              <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
                Archived
              </AppText>
            </View>
          )}
        </View>
        <AppText variant="small">{formatDateRange(trip.startDate, trip.endDate)}</AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
          {trip.memberCount !== null && (
            <AppText variant="small" tone="secondary">
              {peopleLabel(trip.memberCount)}
            </AppText>
          )}
          {trip.budgetMinor !== null && (
            <AppText variant="small" tone="secondary">
              Budget {formatMoney(trip.budgetMinor, trip.currency)}
            </AppText>
          )}
        </View>
      </Card>
  );

  if (!onPress) return <View testID={`trip-card-${trip.id}`}>{card}</View>;
  return (
    <Pressable
      testID={`trip-card-${trip.id}`}
      onPress={onPress}
      role="button"
      // Screen readers read this instead of the card's contents, so it carries the essentials.
      aria-label={`Open ${archived ? 'archived ' : ''}trip ${trip.name}, ${trip.destination}, ${formatDateRange(trip.startDate, trip.endDate)}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      {card}
    </Pressable>
  );
}
