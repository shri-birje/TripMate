import { Text, type TextProps } from 'react-native';
import { fontFamily } from '../theme/fonts';
import { fontSize } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { useSurface } from './Surface';

type Variant = 'title' | 'heading' | 'body' | 'small' | 'eyebrow';
type Tone = 'primary' | 'secondary' | 'brand' | 'error' | 'ok' | 'warn' | 'accent';

interface Props extends TextProps {
  variant?: Variant;
  tone?: Tone;
}

const SIZE: Record<
  Variant,
  { fontSize: number; fontWeight: '400' | '600' | '700'; lineHeight: number; fontFamily?: string | undefined; letterSpacing?: number; textTransform?: 'uppercase' }
> = {
  title: { fontSize: fontSize.title, fontWeight: '700', lineHeight: 34, fontFamily: fontFamily.heading, letterSpacing: -0.2 },
  heading: { fontSize: 20, fontWeight: '700', lineHeight: 26, fontFamily: fontFamily.heading },
  body: { fontSize: fontSize.body, fontWeight: '400', lineHeight: 22, fontFamily: fontFamily.body },
  small: { fontSize: fontSize.small, fontWeight: '400', lineHeight: 18, fontFamily: fontFamily.body },
  eyebrow: { fontSize: 12, fontWeight: '700', lineHeight: 16, fontFamily: fontFamily.body, letterSpacing: 1, textTransform: 'uppercase' },
};

/** All text goes through this so size, weight, font and colour stay consistent and follow the theme. */
export function AppText({ variant = 'body', tone = 'primary', style, ...rest }: Props) {
  const { colors } = useTheme();
  const onSurface = useSurface() === 'surface';
  const color = {
    primary: colors.textPrimary,
    secondary: onSurface ? colors.textSecondaryOnSurface : colors.textSecondary,
    brand: colors.primaryText,
    error: onSurface ? colors.statusErrorOnSurface : colors.statusError,
    ok: onSurface ? colors.statusOkOnSurface : colors.statusOk,
    warn: onSurface ? colors.statusWarnOnSurface : colors.statusWarn,
    accent: colors.woodText,
  }[tone];
  return <Text {...rest} style={[SIZE[variant], { color }, style]} />;
}
