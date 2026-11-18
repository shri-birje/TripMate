import { TRIP_DESCRIPTION_MAX, parseDateInput, type TripFormValues } from '@tripmate/core';
import { TextField } from '../../components/TextField';
import { DateField } from './DateField';

interface Props {
  values: TripFormValues;
  onChange: (field: keyof TripFormValues, value: string) => void;
  errors: Record<string, string>;
  /** Shown in the budget hint ("in INR"). */
  currency: string;
}

/**
 * The six trip fields shared by the Create and Edit screens: name, destination,
 * start date, end date, description and budget. Currency is handled by each
 * screen (chosen when creating, fixed when editing). Rendered as a fragment so
 * the surrounding card lays them out exactly as before.
 */
export function TripFormFields({ values, onChange, errors, currency }: Props) {
  // The real dates currently typed, if any. They steer the calendars: the end date's calendar opens on the
  // start date's month and will not offer earlier days; the start date's calendar opens on the end date's month.
  const startIso = parseDateInput(values.startDate);
  const endIso = parseDateInput(values.endDate);
  return (
    <>
      <TextField
        testID="trip-name"
        label="Trip name"
        value={values.name}
        onChangeText={(v) => onChange('name', v)}
        error={errors.name}
        placeholder="Goa Trip 2026"
        autoCapitalize="words"
        returnKeyType="next"
        maxLength={120}
      />
      <TextField
        testID="trip-destination"
        label="Destination"
        value={values.destination}
        onChangeText={(v) => onChange('destination', v)}
        error={errors.destination}
        placeholder="Goa, India"
        autoCapitalize="words"
        returnKeyType="next"
        maxLength={120}
      />
      {/* Dates: typed (slashes inserted automatically, digits only) or chosen from a calendar. Both write to the same text. */}
      <DateField
        testID="trip-start"
        label="Start date"
        value={values.startDate}
        onChangeText={(v) => onChange('startDate', v)}
        error={errors.startDate}
        helper="Day / month / year"
        placeholder="27/12/2026"
        initialViewIso={endIso}
      />
      <DateField
        testID="trip-end"
        label="End date"
        value={values.endDate}
        onChangeText={(v) => onChange('endDate', v)}
        error={errors.endDate}
        placeholder="30/12/2026"
        minIso={startIso}
        initialViewIso={startIso}
      />
      <TextField
        testID="trip-description"
        label="Description (optional)"
        value={values.description}
        onChangeText={(v) => onChange('description', v)}
        error={errors.description}
        multiline
        maxLength={TRIP_DESCRIPTION_MAX + 50}
      />
      <TextField
        testID="trip-budget"
        label="Estimated budget (optional)"
        value={values.budget}
        onChangeText={(v) => onChange('budget', v)}
        error={errors.budget}
        helper={`For the whole group, in ${currency}. For example 60000.`}
        placeholder="60000"
        autoCapitalize="none"
        keyboardType="numbers-and-punctuation"
      />
    </>
  );
}
