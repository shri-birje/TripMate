import { View } from 'react-native';

/**
 * A small calendar icon drawn from plain shapes (so no icon library is needed). It takes its
 * colour from the caller, so it follows the theme in both Light and Dark.
 */
export function CalendarIcon({ color, size = 22 }: { color: string; size?: number }) {
  const border = Math.max(2, Math.round(size / 11));
  const tick = { position: 'absolute' as const, top: 0, width: border, height: Math.round(size * 0.28), backgroundColor: color, borderRadius: 1 };
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden style={{ width: size, height: size }}>
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: Math.round(size * 0.14),
          bottom: 0,
          borderWidth: border,
          borderColor: color,
          borderRadius: Math.round(size * 0.18),
        }}
      >
        {/* the header band */}
        <View style={{ height: Math.round(size * 0.22), backgroundColor: color }} />
        {/* two little date dots */}
        <View style={{ flexDirection: 'row', gap: Math.round(size * 0.12), paddingLeft: Math.round(size * 0.14), paddingTop: Math.round(size * 0.1) }}>
          <View style={{ width: Math.round(size * 0.14), height: Math.round(size * 0.14), backgroundColor: color, borderRadius: 1 }} />
          <View style={{ width: Math.round(size * 0.14), height: Math.round(size * 0.14), backgroundColor: color, borderRadius: 1 }} />
        </View>
      </View>
      {/* the two rings at the top */}
      <View style={{ ...tick, left: Math.round(size * 0.24) }} />
      <View style={{ ...tick, right: Math.round(size * 0.24) }} />
    </View>
  );
}
