import { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import {
  CALENDAR_MAX_YEAR,
  CALENDAR_MIN_YEAR,
  WEEKDAY_SHORT,
  buildMonthGrid,
  longDateLabel,
  monthLabel,
  partsOfIso,
  shiftMonth,
  shiftYear,
  type YearMonth,
} from '@tripmate/core';
import { todayIso } from '../lib/today';
import { useTheme } from '../theme/ThemeProvider';
import { fontSize, radius, spacing } from '../theme/tokens';
import { AppText } from './AppText';
import { Button } from './Button';

interface Props {
  visible: boolean;
  /** Spoken by screen readers and shown at the top, e.g. "Start date". */
  title: string;
  /** The day currently in the text box (an ISO day), or null if it is empty or not a real date yet. */
  selectedIso: string | null;
  /** Days before this one cannot be chosen (used so an end date cannot be before the start date). */
  minIso?: string | null;
  /** Which month to open on when nothing is selected (for example the start date's month for the end date). */
  initialViewIso?: string | null;
  onSelect: (iso: string) => void;
  onClose: () => void;
}

const viewOf = (iso: string | null | undefined): YearMonth | null => {
  const p = iso ? partsOfIso(iso) : null;
  return p && p.year >= CALENDAR_MIN_YEAR && p.year <= CALENDAR_MAX_YEAR ? { year: p.year, month: p.month } : null;
};

/**
 * A calendar dialog built from React Native's own building blocks, so it looks and behaves the
 * same on phones and in the browser, follows the Light/Dark theme and needs no extra library.
 * (The standard native date picker does not exist on the web.) It works on plain calendar days,
 * so time zones cannot shift a date.
 */
export function DatePickerModal({ visible, title, selectedIso, minIso = null, initialViewIso = null, onSelect, onClose }: Props) {
  const { colors } = useTheme();
  const today = todayIso();
  const fallbackView = (): YearMonth => viewOf(selectedIso) ?? viewOf(initialViewIso) ?? viewOf(today) ?? { year: CALENDAR_MIN_YEAR, month: 1 };
  const [view, setView] = useState<YearMonth>(fallbackView);
  // Tracks the `visible` seen on the previous render, so opening the dialog can jump straight to
  // the month of the chosen date within the SAME render (not a tick later via an effect, which
  // could let the dialog briefly appear showing last time's month before catching up).
  const [shownFor, setShownFor] = useState(visible);
  if (visible !== shownFor) {
    setShownFor(visible);
    if (visible) setView(fallbackView());
  }

  const weeks = buildMonthGrid(view.year, view.month);
  const isBlocked = (iso: string) => minIso !== null && iso < minIso;
  const sameView = (a: YearMonth, b: YearMonth) => a.year === b.year && a.month === b.month;

  const nav = (label: string, glyph: string, target: YearMonth, testID: string) => {
    const disabled = sameView(target, view);
    return (
      <Pressable
        testID={testID}
        onPress={() => setView(target)}
        disabled={disabled}
        role="button"
        aria-label={label}
        aria-disabled={disabled}
        style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.35 : 1 }}
      >
        <AppText tone="brand" style={{ fontSize: 22, fontWeight: '700' }}>
          {glyph}
        </AppText>
      </Pressable>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* The dimmed backdrop is the one colour that is not a theme token: it must darken whatever is behind it in both themes. */}
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: spacing.md }}>
        <View
          testID="date-picker"
          role="dialog"
          aria-modal
          aria-label={title}
          style={{
            width: '100%',
            maxWidth: 360,
            maxHeight: '96%',
            borderRadius: radius.lg,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface,
          }}
        >
          <ScrollView contentContainerStyle={{ padding: spacing.md, gap: spacing.sm }} keyboardShouldPersistTaps="handled">
            <AppText variant="heading" testID="date-picker-title">
              {title}
            </AppText>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              {nav('Previous year', '«', shiftYear(view, -1), 'date-picker-prev-year')}
              {nav('Previous month', '‹', shiftMonth(view, -1), 'date-picker-prev-month')}
              <AppText testID="date-picker-month" aria-live="polite" style={{ fontWeight: '600', textAlign: 'center', flex: 1 }}>
                {monthLabel(view)}
              </AppText>
              {nav('Next month', '›', shiftMonth(view, 1), 'date-picker-next-month')}
              {nav('Next year', '»', shiftYear(view, 1), 'date-picker-next-year')}
            </View>

            <View style={{ flexDirection: 'row' }} aria-hidden>
              {WEEKDAY_SHORT.map((d) => (
                <View key={d} style={{ flex: 1, alignItems: 'center', paddingVertical: spacing.xs }}>
                  <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
                    {d}
                  </AppText>
                </View>
              ))}
            </View>

            <View testID="date-picker-grid">
              {weeks.map((week, w) => (
                <View key={w} style={{ flexDirection: 'row' }}>
                  {week.map((cell, i) => {
                    if (!cell) return <View key={`blank-${w}-${i}`} style={{ flex: 1, minHeight: 44, margin: 1 }} />;
                    const selected = cell.iso === selectedIso;
                    const blocked = isBlocked(cell.iso);
                    const isToday = cell.iso === today;
                    return (
                      <Pressable
                        key={cell.iso}
                        testID={`date-picker-day-${cell.iso}`}
                        onPress={() => onSelect(cell.iso)}
                        disabled={blocked}
                        role="button"
                        aria-label={`${longDateLabel(cell.iso)}${isToday ? ', today' : ''}`}
                        aria-pressed={selected}
                        aria-disabled={blocked}
                        style={{
                          flex: 1,
                          minHeight: 44, // comfortable touch target
                          margin: 1,
                          alignItems: 'center',
                          justifyContent: 'center',
                          borderRadius: radius.md,
                          borderWidth: isToday && !selected ? 1 : 0,
                          borderColor: colors.primary,
                          backgroundColor: selected ? colors.primary : 'transparent',
                          opacity: blocked ? 0.35 : 1,
                        }}
                      >
                        <AppText style={{ color: selected ? colors.onPrimary : colors.textPrimary, fontWeight: selected ? '700' : '400', fontSize: fontSize.body }}>
                          {cell.day}
                        </AppText>
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>

            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
              <View style={{ flex: 1 }}>
                <Button
                  testID="date-picker-today"
                  label="Today"
                  variant="secondary"
                  onPress={() => onSelect(today)}
                  disabled={isBlocked(today) || viewOf(today) === null}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button testID="date-picker-close" label="Close" variant="secondary" onPress={onClose} />
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
