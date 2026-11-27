import { Pressable, Text, View } from 'react-native';
import { fontSize, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { useSurface } from './Surface';

interface Props {
  label: string;
  checked: boolean;
  onToggle: () => void;
  /** A second, quieter line (for example "Guest"). */
  note?: string;
  disabled?: boolean;
  testID?: string;
}

/** A tappable row with a tick box (a checkbox for screen readers). At least 44 points tall, so it is easy to hit on a phone. */
export function CheckRow({ label, checked, onToggle, note, disabled = false, testID }: Props) {
  const { colors } = useTheme();
  const quiet = useSurface() === 'surface' ? colors.textSecondaryOnSurface : colors.textSecondary;
  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onToggle}
      disabled={disabled}
      role="checkbox"
      aria-label={label}
      aria-checked={checked}
      aria-disabled={disabled}
      style={{
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.xs,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: radius.md / 2,
          borderWidth: 1.5,
          borderColor: checked ? colors.primary : quiet,
          backgroundColor: checked ? colors.primary : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked && <Text style={{ color: colors.onPrimary, fontSize: fontSize.small, fontWeight: '700' }}>✓</Text>}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.textPrimary, fontSize: fontSize.body }}>{label}</Text>
        {note ? <Text style={{ color: quiet, fontSize: fontSize.small }}>{note}</Text> : null}
      </View>
    </Pressable>
  );
}
