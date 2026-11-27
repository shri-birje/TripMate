import { Link, useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { AppText } from '../../components/AppText';
import { SurfaceContext } from '../../components/Surface';
import { ThemeSwitch } from '../../components/ThemeSwitch';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';

/** Width of the website's content column, and the breakpoints its layout uses. */
export const SITE_MAX = 1200;
export const useSiteWidth = () => {
  const { width } = useWindowDimensions();
  return { width, wide: width >= 900, medium: width >= 640 };
};

export function Brand({ size = 'normal' }: { size?: 'normal' | 'big' }) {
  const { colors } = useTheme();
  const d = size === 'big' ? 26 : 20;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <View style={{ width: d, height: d, borderTopLeftRadius: d / 2, borderTopRightRadius: d / 2, borderBottomRightRadius: d / 2, borderBottomLeftRadius: 3, backgroundColor: colors.primary, transform: [{ rotate: '-45deg' }] }} />
      <AppText variant="heading" tone="brand" style={{ fontSize: size === 'big' ? 24 : 20 }}>
        TripMate
      </AppText>
    </View>
  );
}

export type SiteLink = { label: string; onPress: () => void; testID: string };

/** The website header: brand, links, Log in and Sign up. On narrow windows the links fold into a Menu button. */
export function SiteHeader({ links }: { links: SiteLink[] }) {
  const router = useRouter();
  const { colors } = useTheme();
  const { wide } = useSiteWidth();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ width: '100%', maxWidth: SITE_MAX, alignSelf: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md }} role="banner">
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
        <Pressable role="link" aria-label="TripMate home" onPress={() => router.replace('/welcome')} testID="site-brand">
          <Brand size={wide ? 'big' : 'normal'} />
        </Pressable>
        {wide && (
          <View role="navigation" aria-label="Site" style={{ flexDirection: 'row', gap: spacing.xl }}>
            {links.map((l) => (
              <Pressable key={l.testID} testID={l.testID} onPress={l.onPress} role="link" aria-label={l.label} style={{ minHeight: 44, justifyContent: 'center' }}>
                <AppText tone="secondary" style={{ fontWeight: '600' }}>
                  {l.label}
                </AppText>
              </Pressable>
            ))}
          </View>
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          {wide && <ThemeSwitch />}
          {wide && (
            <Pressable testID="site-login" role="link" aria-label="Log in" onPress={() => router.push('/sign-in')} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm }}>
              <AppText style={{ fontWeight: '700' }}>Log in</AppText>
            </Pressable>
          )}
          <Pressable
            testID="site-signup"
            role="link"
            aria-label="Sign up"
            onPress={() => router.push('/sign-up')}
            style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.primary }}
          >
            <AppText style={{ fontWeight: '700', color: colors.onPrimary }}>Sign up</AppText>
          </Pressable>
          {!wide && (
            <Pressable testID="site-menu" role="button" aria-label="Menu" aria-expanded={open} onPress={() => setOpen((v) => !v)} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm }}>
              <AppText tone="brand" style={{ fontWeight: '700' }}>
                {open ? 'Close' : 'Menu'}
              </AppText>
            </Pressable>
          )}
        </View>
      </View>
      {!wide && open && (
        <View role="navigation" aria-label="Site" testID="site-menu-list" style={{ marginTop: spacing.sm, backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.sm }}>
          {[...links, { label: 'Log in', testID: 'site-login', onPress: () => router.push('/sign-in') }].map((l) => (
            <Pressable
              key={l.testID}
              testID={`${l.testID}-menu`}
              onPress={() => {
                setOpen(false);
                l.onPress();
              }}
              role="link"
              aria-label={l.label}
              style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: spacing.md }}
            >
              <AppText style={{ fontWeight: '600' }}>{l.label}</AppText>
            </Pressable>
          ))}
          <View style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
              Appearance
            </AppText>
            <ThemeSwitch idPrefix="site-theme-menu" />
          </View>
        </View>
      )}
    </View>
  );
}

