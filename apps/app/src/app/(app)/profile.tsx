import { Link } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { SUPPORTED_CURRENCIES, type CurrencyCode, type Profile, type ThemePreference } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { SegmentedControl } from '../../components/SegmentedControl';
import { TextField } from '../../components/TextField';
import { useAuth } from '../../features/auth/AuthProvider';
import { useProfile, useUpdateProfileDetails } from '../../features/profile/profileApi';
import { ProfileError } from '../../features/profile/profileService';
import { useChangeTheme } from '../../features/profile/themeSync';
import { spacing } from '../../theme/tokens';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];
const CURRENCY_OPTIONS = SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }));

interface Form {
  displayName: string;
  upiId: string;
  preferredCurrency: CurrencyCode;
}

const formFrom = (p: Profile): Form => ({
  displayName: p.displayName,
  upiId: p.upiId ?? '',
  preferredCurrency: (SUPPORTED_CURRENCIES as readonly string[]).includes(p.preferredCurrency)
    ? (p.preferredCurrency as CurrencyCode)
    : 'INR',
});

export default function ProfileScreen() {
  const { state, signOut } = useAuth();
  const { data: profile, isPending, error, refetch } = useProfile();
  const update = useUpdateProfileDetails();
  const theme = useChangeTheme();

  const [form, setForm] = useState<Form | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Fill the form once when a profile first arrives (and again only if a different account's profile loads),
  // so a background refresh can never overwrite what the person is typing.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (profile && loadedFor.current !== profile.id) {
      loadedFor.current = profile.id;
      setForm(formFrom(profile));
    }
  }, [profile]);

  const dirty = !!profile && !!form && JSON.stringify(form) !== JSON.stringify(formFrom(profile));

  function edit(patch: Partial<Form>) {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setSaved(false);
    setFormError(null);
  }

  async function save() {
    if (!form || update.isPending) return;
    setFieldErrors({});
    setFormError(null);
    try {
      const updated = await update.mutateAsync(form);
      setForm(formFrom(updated));
      setSaved(true);
    } catch (e) {
      if (e instanceof ProfileError) {
        setFieldErrors(e.fieldErrors ?? {});
        setFormError(e.fieldErrors ? null : e.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  }

  async function doSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    const result = await signOut();
    if (!result.ok) {
      setSignOutError(result.message);
      setSigningOut(false);
    }
    // On success the route guard moves the person to sign-in.
  }

  return (
    <Screen>
      <View style={{ marginTop: spacing.md, gap: spacing.xs }}>
        <Link href="/" accessibilityRole="link">
          <AppText tone="brand" style={{ fontWeight: '600' }}>
            ← Home
          </AppText>
        </Link>
        <AppText variant="title">Profile and settings</AppText>
      </View>

      {isPending && <AppText tone="secondary" testID="profile-loading">Loading your profile…</AppText>}

      {error && !profile && (
        <Card>
          <Banner kind="error" testID="profile-error">{error.message}</Banner>
          <Button label="Try again" variant="secondary" onPress={() => void refetch()} />
        </Card>
      )}

      {profile && form && (
        <Card>
          <AppText variant="heading">Your details</AppText>
          {formError && <Banner kind="error" testID="save-error">{formError}</Banner>}
          {saved && <Banner kind="success" testID="save-ok">Saved.</Banner>}
          <TextField
            testID="profile-name"
            label="Your name"
            value={form.displayName}
            onChangeText={(v) => edit({ displayName: v })}
            error={fieldErrors.displayName}
            autoCapitalize="words"
            autoComplete="name"
            maxLength={80}
          />
          <TextField
            testID="profile-upi"
            label="UPI ID (optional)"
            value={form.upiId}
            onChangeText={(v) => edit({ upiId: v })}
            error={fieldErrors.upiId}
            helper="Only used to help friends pay you. Shared with people on your trips."
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="name@bank"
          />
          <View style={{ gap: spacing.sm }}>
            <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
              Currency
            </AppText>
            <SegmentedControl
              label="Currency"
              testIDPrefix="currency"
              options={CURRENCY_OPTIONS}
              value={form.preferredCurrency}
              onChange={(c) => edit({ preferredCurrency: c })}
            />
            {fieldErrors.preferredCurrency && <AppText variant="small" tone="error">{fieldErrors.preferredCurrency}</AppText>}
          </View>
          <Button testID="save-profile" label="Save changes" onPress={save} loading={update.isPending} disabled={!dirty} />
        </Card>
      )}

      <Card>
        <AppText variant="heading">Appearance</AppText>
        <SegmentedControl label="Theme" testIDPrefix="theme" options={THEME_OPTIONS} value={theme.preference} onChange={theme.change} />
        <AppText variant="small" tone="secondary">
          Light is the default. System follows your device&apos;s setting.
        </AppText>
        {theme.saveError && <Banner kind="error" testID="theme-error">{theme.saveError}</Banner>}
      </Card>

      <Card>
        <AppText variant="heading">Account</AppText>
        <View style={{ gap: spacing.xs }}>
          <AppText variant="small" tone="secondary">
            Signed in as
          </AppText>
          <AppText testID="account-email">{state.status === 'signedIn' ? (state.email ?? 'your account') : ''}</AppText>
        </View>
        {signOutError && <Banner kind="error" testID="signout-error">{signOutError}</Banner>}
        <Button testID="sign-out" label="Sign out" variant="secondary" onPress={doSignOut} loading={signingOut} />
      </Card>
    </Screen>
  );
}
