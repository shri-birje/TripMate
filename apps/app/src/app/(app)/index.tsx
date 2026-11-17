import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { AppText } from '../../components/AppText';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { useProfile } from '../../features/profile/profileApi';
import { spacing } from '../../theme/tokens';

/**
 * TEMPORARY home screen for Milestone M2. It exists so that signing in leads
 * somewhere real. It is replaced by the true Home (trip cards, balances) in
 * the trips milestone. No trip data is shown because none exists yet.
 */
export default function HomeScreen() {
  const router = useRouter();
  const { data: profile, isPending } = useProfile();
  const firstName = profile?.displayName.split(' ')[0];

  return (
    <Screen>
      <View style={{ marginTop: spacing.lg, gap: spacing.xs }}>
        <AppText variant="small" tone="secondary">
          TripMate
        </AppText>
        <AppText variant="title" testID="greeting">
          {isPending ? 'Welcome' : `Hello, ${firstName ?? 'traveller'}`}
        </AppText>
      </View>

      <Card>
        <AppText variant="heading">Your next adventure starts here.</AppText>
        <AppText tone="secondary">
          Your account is ready. Creating trips and inviting friends arrives in the next update.
        </AppText>
      </Card>

      <Button testID="open-profile" variant="secondary" label="Profile and settings" onPress={() => router.push('/profile')} />
    </Screen>
  );
}
