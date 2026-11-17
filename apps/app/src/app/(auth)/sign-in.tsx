import { Link } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { TextField } from '../../components/TextField';
import { useAuth } from '../../features/auth/AuthProvider';
import { spacing } from '../../theme/tokens';

export default function SignInScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    const result = await signIn({ email, password });
    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setFormError(result.fieldErrors ? null : result.message);
      setBusy(false);
    }
    // On success the route guard moves the person to the home screen.
  }

  return (
    <Screen>
      <View style={{ marginTop: spacing.xl, gap: spacing.xs }}>
        <AppText variant="title" tone="brand">
          TripMate
        </AppText>
        <AppText tone="secondary">Welcome back. Sign in to see your trips.</AppText>
      </View>

      <Card>
        {formError && <Banner kind="error" testID="form-error">{formError}</Banner>}
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
          secret
          autoCapitalize="none"
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
        <Button testID="submit" label="Sign in" onPress={submit} loading={busy} />
      </Card>

      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.xs }}>
        <AppText tone="secondary">New to TripMate?</AppText>
        <Link href="/sign-up" accessibilityRole="link">
          <AppText tone="brand" style={{ fontWeight: '600' }}>
            Create an account
          </AppText>
        </Link>
      </View>
    </Screen>
  );
}
