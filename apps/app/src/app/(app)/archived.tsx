import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';
import { archivedTrips } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { TripCard } from '../../features/trips/TripCard';
import { useTrips } from '../../features/trips/tripApi';
import { spacing } from '../../theme/tokens';

/**
 * Archived trips: the trips the database returned for this person that were archived. Opening one shows the usual
 * trip page, where an admin can Restore it (the existing restore action; nothing here changes how archiving works).
 */
export default function ArchivedScreen() {
  const router = useRouter();
  const { data: trips, isPending, error, refetch, isFetching } = useTrips();
  const archived = useMemo(() => (trips ? archivedTrips(trips) : []), [trips]);

  return (
    <Screen>
      <View style={{ marginTop: spacing.sm, gap: spacing.xs }}>
        <AppText variant="title">Archived</AppText>
        <AppText tone="secondary">Nothing is deleted. Open a trip to see it again; trip admins can restore it.</AppText>
      </View>

      {isPending && (
        <AppText tone="secondary" testID="archived-loading">
          Loading your trips…
        </AppText>
      )}

      {error && !trips && (
        <Card>
          <Banner kind="error" testID="archived-error">
            {error.message}
          </Banner>
          <Button label="Try again" variant="secondary" onPress={() => void refetch()} loading={isFetching} />
        </Card>
      )}

      {trips && archived.length === 0 && (
        <Card>
          <AppText variant="heading" testID="archived-empty">
            No archived trips
          </AppText>
          <AppText tone="secondary">When an admin archives a trip, it is kept here.</AppText>
        </Card>
      )}

      {archived.length > 0 && (
        <View style={{ gap: spacing.md }} testID="section-archived">
          <AppText variant="eyebrow" tone="secondary">{`Archived (${archived.length})`}</AppText>
          {archived.map((t) => (
            <TripCard key={t.id} trip={t} onPress={() => router.push(`/trips/${t.id}`)} />
          ))}
        </View>
      )}
    </Screen>
  );
}
