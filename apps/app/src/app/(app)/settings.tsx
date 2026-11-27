import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { Scheme } from '../../theme/scheme';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { Screen } from '../../components/Screen';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useAuth } from '../../features/auth/AuthProvider';
import { useChangeTheme } from '../../features/profile/themeSync';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

const INFO_LINKS = [
  { page: 'about', label: 'About TripMate' },
  { page: 'contact', label: 'Contact' },
  { page: 'help', label: 'Help' },
  { page: 'privacy', label: 'Privacy Policy' },
  { page: 'terms', label: 'Terms and Conditions' },
] as const;

const THEME_OPTIONS: { value: Scheme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Settings (opened from the gear on Profile): Appearance (System / Light / Dark) and Sign out. Uses the existing theme and sign-out code. */
export default function SettingsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { state, signOut } = useAuth();
  const theme = useChangeTheme();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  async function doSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    const result = await signOut();
    if (!result.ok) {
      setSignOutError(result.message);
      setSigningOut(false);
    }
    // On success the route guard moves the person away from the signed-in screens.
  }

  return (
    <Screen>
      <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
        <Pressable
          testID="settings-back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/profile'))}
          role="link"
          aria-label="Back to Profile"
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.xs, alignSelf: 'flex-start' }}
        >
          <Icon name="back" color={colors.primaryText} size={22} />
          <AppText tone="brand" style={{ fontWeight: '600' }}>
            Profile
          </AppText>
        </Pressable>
        <AppText variant="title">Settings</AppText>
      </View>

      <Card>
        <AppText variant="heading">Appearance</AppText>
        <SegmentedControl label="Theme" testIDPrefix="theme" options={THEME_OPTIONS} value={theme.preference} onChange={theme.change} />
        <AppText variant="small" tone="secondary">
          Light is the default. The choice you make on this device is kept on this device, including through sign-in and sign-out, and is also saved to your account for your other devices.
        </AppText>
        {theme.saveError && (
          <Banner kind="error" testID="theme-error">
            {theme.saveError}
          </Banner>
        )}
      </Card>

      <Card>
        <AppText variant="heading">Help and information</AppText>
        <AppText variant="small" tone="secondary">
          These pages are placeholders until their content is provided.
        </AppText>
        <View style={{ gap: spacing.xs }}>
          {INFO_LINKS.map((l) => (
            <Link key={l.page} href={`/info/${l.page}` as never} accessibilityRole="link" testID={`settings-info-${l.page}`} aria-label={l.label}>
              <AppText tone="brand" style={{ fontWeight: '600', paddingVertical: 8 }}>
                {l.label}
              </AppText>
            </Link>
          ))}
        </View>
      </Card>

      <Card>
        <AppText variant="heading">Account</AppText>
        <View style={{ gap: spacing.xs }}>
          <AppText variant="small" tone="secondary">
            Signed in as
          </AppText>
          <AppText testID="account-email">{state.status === 'signedIn' ? (state.email ?? 'your account') : ''}</AppText>
        </View>
        {signOutError && (
          <Banner kind="error" testID="signout-error">
            {signOutError}
          </Banner>
        )}
        <Button testID="sign-out" label="Sign out" variant="secondary" onPress={doSignOut} loading={signingOut} />
      </Card>
    </Screen>
  );
}
