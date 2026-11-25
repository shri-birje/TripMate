import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { daysLabel, formatDateRange, isTripAdmin, tripPhase, type TripDetails } from '@tripmate/core';
import { AppText } from '../../../../components/AppText';
import { Banner } from '../../../../components/Banner';
import { Button } from '../../../../components/Button';
import { Card } from '../../../../components/Card';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { Screen } from '../../../../components/Screen';
import { useUserId } from '../../../../features/auth/AuthProvider';
import { ExpensesCard } from '../../../../features/trips/ExpensesCard';
import { PeopleCard } from '../../../../features/trips/PeopleCard';
import { PhaseBadge } from '../../../../features/trips/PhaseBadge';
import { useTripDetails } from '../../../../features/trips/tripDetailsApi';
import { useSetTripArchived } from '../../../../features/trips/tripEditApi';
import { TripEditError } from '../../../../features/trips/tripEditService';
import { formatMoney } from '../../../../lib/format';
import { todayIso } from '../../../../lib/today';
import { useTheme } from '../../../../theme/ThemeProvider';
import { spacing } from '../../../../theme/tokens';

/**
 * Trip Details: what you know about a trip you are on.
 *
 * Who may open a trip is decided by the database. If the trip is unknown, not yours, or you
 * were removed from it or left it, the database returns nothing and this screen shows ONE
 * combined "not available" message, so it never reveals whether a trip exists. Only genuine
 * connection problems get a different message (with Try again).
 *
 * Administrators also see Edit / Archive / Restore here. Hiding these from other people is a
 * convenience only: the database refuses the actions unless the caller is an active administrator.
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

      {data && <Details details={data} reload={() => void refetch()} />}
    </Screen>
  );
}

type Pending = 'archive' | 'restore' | null;

function Details({ details, reload }: { details: TripDetails; reload: () => void }) {
  const { trip, lengthDays } = details;
  const router = useRouter();
  const userId = useUserId();
  const { colors } = useTheme();
  // "Today" and the trip's dates are both plain calendar days, so this comparison has no time-zone surprises.
  const phase = tripPhase(trip.startDate, trip.endDate, todayIso());
  const isAdmin = isTripAdmin(details, userId);
  const archived = trip.status === 'archived';

  const setArchived = useSetTripArchived(trip.id);
  // Guards against two taps landing before `setArchived.isPending` has re-rendered the button
  // disabled: a ref updates immediately, a render does not.
  const submitting = useRef(false);
  const [pending, setPending] = useState<Pending>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<TripEditError | null>(null);

  function openDialog(which: Exclude<Pending, null>) {
    setDialogError(null);
    setNotice(null);
    setActionError(null);
    setPending(which);
  }

  function confirm() {
    if (!pending || submitting.current) return; // ignore a second tap while saving
    submitting.current = true;
    const doing = pending;
    setArchived.mutate(
      { tripId: trip.id, archived: doing === 'archive', expectedVersion: trip.version },
      {
        onSuccess: () => {
          submitting.current = false;
          setPending(null);
          setNotice(doing === 'archive' ? 'Trip archived.' : 'Trip restored.');
        },
        onError: (e) => {
          submitting.current = false;
          // A connection problem can simply be retried from the same dialog. Everything else
          // (someone changed the trip, your rights changed...) closes it and explains on the page.
          if (e.kind === 'network' || e.kind === 'unknown') {
            setDialogError(e.message);
          } else {
            setPending(null);
            setActionError(e);
          }
        },
      },
    );
  }

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

      {archived && (
        <Banner kind="info" testID="trip-archived">
          This trip is archived.
        </Banner>
      )}

      {notice && (
        <Banner kind="success" testID="trip-notice">
          {notice}
        </Banner>
      )}

      {actionError && (
        <Card>
          <Banner kind="error" testID="trip-action-error">
            {actionError.message}
          </Banner>
          <Button testID="trip-reload" label="Reload latest" variant="secondary" onPress={() => { setActionError(null); reload(); }} />
        </Card>
      )}

      {isAdmin ? (
        <Card>
          <AppText variant="heading">Manage trip</AppText>
          {!archived ? (
            <>
              <Button testID="trip-edit" label="Edit trip" onPress={() => router.push(`/trips/${trip.id}/edit`)} />
              <Button testID="trip-archive" label="Archive trip" variant="secondary" onPress={() => openDialog('archive')} />
            </>
          ) : (
            <Button testID="trip-restore" label="Restore trip" onPress={() => openDialog('restore')} />
          )}
        </Card>
      ) : (
        <AppText variant="small" tone="secondary" testID="trip-members-note">
          Only trip admins can edit, archive or restore this trip.
        </AppText>
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

      <ExpensesCard details={details} userId={userId} />

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

      <PeopleCard details={details} userId={userId} reload={reload} onLeft={() => router.replace('/')} />

      <ConfirmDialog
        visible={pending !== null}
        title={pending === 'restore' ? 'Restore this trip?' : 'Archive this trip?'}
        message={
          pending === 'restore'
            ? `Restore "${trip.name}"? It returns to your active trips, in the group its dates belong to. Nothing else about the trip changes.`
            : `Archive "${trip.name}"? It leaves your active trips. Nothing is deleted: history and expenses are kept, and you can restore it later.`
        }
        confirmLabel={pending === 'restore' ? 'Restore trip' : 'Archive trip'}
        busy={setArchived.isPending}
        error={dialogError}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
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
