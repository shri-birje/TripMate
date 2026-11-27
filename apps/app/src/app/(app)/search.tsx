import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { TextField } from '../../components/TextField';
import { TripCard } from '../../features/trips/TripCard';
import { useTrips } from '../../features/trips/tripApi';
import { searchTripsByName } from '../../features/trips/tripSearch';
import { spacing } from '../../theme/tokens';

/**
 * Search: finds your trips by NAME among the trips already loaded on this device. (Searching by destination,
 * traveller, dates or expenses is not supported, so it is not offered.) A result opens the usual trip page.
 */
export default function SearchScreen() {
  const router = useRouter();
  const { data: trips, isPending, error, refetch, isFetching } = useTrips();
  const [query, setQuery] = useState('');
  const results = useMemo(() => (trips ? searchTripsByName(trips, query) : []), [trips, query]);
  const typed = query.trim().length > 0;

  return (
    <Screen>
      <View style={{ marginTop: spacing.sm }}>
        <AppText variant="title">Search</AppText>
      </View>

      <TextField testID="search-input" label="Trip name" value={query} onChangeText={setQuery} placeholder="Search your trips by name" autoCapitalize="none" returnKeyType="search" />

      {isPending && (
        <AppText tone="secondary" testID="search-loading">
          Loading your trips…
        </AppText>
      )}

      {error && !trips && (
        <Card>
          <Banner kind="error" testID="search-error">
            {error.message}
          </Banner>
          <Button label="Try again" variant="secondary" onPress={() => void refetch()} loading={isFetching} />
        </Card>
      )}

      {trips && !typed && (
        <AppText tone="secondary" testID="search-hint">
          Type part of a trip name to find it.
        </AppText>
      )}

      {trips && typed && results.length === 0 && (
        <Card>
          <AppText variant="heading" testID="search-empty">
            No trips match “{query.trim()}”
          </AppText>
          <AppText tone="secondary">Check the spelling, or try a shorter part of the name.</AppText>
        </Card>
      )}

      {results.length > 0 && (
        <View style={{ gap: spacing.md }} testID="search-results">
          <AppText variant="eyebrow" tone="secondary">
            {results.length === 1 ? '1 trip' : `${results.length} trips`}
          </AppText>
          {results.map((t) => (
            <TripCard key={t.id} trip={t} onPress={() => router.push(`/trips/${t.id}`)} />
          ))}
        </View>
      )}
    </Screen>
  );
}
