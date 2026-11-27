import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { PASSWORD_MIN } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { TextField } from '../../components/TextField';
import { useAuth } from '../../features/auth/AuthProvider';
import { AuthShell } from '../../features/auth/AuthShell';
import { spacing } from '../../theme/tokens';

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    const result = await signUp({ displayName, email, password });
    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setFormError(result.fieldErrors ? null : result.message);
      setBusy(false);
      return;
    }
    if (result.outcome === 'confirm_email') {
      setConfirmationSentTo(email.trim().toLowerCase());
      setBusy(false);
    }
    // 'signed_in': the route guard moves the person to the home screen.
  }

  if (confirmationSentTo) {
    return (
      <AuthShell title="Check your email" subtitle="One more step to finish creating your account.">
        <Card>
          <Banner kind="success" testID="confirm-sent">
            Almost there! We sent a confirmation link.
          </Banner>
          <AppText>
            If {confirmationSentTo} can be used for a new account, a confirmation email is on its way. Open the link in it, then sign in.
          </AppText>
          <AppText variant="small" tone="secondary">
            Nothing arrived? Check your spam folder, wait a few minutes, or try again.
          </AppText>
          <Button label="Go to sign in" onPress={() => router.replace('/sign-in')} />
        </Card>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Create your account" subtitle="Plan trips and split costs with your friends.">
      <Card>
        {formError && <Banner kind="error" testID="form-error">{formError}</Banner>}
        <TextField
          testID="displayName"
          label="Your name"
          value={displayName}
          onChangeText={setDisplayName}
          error={fieldErrors.displayName}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          returnKeyType="next"
          maxLength={80}
        />
        <TextField
          testID="email"
          label="Email"
          value={email}
          onChangeText={setEmail}
          error={fieldErrors.email}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="next"
        />
        <TextField
          testID="password"
          label="Password"
          value={password}
          onChangeText={setPassword}
          error={fieldErrors.password}
          helper={`At least ${PASSWORD_MIN} characters, with a letter and a number.`}
          secret
          autoCapitalize="none"
          autoComplete="new-password"
          textContentType="newPassword"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Button testID="submit" label="Create account" onPress={submit} loading={busy} />
      </Card>

      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.xs }}>
        <AppText tone="secondary">Already have an account?</AppText>
        <Link href="/sign-in" accessibilityRole="link">
          <AppText tone="brand" style={{ fontWeight: '600' }}>
            Sign in
          </AppText>
        </Link>
      </View>
    </AuthShell>
  );
}
