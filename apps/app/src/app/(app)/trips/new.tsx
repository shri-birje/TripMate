import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SUPPORTED_CURRENCIES, TRIP_DESCRIPTION_MAX, type CurrencyCode } from '@tripmate/core';
import { AppText } from '../../../components/AppText';
import { Banner } from '../../../components/Banner';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Screen } from '../../../components/Screen';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { TextField } from '../../../components/TextField';
import { useProfile } from '../../../features/profile/profileApi';
import { useCreateTrip } from '../../../features/trips/tripApi';
import { TripError } from '../../../features/trips/tripService';
import { spacing } from '../../../theme/tokens';

const CURRENCY_OPTIONS = SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }));

/** Create a trip. The person who creates it becomes its administrator. */
export default function NewTripScreen() {
  const router = useRouter();
  const { data: profile } = useProfile();
  const create = useCreateTrip();

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

  async function submit() {
    if (create.isPending) return; // ignore a second tap while saving
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
        <TextField
          testID="trip-name"
          label="Trip name"
          value={name}
          onChangeText={setName}
          error={fieldErrors.name}
          placeholder="Goa Trip 2026"
          autoCapitalize="words"
          returnKeyType="next"
          maxLength={120}
        />
        <TextField
          testID="trip-destination"
          label="Destination"
          value={destination}
          onChangeText={setDestination}
          error={fieldErrors.destination}
          placeholder="Goa, India"
          autoCapitalize="words"
          returnKeyType="next"
          maxLength={120}
        />
        <TextField
          testID="trip-start"
          label="Start date"
          value={startDate}
          onChangeText={setStartDate}
          error={fieldErrors.startDate}
          helper="Day / month / year"
          placeholder="27/12/2026"
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          returnKeyType="next"
        />
        <TextField
          testID="trip-end"
          label="End date"
          value={endDate}
          onChangeText={setEndDate}
          error={fieldErrors.endDate}
          placeholder="30/12/2026"
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          returnKeyType="next"
        />
        <TextField
          testID="trip-description"
          label="Description (optional)"
          value={description}
          onChangeText={setDescription}
          error={fieldErrors.description}
          multiline
          maxLength={TRIP_DESCRIPTION_MAX + 50}
        />
        <TextField
          testID="trip-budget"
          label="Estimated budget (optional)"
          value={budget}
          onChangeText={setBudget}
          error={fieldErrors.budget}
          helper={`For the whole group, in ${currency}. For example 60000.`}
          placeholder="60000"
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
        />
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
