import { useState } from 'react';
import { Pressable } from 'react-native';
import { formatDateInput, isoToDmy, parseDateInput, rawCursorAfterEdit } from '@tripmate/core';
import { CalendarIcon } from '../../components/CalendarIcon';
import { DatePickerModal } from '../../components/DatePickerModal';
import { TextField } from '../../components/TextField';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

interface Props {
  label: string;
  /** The text in the box, DD/MM/YYYY (possibly partial while typing). */
  value: string;
  onChangeText: (value: string) => void;
  error?: string | undefined;
  helper?: string | undefined;
  placeholder?: string | undefined;
  testID: string;
  /** The calendar will not let days before this ISO day be chosen (used for the end date). */
  minIso?: string | null;
  /** Which month the calendar opens on when the box does not hold a real date yet. */
  initialViewIso?: string | null;
}

/**
 * A date box with a calendar button.
 *
 *  - Typing and pasting: every change is reshaped into DD/MM/YYYY (slashes inserted, anything
 *    but digits rejected) and the cursor is kept where the person is editing.
 *  - Calendar: opens on the date in the box and writes the chosen date back into the box.
 *    The box and the calendar always agree, because the box is the single source of truth.
 *
 * Shaping the text never judges it: the existing validation still decides whether a date is real.
 */
export function DateField({ label, value, onChangeText, error, helper, placeholder, testID, minIso = null, initialViewIso = null }: Props) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  // Only set when the formatting moved the cursor somewhere other than where the browser/phone put it.
  const [forcedCursor, setForcedCursor] = useState<{ start: number; end: number } | undefined>(undefined);

  function handleChange(next: string) {
    const typedCursor = rawCursorAfterEdit(value, next);
    const shaped = formatDateInput(next, typedCursor);
    onChangeText(shaped.text);
    // If the text is exactly what was typed and the cursor is where it was typed, leave the cursor alone.
    const untouched = shaped.text === next && shaped.cursor === typedCursor;
    setForcedCursor(untouched ? undefined : { start: shaped.cursor, end: shaped.cursor });
  }

  const chosen = parseDateInput(value); // an ISO day if the box holds a real date, otherwise null

  return (
    <>
      <TextField
        testID={testID}
        label={label}
        value={value}
        onChangeText={handleChange}
        error={error}
        helper={helper}
        placeholder={placeholder}
        autoCapitalize="none"
        keyboardType="number-pad"
        inputMode="numeric"
        returnKeyType="next"
        selection={forcedCursor}
        onSelectionChange={(e) => {
          const s = e.nativeEvent.selection;
          // The person moved the cursor themselves: stop steering it.
          if (forcedCursor && (s.start !== forcedCursor.start || s.end !== forcedCursor.end)) setForcedCursor(undefined);
        }}
        trailing={
          <Pressable
            testID={`${testID}-calendar`}
            onPress={() => setOpen(true)}
            role="button"
            aria-label={`Choose ${label.toLowerCase()} from a calendar`}
            hitSlop={6}
            style={{ minHeight: 46, minWidth: 46, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm }}
          >
            <CalendarIcon color={colors.primary} />
          </Pressable>
        }
      />
      <DatePickerModal
        visible={open}
        title={label}
        selectedIso={chosen}
        minIso={minIso}
        initialViewIso={initialViewIso}
        onSelect={(iso) => {
          onChangeText(isoToDmy(iso));
          setForcedCursor(undefined);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
