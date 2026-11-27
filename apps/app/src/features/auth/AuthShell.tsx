import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText } from '../../components/AppText';
import { Screen } from '../../components/Screen';
import { TripScene } from '../../components/TripScene';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';
import { Brand, SiteFooter, SiteTopBar } from '../site/SiteParts';

/** The wording on the website's sign-in and sign-up pages (the native app keeps its own short headings). */
export const AUTH_HEADLINE = 'Make memories, not money disputes.';
export const AUTH_SUPPORT = 'Plan the trip, split the costs fairly and see who owes whom, all in one place.';

interface Props {
  /** Heading shown above the form (the native app shows it in brand colour). */
  title: string;
  subtitle: string;
  /** Heading and line for the native app, when they differ from the website's. */
  nativeTitle?: string;
  nativeSubtitle?: string;
  children: ReactNode;
}

/**
 * Frame for the sign-in and sign-up forms.
 *  - Phones (native app): the simple mobile-first layout, exactly as before.
 *  - Website, wide window: two halves. Left, TripMate branding, a headline and a travel collage; right, the form.
 *  - Website, narrow window (including a phone's browser): one column with the form first and a compact travel picture above it.
 * The website versions carry the shared footer but no appearance switch: they inherit the appearance chosen on the landing page. The form itself (fields, validation,
 * sign-in and sign-up calls) is passed in unchanged.
 */
export function AuthShell({ title, subtitle, nativeTitle, nativeSubtitle, children }: Props) {
  if (Platform.OS !== 'web') {
    return (
      <Screen>
        <View style={{ marginTop: spacing.xl, gap: spacing.xs }}>
          <AppText variant="title" tone="brand">
            {nativeTitle ?? title}
          </AppText>
          <AppText tone="secondary">{nativeSubtitle ?? subtitle}</AppText>
        </View>
        {children}
      </Screen>
    );
  }
  return <WebAuthShell title={title} subtitle={subtitle}>{children}</WebAuthShell>;
}

function WebAuthShell({ title, subtitle, children }: Props) {
  const router = useRouter();
  const { colors } = useTheme();
  const { width } = useWindowDimensions();
  const split = width >= 900;
  const toWelcome = () => router.replace('/welcome');

  const form = (
    <View style={{ width: '100%', maxWidth: 420, gap: spacing.md }} testID="auth-form-panel">
      <View style={{ gap: spacing.xs }}>
        <AppText variant="title" role="heading" aria-level={1} testID="auth-title">
          {title}
        </AppText>
        <AppText tone="secondary">{subtitle}</AppText>
      </View>
      {children}
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView testID="auth-page" contentContainerStyle={{ flexGrow: 1 }}>
        {split ? (
          <View style={{ flexDirection: 'row', flexGrow: 1, minHeight: 680 }}>
            {/* Left: branding and the travel experience */}
            <View testID="auth-brand-panel" style={{ flex: 1.1, backgroundColor: colors.surface, padding: spacing.xl + spacing.md, justifyContent: 'center', gap: spacing.xl }}>
              <Brand size="big" />
              <View style={{ gap: spacing.md, maxWidth: 560 }}>
                <AppText variant="title" role="heading" aria-level={2} testID="auth-headline" style={{ fontSize: 48, lineHeight: 54, letterSpacing: -0.8 }}>
                  {AUTH_HEADLINE}
                </AppText>
                <AppText tone="secondary" style={{ fontSize: 18, lineHeight: 27 }}>
                  {AUTH_SUPPORT}
                </AppText>
              </View>
              <View style={{ flexDirection: 'row', gap: spacing.md, maxWidth: 560 }} testID="auth-collage">
                <View style={{ flex: 1.4 }}>
                  <TripScene kind="mountain" height={236} radiusAll={radius.lg} />
                </View>
                <View style={{ flex: 1, gap: spacing.md }}>
                  <TripScene kind="coast" height={110} radiusAll={radius.lg} />
                  <TripScene kind="forest" height={110} radiusAll={radius.lg} />
                </View>
              </View>
            </View>
            {/* Right: the form */}
            <View style={{ flex: 1, padding: spacing.xl, justifyContent: 'center', alignItems: 'center' }}>{form}</View>
          </View>
        ) : (
          <View style={{ flexGrow: 1 }}>
            <SiteTopBar showTheme={false} />
            <View style={{ alignItems: 'center', padding: spacing.lg, gap: spacing.lg }}>
              <View style={{ width: '100%', maxWidth: 420 }} testID="auth-compact-visual">
                <TripScene kind="mountain" height={110} radiusAll={radius.lg} />
              </View>
              {form}
            </View>
          </View>
        )}
        <SiteFooter onFeatures={toWelcome} onHow={toWelcome} />
      </ScrollView>
    </SafeAreaView>
  );
}
