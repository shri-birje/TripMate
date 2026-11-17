import { View } from 'react-native';
import { radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';

interface Props {
  kind: 'error' | 'success' | 'info';
  children: string;
  testID?: string;
}

/** A short message box. Errors are announced to screen readers straight away. */
export function Banner({ kind, children, testID }: Props) {
  const { colors } = useTheme();
  const accent = kind === 'error' ? colors.statusError : kind === 'success' ? colors.statusOk : colors.primary;
  return (
    <View
      testID={testID}
      role={kind === 'error' ? 'alert' : undefined}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      style={{
        padding: spacing.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: accent,
        backgroundColor: colors.surface,
      }}
    >
      <AppText variant="small" style={{ color: accent, fontWeight: '600' }}>
        {children}
      </AppText>
    </View>
  );
}
