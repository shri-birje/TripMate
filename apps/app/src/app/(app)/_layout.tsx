import { Stack, usePathname } from 'expo-router';
import { View } from 'react-native';
import { BottomNav, SideNav } from '../../components/AppNav';
import { useLayoutMode } from '../../lib/useLayoutMode';
import { navPlan } from '../../lib/navigation';
import { useTheme } from '../../theme/ThemeProvider';

/**
 * The signed-in app. One set of screens, two layouts:
 *   phones, tablets and narrow browser windows -> content with a fixed BOTTOM navigation;
 *   desktop web (wide windows)                 -> a SIDE navigation and a wider content column (the web dashboard).
 * The navigation hides itself on full-screen forms and Settings (see lib/navigation.ts).
 */
export default function AppLayout() {
  const { colors } = useTheme();
  const mode = useLayoutMode();
  const plan = navPlan(usePathname());
  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;

  if (mode === 'desktop') {
    return (
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.background }}>
        {plan.visible && <SideNav active={plan.active} />}
        <View style={{ flex: 1 }}>{stack}</View>
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ flex: 1 }}>{stack}</View>
      {plan.visible && <BottomNav active={plan.active} />}
    </View>
  );
}
