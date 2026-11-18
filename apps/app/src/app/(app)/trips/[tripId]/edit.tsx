import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { isTripAdmin, tripToFormValues, type TripDetails, type TripFormValues } from '@tripmate/core';
import { AppText } from '../../../../components/AppText';
import { Banner } from '../../../../components/Banner';
import { Button } from '../../../../components/Button';
import { Card } from '../../../../components/Card';
import { Screen } from '../../../../components/Screen';
import { useUserId } from '../../../../features/auth/AuthProvider';
import { TripFormFields } from '../../../../features/trips/TripFormFields';
import { useTripDetails } from '../../../../features/trips/tripDetailsApi';
import { useUpdateTrip } from '../../../../features/trips/tripEditApi';
import { TripEditError } from '../../../../features/trips/tripEditService';
import { spacing } from '../../../../theme/tokens';

/**
 * Edit a trip (administrators only; archived trips are read-only).
 *
 * The screen hides the form from people who are not administrators, but that is a convenience:
 * the database refuses the change unless the caller is an active administrator.
 *
 * CONCURRENCY: the form remembers the version of the trip it STARTED from. If someone else
 * changed the trip in the meantime the database refuses the save (nothing is overwritten)
 * and offers "Reload latest".
 */
export default function EditTripScreen() {
  const params = useLocalSearchParams<{ tripId?: string | string[] }>();
  const tripId = (Array.isArray(params.tripId) ? params.tripId[0] : params.tripId) ?? '';
  const router = useRouter();
  const { data, error, isPending, refetch, isFetching } = useTripDetails(tripId);

  return (
    <Screen>
      <View style={{ marginTop: spacing.md, gap: spacing.xs }}>
        <Link href={`/trips/${tripId}`} accessibilityRole="link" testID="edit-back">
          <AppText tone="brand" style={{ fontWeight: '600' }}>
            ← Back to trip
          </AppText>
        </Link>
        <AppText variant="title">Edit trip</AppText>
      </View>

      {isPending && (
        <AppText tone="secondary" testID="edit-loading">
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

      {data && <EditSection key={data.trip.id} details={data} refetchDetails={refetch} />}
    </Screen>
  );
}

function EditSection({ details, refetchDetails }: { details: TripDetails; refetchDetails: () => Promise<{ data?: TripDetails }> }) {
  const { trip } = details;
  const router = useRouter();
  const userId = useUserId();
  const update = useUpdateTrip(trip.id);
  // Guards against two taps landing before `update.isPending` has re-rendered the button
  // disabled: a ref updates immediately, a render does not.
  const submitting = useRef(false);

  // What the person started from: the form's initial text AND the version it came from.
  const [base, setBase] = useState(() => ({ version: trip.version, values: tripToFormValues(trip) }));
  const [values, setValues] = useState<TripFormValues>(base.values);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const dirty = JSON.stringify(values) !== JSON.stringify(base.values);
  const backToTrip = () => router.replace(`/trips/${trip.id}`);

  if (trip.status === 'archived') {
    return (
      <Card>
        <Banner kind="info" testID="edit-archived">
          This trip is archived. Restore it from the trip page to make changes.
        </Banner>
        <Button testID="edit-archived-back" label="Back to trip" variant="secondary" onPress={backToTrip} />
      </Card>
    );
  }

  if (!isTripAdmin(details, userId)) {
    return (
      <Card>
        <Banner kind="info" testID="edit-not-admin">
          Only trip admins can edit this trip.
        </Banner>
        <Button testID="edit-not-admin-back" label="Back to trip" variant="secondary" onPress={backToTrip} />
      </Card>
    );
  }

  async function save() {
    if (submitting.current || !dirty) return; // ignore a second tap while saving
    submitting.current = true;
    setFieldErrors({});
    setFormError(null);
    setConflict(false);
    try {
      await update.mutateAsync({ tripId: trip.id, expectedVersion: base.version, currency: trip.currency, form: values });
      backToTrip(); // the trip page shows the new details
    } catch (e) {
      if (e instanceof TripEditError) {
        setFieldErrors(e.fieldErrors ?? {});
        setFormError(e.fieldErrors ? null : e.message);
        setConflict(e.kind === 'conflict');
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      submitting.current = false;
    }
  }

  /** Throws away what was typed and starts again from the latest saved version of the trip. */
  async function reloadLatest() {
    const result = await refetchDetails();
    const latest = result.data;
    if (!latest) return;
    const fresh = { version: latest.trip.version, values: tripToFormValues(latest.trip) };
    setBase(fresh);
    setValues(fresh.values);
    setFieldErrors({});
    setFormError(null);
    setConflict(false);
  }

  return (
    <Card>
      {formError && (
        <Banner kind="error" testID="form-error">
          {formError}
        </Banner>
      )}
      {conflict && <Button testID="edit-reload" label="Reload latest" variant="secondary" onPress={() => void reloadLatest()} />}
      <TripFormFields
        values={values}
        onChange={(field, value) => setValues((v) => ({ ...v, [field]: value }))}
        errors={fieldErrors}
        currency={trip.currency}
      />
      <View style={{ gap: spacing.xs }}>
        <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
          Currency
        </AppText>
        <AppText testID="edit-currency">{trip.currency}</AppText>
        <AppText variant="small" tone="secondary">
          Fixed when the trip is created, so amounts always mean the same thing.
        </AppText>
      </View>
      <Button testID="edit-save" label="Save changes" onPress={() => void save()} loading={update.isPending} disabled={!dirty} />
      <Button testID="edit-cancel" label="Cancel" variant="secondary" onPress={backToTrip} />
    </Card>
  );
}
