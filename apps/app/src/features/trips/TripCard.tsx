import { View } from 'react-native';
import { formatDateRange, type Trip } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Card } from '../../components/Card';
import { formatMoney, peopleLabel } from '../../lib/format';
import { spacing } from '../../theme/tokens';

/**
 * One trip on the Home screen. Shows what matters at a glance: name, place,
 * dates, how many people, and the budget if one was set. (Tapping a card to open
 * the trip arrives in the next feature, so it is not interactive yet.)
 */
export function TripCard({ trip }: { trip: Trip }) {
  return (
    <View testID={`trip-card-${trip.id}`}>
      <Card>
        <View style={{ gap: spacing.xs }}>
          <AppText variant="heading">{trip.name}</AppText>
          <AppText tone="secondary">{trip.destination}</AppText>
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
    </View>
  );
}
