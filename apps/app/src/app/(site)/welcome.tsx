import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppText } from '../../components/AppText';
import { Icon, type IconName } from '../../components/Icon';
import { TripScene } from '../../components/TripScene';
import { BalancesPreview, HomePreview, UpcomingPreview } from '../../features/site/PhonePreviews';
import { SITE_MAX, SectionHeading, SiteFooter, SiteHeader, useSiteWidth } from '../../features/site/SiteParts';
import { FEATURES, STEPS } from '../../features/site/siteContent';
import { StatusChip } from '../../features/trips/PhaseBadge';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';

const FEATURE_ICON = { route: 'route', users: 'users', split: 'split', scale: 'scale', link: 'link', clock: 'clock' } as const satisfies Record<string, IconName>;

/**
 * The public landing page (signed-out web visitors). Separate from the app screens: it has its own header, sections
 * and footer, and reads no account data. "Get started" and "Sign up" go to sign-up, "Log in" to sign-in.
 */
export default function WelcomeScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { wide, medium, width } = useSiteWidth();
  const scroller = useRef<ScrollViewInstance>(null);
  const ys = useRef<Record<string, number>>({});
  const go = (key: string) => scroller.current?.scrollTo({ y: Math.max(0, (ys.current[key] ?? 0) - 8), animated: true });
  const mark = (key: string) => ({ onLayout: (e: { nativeEvent: { layout: { y: number } } }) => void (ys.current[key] = e.nativeEvent.layout.y) });

  const links = [
    { label: 'Features', testID: 'nav-features', onPress: () => go('features') },
    { label: 'How it works', testID: 'nav-how', onPress: () => go('how') },
    { label: 'About', testID: 'nav-about', onPress: () => router.push('/info/about') },
    { label: 'Contact', testID: 'nav-contact', onPress: () => router.push('/info/contact') },
  ];
  const column = (children: React.ReactNode, pad = spacing.lg) => (
    <View style={{ width: '100%', maxWidth: SITE_MAX, alignSelf: 'center', paddingHorizontal: pad }}>{children}</View>
  );
  const cols = wide ? 3 : medium ? 2 : 1;
  const previewScale = width >= 1100 ? 0.72 : width >= 700 ? 0.6 : 0.62;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView ref={scroller} testID="landing" contentContainerStyle={{ paddingBottom: 0 }}>
        <SiteHeader links={links} />

        {/* Hero */}
        {column(
          <View style={{ flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'center' : 'stretch', gap: spacing.xl + spacing.md, paddingVertical: wide ? spacing.xl * 2 : spacing.xl }}>
            <View style={{ flex: wide ? 1 : undefined, gap: spacing.lg }}>
              <AppText variant="eyebrow" tone="accent">
                Group trips, settled fairly
              </AppText>
              <AppText variant="title" role="heading" aria-level={1} testID="hero-title" style={{ fontSize: wide ? 64 : medium ? 48 : 38, lineHeight: wide ? 68 : medium ? 52 : 42, letterSpacing: -1 }}>
                Travel together.{'\n'}Split it simply.
              </AppText>
              <AppText tone="secondary" style={{ fontSize: 19, lineHeight: 29, maxWidth: 520 }}>
                TripMate keeps every shared cost, who owes whom and the fewest payments to settle up in one place, so the trip stays about the trip.
              </AppText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
                <CtaButton testID="hero-get-started" label="Get started" onPress={() => router.push('/sign-up')} primary />
                <CtaButton testID="hero-login" label="Log in" onPress={() => router.push('/sign-in')} />
              </View>
            </View>
            <View style={{ flex: wide ? 1 : undefined }}>
              <View>
                <TripScene kind="mountain" height={wide ? 520 : 300} radiusAll={radius.xl} />
                <View style={{ position: 'absolute', left: spacing.md, bottom: spacing.md, backgroundColor: colors.background, borderRadius: radius.md, padding: spacing.md, gap: 6, maxWidth: '80%' }}>
                  <StatusChip kind="ongoing" />
                  <AppText variant="heading">Coorg Coffee Trail</AppText>
                  <AppText variant="small" tone="secondary">
                    Sample trip · 5 travellers
                  </AppText>
                </View>
              </View>
            </View>
          </View>,
        )}

        {/* Features */}
        <View {...mark('features')} testID="features" style={{ paddingVertical: spacing.xl * 2 }}>
          {column(
            <>
              <SectionHeading eyebrow="What it does" title="Built around how groups actually spend" />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg }}>
                {FEATURES.map((f) => (
                  <View key={f.title} testID="feature-card" style={{ width: cols === 1 ? '100%' : cols === 2 ? '48.5%' : '31.8%', backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm }}>
                    <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.xs }}>
                      <Icon name={FEATURE_ICON[f.icon]} color={colors.onPrimary} size={24} />
                    </View>
                    <AppText variant="heading" role="heading" aria-level={3}>
                      {f.title}
                    </AppText>
                    <AppText tone="secondary">{f.body}</AppText>
                  </View>
                ))}
              </View>
              <AppText tone="secondary" testID="coming-next" style={{ textAlign: 'center', marginTop: spacing.lg, fontWeight: '600' }}>
                Coming next: recording and confirming repayments inside the app.
              </AppText>
            </>,
          )}
        </View>

        {/* How it works */}
        <View {...mark('how')} testID="how-it-works" style={{ backgroundColor: colors.surface, paddingVertical: spacing.xl * 2 }}>
          {column(
            <>
              <SectionHeading eyebrow="How it works" title="Three steps, no spreadsheets" />
              <View style={{ flexDirection: wide ? 'row' : 'column', gap: spacing.xl }}>
                {STEPS.map((s, i) => (
                  <View key={s.title} style={{ flex: wide ? 1 : undefined, gap: spacing.sm }}>
                    <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.woodText, alignItems: 'center', justifyContent: 'center' }}>
                      <AppText variant="heading" style={{ color: colors.onWood }}>
                        {i + 1}
                      </AppText>
                    </View>
                    <AppText variant="heading" style={{ fontSize: 22 }}>
                      {s.title}
                    </AppText>
                    <AppText tone="secondary" style={{ fontSize: 17, lineHeight: 25 }}>
                      {s.body}
                    </AppText>
                  </View>
                ))}
              </View>
            </>,
          )}
        </View>

        {/* Product previews */}
        <View testID="previews" style={{ paddingVertical: spacing.xl * 2 }}>
          {column(
            <>
              <SectionHeading eyebrow="Inside the app" title="Calm screens for busy trips" />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.xl }}>
                <HomePreview scale={previewScale} />
                {medium && <BalancesPreview scale={previewScale} />}
                {wide && <UpcomingPreview scale={previewScale} />}
              </View>
              <AppText variant="small" tone="secondary" style={{ textAlign: 'center', marginTop: spacing.lg }}>
                Screens show sample trips and made-up names.
              </AppText>
            </>,
          )}
        </View>

        {/* Closing call to action */}
        <View style={{ paddingBottom: spacing.xl * 2 }}>
          {column(
            <View style={{ flexDirection: wide ? 'row' : 'column', backgroundColor: colors.surface2, borderRadius: radius.xl, overflow: 'hidden' }}>
              <View style={{ flex: wide ? 1 : undefined }}>
                <TripScene kind="lake" height={wide ? 340 : 200} />
              </View>
              <View style={{ flex: wide ? 1 : undefined, padding: spacing.xl, gap: spacing.lg, justifyContent: 'center', alignItems: 'flex-start' }}>
                <AppText variant="title" role="heading" aria-level={2} style={{ fontSize: 34, lineHeight: 40 }}>
                  Your next trip starts here.
                </AppText>
                <CtaButton testID="cta-signup" label="Create your free account" onPress={() => router.push('/sign-up')} primary />
              </View>
            </View>,
          )}
        </View>

        <SiteFooter onFeatures={() => go('features')} onHow={() => go('how')} />
      </ScrollView>
    </SafeAreaView>
  );
}

function CtaButton({ label, onPress, primary = false, testID }: { label: string; onPress: () => void; primary?: boolean; testID: string }) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      role="link"
      aria-label={label}
      style={({ pressed }) => ({ minHeight: 52, paddingHorizontal: spacing.lg, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? colors.primary : colors.surface2, opacity: pressed ? 0.85 : 1 })}
    >
      <AppText style={{ fontWeight: '700', fontSize: 17, color: primary ? colors.onPrimary : colors.textPrimary }}>{label}</AppText>
    </Pressable>
  );
}
