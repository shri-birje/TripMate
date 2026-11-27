import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import type { Trip } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { UnderlineTabs } from '../../components/UnderlineTabs';
import { todayIso } from '../../lib/today';
import { useTheme } from '../../theme/ThemeProvider';
import { radius, spacing } from '../../theme/tokens';
import { TripCard } from '../trips/TripCard';

/**
 * Static previews of the real app screens for the website, built from the app's own components (TripCard, Card,
 * UnderlineTabs ...) with FICTIONAL sample data, scaled down inside a phone frame. Nothing here reads or writes real data.
 */
/** Plain calendar-day arithmetic on ISO dates (no time zones involved). */
function plusDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/**
 * Sample trips, dated relative to today so each one is really in the status it is shown under (the Ongoing tab never shows a
 * trip that would be labelled Completed).
 */
function sampleTrip(id: string, name: string, destination: string, startOffset: number, endOffset: number, memberCount: number, budgetMinor: number | null): Trip {
  const today = todayIso();
  return { id, name, destination, startDate: plusDays(today, startOffset), endDate: plusDays(today, endOffset), currency: 'INR', budgetMinor, memberCount, status: 'active' } as unknown as Trip;
}

const SCREEN_W = 390;
const SCREEN_H = 740;
const BEZEL = 12;

/**
 * A phone: a dark bezel with rounded outer corners and a small speaker notch around the screen, so the previews read as devices and
 * stay visible on the page in both themes. The screen is built from the real app components with fictional data; the bottom
 * navigation sits inside the device. Scaled down as one piece.
 */
export function PhoneFrame({ scale, children, label }: { scale: number; children: ReactNode; label: string }) {
  const { colors, scheme } = useTheme();
  const bezel = scheme === 'dark' ? '#3A3A3A' : '#2A2E22';
  const edge = scheme === 'dark' ? '#5A5A5A' : '#171A12';
  const outerW = SCREEN_W + BEZEL * 2;
  const outerH = SCREEN_H + BEZEL * 2;
  return (
    <View aria-label={label} role="img" testID="phone-frame" style={{ width: outerW * scale, height: outerH * scale }}>
      <View
        pointerEvents="none"
        style={{ width: outerW, height: outerH, transform: [{ scale }], transformOrigin: 'top left', backgroundColor: bezel, borderRadius: 52, borderWidth: 1.5, borderColor: edge, padding: BEZEL - 1.5 }}
      >
        <View style={{ width: SCREEN_W, height: SCREEN_H, backgroundColor: colors.background, borderRadius: 40, overflow: 'hidden' }}>
          <View style={{ padding: spacing.lg, paddingTop: spacing.xl + spacing.sm, gap: spacing.md }}>{children}</View>
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 70, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}>
            <Icon name="home" color={colors.primaryText} />
            <Icon name="search" color={colors.textSecondaryOnSurface} />
            <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="plus" color={colors.onPrimary} />
            </View>
            <Icon name="archive" color={colors.textSecondaryOnSurface} />
            <Icon name="user" color={colors.textSecondaryOnSurface} />
          </View>
          {/* speaker notch */}
          <View style={{ position: 'absolute', top: 10, alignSelf: 'center', width: 92, height: 24, borderRadius: 12, backgroundColor: bezel }} />
        </View>
      </View>
    </View>
  );
}

export function HomePreview({ scale }: { scale: number }) {
  const { colors } = useTheme();
  const [tab] = useState<'completed' | 'ongoing' | 'upcoming'>('ongoing');
  return (
    <PhoneFrame scale={scale} label="Preview of the TripMate Home screen">
      <AppText variant="eyebrow" tone="accent">
        TripMate
      </AppText>
      <AppText variant="title">Hello, Meera</AppText>
      <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface }}>
        <Icon name="search" color={colors.textSecondaryOnSurface} size={22} />
        <AppText style={{ color: colors.textSecondaryOnSurface }}>Search trips</AppText>
      </View>
      <UnderlineTabs
        label="Trip status"
        testIDPrefix="preview-status"
        options={[
          { value: 'completed', label: 'Completed' },
          { value: 'ongoing', label: 'Ongoing' },
          { value: 'upcoming', label: 'Upcoming' },
        ]}
        value={tab}
        onChange={() => {}}
      />
      <TripCard trip={sampleTrip('sample-coorg', 'Coorg Coffee Trail', 'Coorg, Karnataka', -1, 3, 5, 6000000)} />
    </PhoneFrame>
  );
}

export function BalancesPreview({ scale }: { scale: number }) {
  // Sample plan obeying the real rules: nobody both pays and receives (Rohan, You and Isha pay; Aarav and Kabir receive).
  return (
    <PhoneFrame scale={scale} label="Preview of the TripMate Balances screen">
      <AppText variant="title">Balances</AppText>
      <Card tone="strong" accent>
        <AppText variant="eyebrow" tone="secondary">
          Only you
        </AppText>
        <AppText variant="heading">My Suggested Payments</AppText>
        <AppText variant="heading" tone="warn" style={{ fontSize: 18 }}>
          You pay Kabir ₹1,240
        </AppText>
      </Card>
      <Card>
        <AppText variant="eyebrow" tone="secondary">
          Whole group
        </AppText>
        <AppText variant="heading">Everyone&apos;s Payments</AppText>
        <AppText tone="secondary" style={{ fontWeight: '600' }}>
          3 payments settle everyone.
        </AppText>
        <AppText>Rohan pays Aarav ₹2,950</AppText>
        <AppText style={{ fontWeight: '700' }}>You pay Kabir ₹1,240</AppText>
        <AppText>Isha pays Aarav ₹800</AppText>
      </Card>
      <AppText variant="small" tone="secondary">
        Sample data. Suggestions only.
      </AppText>
    </PhoneFrame>
  );
}

export function UpcomingPreview({ scale }: { scale: number }) {
  return (
    <PhoneFrame scale={scale} label="Preview of an upcoming trip in TripMate">
      <AppText variant="eyebrow" tone="accent">
        Upcoming
      </AppText>
      <AppText variant="title">Your next trips</AppText>
      <TripCard trip={sampleTrip('sample-hampi', 'Hampi Weekend', 'Hampi', 14, 16, 4, null)} />
      <TripCard trip={sampleTrip('sample-gokarna', 'Gokarna Beach Camp', 'Gokarna', 40, 44, 3, null)} />
    </PhoneFrame>
  );
}
