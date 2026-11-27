import { View } from 'react-native';
import type { TripPhase } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';

const LABEL: Record<TripPhase, string> = { upcoming: 'Upcoming', ongoing: 'Ongoing', completed: 'Completed' };

/**
 * A small filled label showing where a trip is in time (or that it is archived). Flat tonal fills:
 * ongoing = forest, upcoming = wood, completed/archived = sand. All pairs pass the contrast checks in both themes.
 */
export function StatusChip({ kind, testID }: { kind: TripPhase | 'archived'; testID?: string }) {
  const { colors } = useTheme();
  const fill = kind === 'ongoing' ? colors.primary : kind === 'upcoming' ? colors.woodText : colors.surface2;
  const text = kind === 'ongoing' ? colors.onPrimary : kind === 'upcoming' ? colors.onWood : colors.textSecondaryOnSurface;
  return (
    <View testID={testID} style={{ alignSelf: 'flex-start', backgroundColor: fill, borderRadius: 999, paddingHorizontal: spacing.sm + 2, paddingVertical: 3 }}>
      <AppText variant="small" style={{ color: text, fontWeight: '700', fontSize: 11, lineHeight: 15, letterSpacing: 0.5, textTransform: 'uppercase' }}>
        {kind === 'archived' ? 'Archived' : LABEL[kind]}
      </AppText>
    </View>
  );
}

/** The phase label on Trip Details (keeps its test id). */
export function PhaseBadge({ phase }: { phase: TripPhase }) {
  return <StatusChip kind={phase} testID="trip-phase" />;
}
