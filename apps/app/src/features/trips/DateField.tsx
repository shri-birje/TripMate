import { useState } from 'react';
import { Pressable } from 'react-native';
import { applyDateEdit, isoToDmy, parseDateInput } from '@tripmate/core';
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
  /** The calendar will not let days after this ISO day be chosen (used for an expense, which must fall inside the trip). */
  maxIso?: string | null;
  /** When true, typing and pasting are limited to days between minIso and maxIso, exactly like the calendar. */
  limitTyping?: boolean;
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
export function DateField({ label, value, onChangeText, error, helper, placeholder, testID, minIso = null, maxIso = null, limitTyping = false, initialViewIso = null }: Props) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  // Only set when the formatting moved the cursor somewhere other than where the browser/phone put it.
  const [forcedCursor, setForcedCursor] = useState<{ start: number; end: number } | undefined>(undefined);

  function handleChange(next: string) {
    // Impossible dates (day 32, month 13, 29 February in a common year, and with limitTyping any day outside the trip) are
    // refused here, while typing and pasting. A refused edit leaves the box as it was. Removing text is always allowed.
    const range = limitTyping && minIso && maxIso ? { minIso, maxIso } : undefined;
    const shaped = applyDateEdit(value, next, range);
    if (shaped === null) return;
    onChangeText(shaped.text);
    // The cursor only needs steering when the reshaping moved it away from where the browser or phone put it AND it is not simply at the end
    // (at the end, setting the new text already leaves the cursor there; forcing a selection then can swallow the next key press).
    const typedCursor = shaped.cursor;
    const atEnd = typedCursor === shaped.text.length;
    setForcedCursor(shaped.text === next || atEnd ? undefined : { start: typedCursor, end: typedCursor });
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
        maxIso={maxIso}
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
