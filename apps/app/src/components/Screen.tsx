import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';

/**
 * Standard page: respects the phone's notch and keyboard, scrolls when needed,
 * and keeps content to a comfortable width on tablets and desktop browsers.
 */
export function Screen({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ alignItems: 'center', padding: spacing.lg, paddingBottom: spacing.xl * 2 }}
        >
          <View style={{ width: '100%', maxWidth: 520, gap: spacing.md }}>{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
