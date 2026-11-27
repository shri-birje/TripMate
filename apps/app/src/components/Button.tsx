import { ActivityIndicator, Pressable, Text } from 'react-native';
import { fontFamily } from '../theme/fonts';
import { fontSize, radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';

interface Props {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function Button({ label, onPress, variant = 'primary', loading = false, disabled = false, testID }: Props) {
  const { colors } = useTheme();
  const inactive = disabled || loading;
  // Flat tonal fills (no borders): primary = forest, secondary = sand, ghost = text only.
  const background = variant === 'primary' ? colors.primary : variant === 'secondary' ? colors.surface2 : 'transparent';
  const textColor = variant === 'primary' ? colors.onPrimary : variant === 'secondary' ? colors.textPrimary : colors.primary;

  return (
    <Pressable
      testID={testID}
      onPress={inactive ? undefined : onPress}
      disabled={inactive}
      role="button"
      aria-label={label}
      aria-disabled={inactive}
      aria-busy={loading}
      style={({ pressed }) => ({
        minHeight: 48, // comfortable touch target
        paddingHorizontal: spacing.md,
        borderRadius: radius.md,
        backgroundColor: background,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: spacing.sm,
        opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
      })}
    >
      {loading && <ActivityIndicator color={textColor} />}
      <Text style={{ color: textColor, fontSize: fontSize.body, fontWeight: '700', fontFamily: fontFamily.body }}>{label}</Text>
    </Pressable>
  );
}
