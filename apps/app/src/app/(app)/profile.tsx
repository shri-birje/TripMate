import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { SUPPORTED_CURRENCIES, type CurrencyCode, type Profile } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Avatar } from '../../components/Avatar';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { Screen } from '../../components/Screen';
import { SegmentedControl } from '../../components/SegmentedControl';
import { TextField } from '../../components/TextField';
import { useAuth } from '../../features/auth/AuthProvider';
import { useProfile, useUpdateProfileDetails } from '../../features/profile/profileApi';
import { ProfileError } from '../../features/profile/profileService';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

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
  const router = useRouter();
  const { colors } = useTheme();
  const { state } = useAuth();
  const { data: profile, isPending, error, refetch } = useProfile();
  const update = useUpdateProfileDetails();

  const [form, setForm] = useState<Form | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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

  return (
    <Screen>
      <View style={{ marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <AppText variant="title">Profile</AppText>
        <Pressable
          testID="open-settings"
          onPress={() => router.push('/settings')}
          role="link"
          aria-label="Settings"
          style={({ pressed }) => ({ width: 44, height: 44, marginRight: -8, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
        >
          <Icon name="gear" color={colors.textPrimary} size={28} />
        </Pressable>
      </View>

      {profile && (
        <View style={{ alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm }}>
          <Avatar name={profile.displayName} size={76} testID="profile-avatar" />
          <AppText variant="heading" testID="profile-heading-name">{profile.displayName}</AppText>
          <AppText variant="small" tone="secondary" testID="profile-email">
            {state.status === 'signedIn' ? (state.email ?? '') : ''}
          </AppText>
        </View>
      )}

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

    </Screen>
  );
}
