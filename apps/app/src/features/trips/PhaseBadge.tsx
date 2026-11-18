import { View } from 'react-native';
import type { TripPhase } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

const LABEL: Record<TripPhase, string> = { upcoming: 'Upcoming', ongoing: 'Ongoing', completed: 'Completed' };

/** A small pill showing where a trip is in time. Colours come from the theme (both themes pass the contrast checks). */
export function PhaseBadge({ phase }: { phase: TripPhase }) {
  const { colors } = useTheme();
  const color = phase === 'ongoing' ? colors.statusOk : phase === 'upcoming' ? colors.primary : colors.textSecondary;
  return (
    <View
      testID="trip-phase"
      style={{
        alignSelf: 'flex-start',
        borderWidth: 1,
        borderColor: color,
        borderRadius: 999,
        paddingHorizontal: spacing.sm + 2,
        paddingVertical: 2,
      }}
    >
      <AppText variant="small" style={{ color, fontWeight: '600' }}>
        {LABEL[phase]}
      </AppText>
    </View>
  );
}
