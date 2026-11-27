import type { ReactNode } from 'react';
import { View } from 'react-native';
import { radius, spacing } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { SurfaceContext } from './Surface';

/**
 * A tonal block: flat, no border, no shadow. `tone="strong"` uses the deeper Surface 2 for emphasis panels.
 * `accent` adds a forest edge on the left (used for "this is about you" panels).
 */
export function Card({
  children,
  tone = 'soft',
  accent = false,
  testID,
}: {
  children: ReactNode;
  tone?: 'soft' | 'strong';
  accent?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <SurfaceContext.Provider value="surface">
      <View
        testID={testID}
        style={{
          padding: spacing.md,
          gap: spacing.md,
          borderRadius: radius.lg,
          backgroundColor: tone === 'strong' ? colors.surface2 : colors.surface,
          borderLeftWidth: accent ? 5 : 0,
          borderLeftColor: colors.primaryText,
        }}
      >
        {children}
      </View>
    </SurfaceContext.Provider>
  );
}
