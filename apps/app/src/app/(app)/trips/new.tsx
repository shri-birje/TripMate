import { Link, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { SUPPORTED_CURRENCIES, type CurrencyCode, type TripFormValues } from '@tripmate/core';
import { AppText } from '../../../components/AppText';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Screen } from '../../../components/Screen';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useProfile } from '../../../features/profile/profileApi';
import { TripFormFields } from '../../../features/trips/TripFormFields';
import { useCreateTrip } from '../../../features/trips/tripApi';
import { TripError } from '../../../features/trips/tripService';
import { spacing } from '../../../theme/tokens';

const CURRENCY_OPTIONS = SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }));

/** Create a trip. The person who creates it becomes its administrator. */
export default function NewTripScreen() {
  const router = useRouter();
  const { data: profile } = useProfile();
  const create = useCreateTrip();
  // Guards against two taps landing before `create.isPending` has re-rendered the button
  // disabled: a ref updates immediately, a render does not.
  const submitting = useRef(false);

  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [description, setDescription] = useState('');
  const [budget, setBudget] = useState('');
  // Start from the currency chosen in the profile (INR for most people), but let them change it for this trip.
  const [currencyChoice, setCurrencyChoice] = useState<CurrencyCode | null>(null);
  const profileCurrency = (SUPPORTED_CURRENCIES as readonly string[]).includes(profile?.preferredCurrency ?? '')
    ? (profile!.preferredCurrency as CurrencyCode)
    : 'INR';
  const currency = currencyChoice ?? profileCurrency;

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  // The six shared fields are drawn by <TripFormFields>; this maps each one back to its own state.
  const values: TripFormValues = { name, destination, startDate, endDate, description, budget };
  const setters: Record<keyof TripFormValues, (v: string) => void> = {
    name: setName, destination: setDestination, startDate: setStartDate, endDate: setEndDate, description: setDescription, budget: setBudget,
  };

  async function submit() {
    if (submitting.current) return; // ignore a second tap while saving
    submitting.current = true;
    setFieldErrors({});
    setFormError(null);
    try {
      await create.mutateAsync({ name, destination, startDate, endDate, description, budget, currency });
      router.replace('/'); // back to Home, where the new trip now appears
    } catch (e) {
      if (e instanceof TripError) {
        setFieldErrors(e.fieldErrors ?? {});
        setFormError(e.fieldErrors ? null : e.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      submitting.current = false;
    }
  }

  return (
    <Screen>
      <View style={{ marginTop: spacing.md, gap: spacing.xs }}>
        <Link href="/" accessibilityRole="link">
          <AppText tone="brand" style={{ fontWeight: '600' }}>
            ← Home
          </AppText>
        </Link>
        <AppText variant="title">New trip</AppText>
        <AppText tone="secondary">You will be the trip&apos;s administrator and can invite friends afterwards.</AppText>
      </View>

      <Card>
        {formError && (
          <Banner kind="error" testID="form-error">
            {formError}
          </Banner>
        )}
        <TripFormFields values={values} onChange={(field, value) => setters[field](value)} errors={fieldErrors} currency={currency} />
        <View style={{ gap: spacing.sm }}>
          <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
            Currency
          </AppText>
          <SegmentedControl label="Currency" testIDPrefix="trip-currency" options={CURRENCY_OPTIONS} value={currency} onChange={setCurrencyChoice} />
          {fieldErrors.currency && (
            <AppText variant="small" tone="error">
              {fieldErrors.currency}
            </AppText>
          )}
        </View>
        <Button testID="create-trip-submit" label="Create trip" onPress={submit} loading={create.isPending} />
      </Card>
    </Screen>
  );
}
