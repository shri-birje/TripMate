import { Stack } from 'expo-router';
import { useTheme } from '../../theme/ThemeProvider';

/** The public website pages (signed-out visitors). */
export default function SiteLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
