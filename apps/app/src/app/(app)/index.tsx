import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';
import { groupTripsByPhase } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { useProfile } from '../../features/profile/profileApi';
import { TripCard } from '../../features/trips/TripCard';
import { useTrips } from '../../features/trips/tripApi';
import { todayIso } from '../../lib/today';
import { spacing } from '../../theme/tokens';

/**
 * Home: a greeting and the person's trips, grouped Ongoing / Upcoming / Completed.
 * (The full Home design - balances, recent activity - grows as those features arrive.)
 */
export default function HomeScreen() {
  const router = useRouter();
  const { data: profile, isPending: profileLoading } = useProfile();
  const { data: trips, isPending, error, refetch, isFetching } = useTrips();
  const firstName = profile?.displayName.split(' ')[0];

  const groups = useMemo(() => (trips ? groupTripsByPhase(trips, todayIso()) : null), [trips]);
  const visibleCount = groups ? groups.ongoing.length + groups.upcoming.length + groups.completed.length : 0;
  const newTrip = () => router.push('/trips/new');
  const openTrip = (tripId: string) => router.push(`/trips/${tripId}`);

  return (
    <Screen>
      <View style={{ marginTop: spacing.lg, gap: spacing.xs }}>
        <AppText variant="small" tone="secondary">
          TripMate
        </AppText>
        <AppText variant="title" testID="greeting">
          {profileLoading ? 'Welcome' : `Hello, ${firstName ?? 'traveller'}`}
        </AppText>
      </View>

      {isPending && (
        <AppText tone="secondary" testID="trips-loading">
          Loading your trips…
        </AppText>
      )}

      {error && !trips && (
        <Card>
          <Banner kind="error" testID="trips-error">
            {error.message}
          </Banner>
          <Button testID="trips-retry" label="Try again" variant="secondary" onPress={() => void refetch()} loading={isFetching} />
        </Card>
      )}

      {groups && visibleCount === 0 && (
        <Card>
          <AppText variant="heading" testID="empty-title">
            Your next adventure starts here.
          </AppText>
          <AppText tone="secondary">Create your first trip and invite your friends to start planning together.</AppText>
          <Button testID="create-trip" label="Create a trip" onPress={newTrip} />
        </Card>
      )}

      {groups && visibleCount > 0 && (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
            <AppText variant="heading">Your trips</AppText>
            <View style={{ minWidth: 120 }}>
              <Button testID="create-trip" label="New trip" onPress={newTrip} />
            </View>
          </View>
          <Section title="Ongoing" trips={groups.ongoing} onOpen={openTrip} />
          <Section title="Upcoming" trips={groups.upcoming} onOpen={openTrip} />
          <Section title="Completed" trips={groups.completed} onOpen={openTrip} />
        </>
      )}

      <Button testID="open-profile" variant="secondary" label="Profile and settings" onPress={() => router.push('/profile')} />
    </Screen>
  );
}

function Section({
  title,
  trips,
  onOpen,
}: {
  title: string;
  trips: ReturnType<typeof groupTripsByPhase>['ongoing'];
  onOpen: (tripId: string) => void;
}) {
  if (trips.length === 0) return null;
  return (
    <View style={{ gap: spacing.sm }} testID={`section-${title.toLowerCase()}`}>
      <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
        {`${title} (${trips.length})`}
      </AppText>
      {trips.map((t) => (
        <TripCard key={t.id} trip={t} onPress={() => onOpen(t.id)} />
      ))}
    </View>
  );
}
