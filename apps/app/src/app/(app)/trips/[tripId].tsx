import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { daysLabel, formatDateRange, tripPhase, type TripDetails } from '@tripmate/core';
import { AppText } from '../../../components/AppText';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Screen } from '../../../components/Screen';
import { useUserId } from '../../../features/auth/AuthProvider';
import { PhaseBadge } from '../../../features/trips/PhaseBadge';
import { useTripDetails } from '../../../features/trips/tripDetailsApi';
import { formatMoney } from '../../../lib/format';
import { todayIso } from '../../../lib/today';
import { useTheme } from '../../../theme/ThemeProvider';
import { spacing } from '../../../theme/tokens';

/**
 * Trip Details: what you know about a trip you are on.
 *
 * Who may open a trip is decided by the database. If the trip is unknown, not yours, or you
 * were removed from it or left it, the database returns nothing and this screen shows ONE
 * combined "not available" message, so it never reveals whether a trip exists. Only genuine
 * connection problems get a different message (with Try again).
 */
export default function TripDetailsScreen() {
  const params = useLocalSearchParams<{ tripId?: string | string[] }>();
  const tripId = (Array.isArray(params.tripId) ? params.tripId[0] : params.tripId) ?? '';
  const router = useRouter();
  const { data, error, isPending, refetch, isFetching } = useTripDetails(tripId);

  return (
    <Screen>
      <View style={{ marginTop: spacing.md }}>
        <Link href="/" accessibilityRole="link" testID="trip-back-home">
          <AppText tone="brand" style={{ fontWeight: '600' }}>
            ← Home
          </AppText>
        </Link>
      </View>

      {isPending && (
        <AppText tone="secondary" testID="trip-loading">
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

      {data && <Details details={data} />}
    </Screen>
  );
}

function Details({ details }: { details: TripDetails }) {
  const { trip, members, creatorName, lengthDays } = details;
  const userId = useUserId();
  const { colors } = useTheme();
  // "Today" and the trip's dates are both plain calendar days, so this comparison has no time-zone surprises.
  const phase = tripPhase(trip.startDate, trip.endDate, todayIso());
  const creatorIsMe = userId !== null && members.some((m) => m.userId === userId && m.userId === trip.createdBy);

  return (
    <>
      <View style={{ gap: spacing.sm }}>
        <AppText variant="title" testID="trip-title">
          {trip.name}
        </AppText>
        <AppText tone="secondary" testID="trip-destination">
          {trip.destination}
        </AppText>
        <PhaseBadge phase={phase} />
      </View>

      {trip.status === 'archived' && (
        <Banner kind="info" testID="trip-archived">
          This trip is archived.
        </Banner>
      )}

      <Card>
        <AppText variant="heading">When</AppText>
        <AppText testID="trip-dates">{formatDateRange(trip.startDate, trip.endDate)}</AppText>
        {lengthDays !== null && (
          <AppText variant="small" tone="secondary" testID="trip-length">
            {daysLabel(lengthDays)}
          </AppText>
        )}
      </Card>

      <Card>
        <AppText variant="heading">About</AppText>
        <Field label="Description" testID="trip-description" value={trip.description ?? 'No description'} muted={trip.description === null} />
        <Field
          label="Budget"
          testID="trip-budget"
          value={trip.budgetMinor !== null ? formatMoney(trip.budgetMinor, trip.currency) : 'No budget set'}
          muted={trip.budgetMinor === null}
        />
        <Field label="Currency" testID="trip-currency" value={trip.currency} />
      </Card>

      <Card>
        <AppText variant="heading">{`People (${members.length})`}</AppText>
        <AppText variant="small" tone="secondary" testID="trip-creator">
          {creatorIsMe ? 'Created by you' : creatorName ? `Created by ${creatorName}` : 'Created by a former member'}
        </AppText>
        <View style={{ gap: spacing.sm }} testID="trip-people">
          {members.map((m) => (
            <View
              key={m.id}
              testID={`member-${m.id}`}
              style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }}
            >
              <AppText>{m.displayName}</AppText>
              {m.role === 'admin' && <Tag label="Admin" color={colors.primary} />}
              {m.userId !== null && m.userId === userId && <Tag label="You" color={colors.textSecondary} />}
              {m.isGuest && <Tag label="Guest" color={colors.textSecondary} />}
            </View>
          ))}
        </View>
      </Card>
    </>
  );
}

function Field({ label, value, testID, muted = false }: { label: string; value: string; testID: string; muted?: boolean }) {
  return (
    <View style={{ gap: 2 }}>
      <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
        {label}
      </AppText>
      <AppText tone={muted ? 'secondary' : 'primary'} testID={testID}>
        {value}
      </AppText>
    </View>
  );
}

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 999, paddingHorizontal: spacing.sm, paddingVertical: 1 }}>
      <AppText variant="small" style={{ color, fontWeight: '600' }}>
        {label}
      </AppText>
    </View>
  );
}