/** A slim top bar for the sign-in, sign-up and information pages: brand on the left, the appearance switch on the right. */
export function SiteTopBar({ right, showTheme = true }: { right?: ReactNode; showTheme?: boolean }) {
  const router = useRouter();
  return (
    <View role="banner" style={{ width: '100%', maxWidth: SITE_MAX, alignSelf: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}>
      <Pressable role="link" aria-label="TripMate home" onPress={() => router.replace('/')} testID="site-brand">
        <Brand />
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        {right}
        {showTheme && <ThemeSwitch />}
      </View>
    </View>
  );
}

function FooterLink({ label, href, onPress, testID }: { label: string; href?: string; onPress?: () => void; testID: string }) {
  const body = (
    <AppText tone="secondary" style={{ paddingVertical: 6 }}>
      {label}
    </AppText>
  );
  if (href) {
    return (
      <Link href={href as never} testID={testID} accessibilityRole="link" aria-label={label}>
        {body}
      </Link>
    );
  }
  return (
    <Pressable testID={testID} onPress={onPress} role="link" aria-label={label} style={{ minHeight: 32, justifyContent: 'center' }}>
      {body}
    </Pressable>
  );
}

/** The footer. Links to company and legal pages go to clearly marked placeholder pages; no contact details are invented. */
export function SiteFooter({ onFeatures, onHow }: { onFeatures?: () => void; onHow?: () => void }) {
  const { colors } = useTheme();
  const { wide, medium } = useSiteWidth();
  const col = (title: string, children: ReactNode) => (
    <View style={{ gap: 2, minWidth: 150 }} role="navigation" aria-label={title}>
      <AppText variant="small" style={{ fontWeight: '700', marginBottom: spacing.xs }}>
        {title}
      </AppText>
      {children}
    </View>
  );
  return (
    // A full-width band of its own: the deeper tonal surface plus a hairline on top, so it never reads as the end of the panel above it.
    <View style={{ backgroundColor: colors.surface2, width: '100%', borderTopWidth: 1, borderTopColor: colors.border }} role="contentinfo" testID="site-footer">
      <SurfaceContext.Provider value="surface">
      <View style={{ width: '100%', maxWidth: SITE_MAX, alignSelf: 'center', padding: spacing.lg, paddingTop: spacing.xl, gap: spacing.lg }}>
        <View style={{ flexDirection: wide ? 'row' : 'column', justifyContent: 'space-between', gap: spacing.xl }}>
          <View style={{ gap: spacing.sm, maxWidth: 320 }}>
            <Brand size="big" />
            <AppText tone="secondary">Shared trips and clear splits.</AppText>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: medium ? spacing.xl * 2 : spacing.xl, rowGap: spacing.lg }}>
            {col(
              'Product',
              <>
                <FooterLink testID="footer-features" label="Features" onPress={onFeatures ?? (() => {})} />
                <FooterLink testID="footer-how" label="How it works" onPress={onHow ?? (() => {})} />
              </>,
            )}
            {col(
              'Company',
              <>
                <FooterLink testID="footer-about" label="About" href="/info/about" />
                <FooterLink testID="footer-contact" label="Contact" href="/info/contact" />
                <FooterLink testID="footer-help" label="Help" href="/info/help" />
              </>,
            )}
            {col(
              'Legal',
              <>
                <FooterLink testID="footer-privacy" label="Privacy Policy" href="/info/privacy" />
                <FooterLink testID="footer-terms" label="Terms and Conditions" href="/info/terms" />
              </>,
            )}
          </View>
        </View>
        <AppText variant="small" tone="secondary" testID="footer-note">
          Company, Legal and Help pages are placeholders until their content is provided.
        </AppText>
      </View>
      </SurfaceContext.Provider>
    </View>
  );
}

export function SectionHeading({ eyebrow, title, align = 'center' }: { eyebrow: string; title: string; align?: 'center' | 'left' }) {
  return (
    <View style={{ gap: spacing.sm, alignItems: align === 'center' ? 'center' : 'flex-start', marginBottom: spacing.xl }}>
      <AppText variant="eyebrow" tone="accent">
        {eyebrow}
      </AppText>
      <AppText variant="title" role="heading" aria-level={2} style={{ fontSize: 34, lineHeight: 40, textAlign: align }}>
        {title}
      </AppText>
    </View>
  );
}

