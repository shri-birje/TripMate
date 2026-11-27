import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { groupTripsByPhase, type Trip } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { FadeSwap, Screen } from '../../components/Screen';
import { UnderlineTabs } from '../../components/UnderlineTabs';
import { useProfile } from '../../features/profile/profileApi';
import { TripCard } from '../../features/trips/TripCard';
import { useTrips } from '../../features/trips/tripApi';
import { useLayoutMode } from '../../lib/useLayoutMode';
import { todayIso } from '../../lib/today';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';

type Phase = 'completed' | 'ongoing' | 'upcoming';
// Completed | Ongoing | Upcoming: Ongoing sits in the middle and is selected first.
const TABS: { value: Phase; label: string }[] = [
  { value: 'completed', label: 'Completed' },
  { value: 'ongoing', label: 'Ongoing' },
  { value: 'upcoming', label: 'Upcoming' },
];
const EMPTY: Record<Phase, { title: string; hint: string }> = {
  ongoing: { title: 'Nothing under way right now', hint: 'Trips whose dates include today appear here.' },
  upcoming: { title: 'No trips planned yet', hint: 'Trips that start later appear here.' },
  completed: { title: 'No finished trips yet', hint: 'Trips whose end date has passed appear here.' },
};

/**
 * Home: a greeting, a search shortcut, and the person's trips by status. The status tabs read Completed | Ongoing | Upcoming
 * (Ongoing selected first). Archived trips live on their own screen (bottom navigation), so they never appear here.
 */
export default function HomeScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const mode = useLayoutMode();
  const { data: profile, isPending: profileLoading } = useProfile();
  const { data: trips, isPending, error, refetch, isFetching } = useTrips();
  const firstName = profile?.displayName.split(' ')[0];
  const [phase, setPhase] = useState<Phase>('ongoing');

  const groups = useMemo(() => (trips ? groupTripsByPhase(trips, todayIso()) : null), [trips]);
  const visibleCount = groups ? groups.ongoing.length + groups.upcoming.length + groups.completed.length : 0;
  const shown: Trip[] = groups ? groups[phase] : [];
  const newTrip = () => router.push('/trips/new');
  const openTrip = (tripId: string) => router.push(`/trips/${tripId}`);

  return (
    <Screen>
      <View style={{ marginTop: spacing.sm, gap: spacing.xs }}>
        <AppText variant="eyebrow" tone="accent">
          TripMate
        </AppText>
        <AppText variant="title" testID="greeting">
          {profileLoading ? 'Welcome' : `Hello, ${firstName ?? 'traveller'}`}
        </AppText>
      </View>

      {/* The search field is a shortcut to the Search screen. */}
      <Pressable
        testID="home-search"
        onPress={() => router.navigate('/search')}
        role="button"
        aria-label="Search your trips"
        style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface }}
      >
        <Icon name="search" color={colors.textSecondaryOnSurface} size={22} />
        <AppText tone="secondary" style={{ color: colors.textSecondaryOnSurface }}>
          Search trips
        </AppText>
      </Pressable>

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
          <UnderlineTabs
            label="Trip status"
            testIDPrefix="status"
            options={TABS.map((t) => ({ ...t, accessibilityLabel: `${t.label}, ${groups[t.value].length}` }))}
            value={phase}
            onChange={setPhase}
          />
          <FadeSwap contentKey={phase}>
            <View testID={`section-${phase}`} style={mode === 'desktop' ? { gap: spacing.md, flexDirection: 'row', flexWrap: 'wrap' } : { gap: spacing.md }}>
              {shown.length === 0 ? (
                <Card>
                  <AppText variant="heading" testID={`empty-${phase}`}>
                    {EMPTY[phase].title}
                  </AppText>
                  <AppText tone="secondary">{EMPTY[phase].hint}</AppText>
                </Card>
              ) : (
                shown.map((t) => (
                  <View key={t.id} style={mode === 'desktop' ? { width: '48.5%' } : undefined}>
                    <TripCard trip={t} onPress={() => openTrip(t.id)} />
                  </View>
                ))
              )}
            </View>
          </FadeSwap>
        </>
      )}
    </Screen>
  );
}
