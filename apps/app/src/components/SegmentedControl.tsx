import { Pressable, Text, View } from 'react-native';
import { fontSize, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  /** Spoken by screen readers, e.g. "Theme". */
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  testIDPrefix?: string;
}

/** A row of choices where exactly one is selected (like radio buttons). Wraps onto more lines if needed. */
export function SegmentedControl<T extends string>({ label, options, value, onChange, testIDPrefix }: Props<T>) {
  const { colors } = useTheme();
  return (
    <View role="radiogroup" aria-label={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            testID={testIDPrefix ? `${testIDPrefix}-${o.value}` : undefined}
            onPress={() => onChange(o.value)}
            role="radio"
            aria-label={o.label}
            aria-checked={selected}
            style={{
              minHeight: 44,
              minWidth: 72,
              paddingHorizontal: spacing.md,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: selected ? colors.primary : colors.border,
              backgroundColor: selected ? colors.primary : colors.surface,
            }}
          >
            <Text style={{ color: selected ? colors.onPrimary : colors.textPrimary, fontSize: fontSize.body, fontWeight: selected ? '600' : '400' }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
