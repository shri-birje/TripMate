import { Text, type TextProps } from 'react-native';
import { fontSize } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';

type Variant = 'title' | 'heading' | 'body' | 'small';
type Tone = 'primary' | 'secondary' | 'brand' | 'error' | 'ok';

interface Props extends TextProps {
  variant?: Variant;
  tone?: Tone;
}

const SIZE: Record<Variant, { fontSize: number; fontWeight: '400' | '600' | '700'; lineHeight: number }> = {
  title: { fontSize: fontSize.title, fontWeight: '700', lineHeight: 34 },
  heading: { fontSize: fontSize.heading, fontWeight: '600', lineHeight: 24 },
  body: { fontSize: fontSize.body, fontWeight: '400', lineHeight: 22 },
  small: { fontSize: fontSize.small, fontWeight: '400', lineHeight: 18 },
};

/** All text goes through this so size, weight and colour stay consistent and follow the theme. */
export function AppText({ variant = 'body', tone = 'primary', style, ...rest }: Props) {
  const { colors } = useTheme();
  const color = {
    primary: colors.textPrimary,
    secondary: colors.textSecondary,
    brand: colors.primary,
    error: colors.statusError,
    ok: colors.statusOk,
  }[tone];
  return <Text {...rest} style={[SIZE[variant], { color }, style]} />;
}
