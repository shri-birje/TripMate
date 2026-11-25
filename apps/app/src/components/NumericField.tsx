import { filterNumericInput, type NumericKind } from '@tripmate/core';
import { TextField } from './TextField';

interface Props {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  /** money: digits and one point, two decimals. percent: the same, 0 to 100. shares: whole numbers only. */
  kind: NumericKind;
  error?: string | undefined;
  helper?: string | undefined;
  placeholder?: string | undefined;
  testID?: string;
}

/**
 * A number box that only ever holds text a number can be made from. Every change (keys, paste, drop, autofill) goes through the shared
 * filter in the core package, so desktop, phone and pasted input behave the same. The phone keyboard hint (decimal pad or number pad)
 * is only a convenience: the filter, not the keyboard, decides what is accepted. Save-time checks still run again on the text.
 */
export function NumericField({ kind, onChangeText, value, ...rest }: Props) {
  return (
    <TextField
      {...rest}
      value={value}
      onChangeText={(next) => onChangeText(filterNumericInput(kind, value, next))}
      autoCapitalize="none"
      keyboardType={kind === 'shares' ? 'number-pad' : 'decimal-pad'}
      inputMode={kind === 'shares' ? 'numeric' : 'decimal'}
    />
  );
}
