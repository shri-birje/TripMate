import { Link, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { TripDetails } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { spacing } from '../../theme/tokens';
import { useTripDetails } from './tripDetailsApi';

interface Props {
  tripId: string;
  /** Where the "back" link goes, and what it says. */
  backHref: string;
  backLabel: string;
  title: string;
  children: (details: TripDetails, reload: () => void) => ReactNode;
}

/**
 * The frame every expense screen sits in: a back link, a title, and the trip itself.
 *
 * Who may open a trip is decided by the database. A trip that is unknown, not yours, or that you left shows ONE combined
 * "not available" message (it never reveals whether the trip exists); a connection problem offers Try again.
 */
export function TripScope({ tripId, backHref, backLabel, title, children }: Props) {
  const router = useRouter();
  const { data, error, isPending, refetch, isFetching } = useTripDetails(tripId);
  return (
    <Screen>
      <View style={{ marginTop: spacing.md, gap: spacing.xs }}>
        <Link href={backHref as never} accessibilityRole="link" testID="scope-back">
          <AppText tone="brand" style={{ fontWeight: '600' }}>
            {backLabel}
          </AppText>
        </Link>
        <AppText variant="title" testID="scope-title">
          {title}
        </AppText>
      </View>

      {isPending && (
        <AppText tone="secondary" testID="scope-loading">
          Loading trip…
        </AppText>
      )}

      {error && !data && error.kind === 'unavailable' && (
        <Card>
          <AppText variant="heading" testID="trip-unavailable-title">
            Trip not available
          </AppText>
          <AppText testID="trip-unavailable">{error.message}</AppText>
          <Button testID="trip-unavailable-home" label="Back to Home" onPress={() => router.replace('/')} />
        </Card>
      )}

      {error && !data && error.kind !== 'unavailable' && (
        <Card>
          <Banner kind="error" testID="trip-error">
            {error.message}
          </Banner>
          <Button testID="trip-retry" label="Try again" variant="secondary" onPress={() => void refetch()} loading={isFetching} />
        </Card>
      )}

      {data && children(data, () => void refetch())}
    </Screen>
  );
}
