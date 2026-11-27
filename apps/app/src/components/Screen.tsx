import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { contentMaxWidth } from '../lib/layout';
import { useLayoutMode } from '../lib/useLayoutMode';
import { duration, useReducedMotion } from '../theme/motion';
import { spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';

/**
 * Standard page: respects the phone's notch and keyboard, scrolls when needed, and keeps content to a comfortable
 * width (wider on the desktop web dashboard). Each page eases in with a short fade and slide (200 ms), which is
 * skipped when the person has asked for reduced motion.
 *
 * The navigation bar is a sibling of the page (see (app)/_layout), so content is never drawn underneath it; the
 * bottom safe area is only added here as extra padding for pages that have no bar.
 */
export function Screen({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  const mode = useLayoutMode();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const t = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      t.setValue(1);
      return;
    }
    Animated.timing(t, { toValue: 1, duration: duration('screen', false), easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
  }, [reduced, t]);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ alignItems: 'center', padding: spacing.lg, paddingBottom: spacing.xl * 2 + insets.bottom }}
        >
          <Animated.View
            style={{
              width: '100%',
              maxWidth: contentMaxWidth(mode, width),
              gap: spacing.md,
              opacity: t,
              transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }],
            }}
          >
            {children}
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Re-plays the content transition when `contentKey` changes (used by the Home status tabs). */
export function FadeSwap({ contentKey, children }: { contentKey: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  const t = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced) {
      t.setValue(1);
      return;
    }
    t.setValue(0);
    Animated.timing(t, { toValue: 1, duration: duration('tab', false), easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' }).start();
  }, [contentKey, reduced, t]);
  return (
    <Animated.View style={{ opacity: t, transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] }}>
      <View>{children}</View>
    </Animated.View>
  );
}
