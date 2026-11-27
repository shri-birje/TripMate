import { ActivityIndicator, View } from 'react-native';
import { Banner } from './Banner';
import { AppText } from './AppText';
import { Card } from './Card';
import { Screen } from './Screen';
import { useTheme } from '../theme/ThemeProvider';

export function LoadingScreen() {
  const { colors } = useTheme();
  return (
    <View
      testID="loading-screen"
      aria-label="Loading"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}
    >
      <ActivityIndicator size="large" color={colors.primaryText} />
    </View>
  );
}

/** Shown instead of the app when the Supabase settings are missing or unsafe. Never shows any key. */
export function SetupScreen({ message }: { message: string }) {
  return (
    <Screen>
      <AppText variant="title" tone="brand" style={{ marginTop: 24 }}>
        TripMate
      </AppText>
      <Card>
        <AppText variant="heading">Setup needed</AppText>
        <Banner kind="error" testID="setup-error">
          {message}
        </Banner>
        <AppText variant="small" tone="secondary">
          1. Copy apps/app/.env.example to apps/app/.env{'\n'}
          2. Fill in your Supabase project URL and PUBLISHABLE key{'\n'}
          3. Restart the app (stop it, then run it again)
        </AppText>
      </Card>
    </Screen>
  );
}
