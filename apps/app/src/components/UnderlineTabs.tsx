import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { duration, useReducedMotion } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { fontFamily } from '../theme/fonts';
import { fontSize } from '../theme/tokens';

interface Option<T extends string> {
  value: T;
  label: string;
  /** Spoken label if it should say more than the visible one (for example with a count). */
  accessibilityLabel?: string;
}

interface Props<T extends string> {
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  testIDPrefix: string;
}

/**
 * Text tabs with a forest-green underline that SLIDES to the chosen tab (220 ms ease-out; instant with reduced motion).
 * Tabs share the width equally, so with three tabs the middle one is centred.
 */
export function UnderlineTabs<T extends string>({ label, options, value, onChange, testIDPrefix }: Props<T>) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [boxes, setBoxes] = useState<Record<string, { x: number; width: number }>>({});
  const x = useRef(new Animated.Value(0)).current;
  const w = useRef(new Animated.Value(0)).current;
  const placed = useRef(false);
  const target = boxes[value];

  useEffect(() => {
    if (!target) return;
    if (!placed.current || reduced) {
      x.setValue(target.x);
      w.setValue(target.width);
      placed.current = true;
      return;
    }
    const config = { duration: duration('tab', reduced), easing: Easing.out(Easing.cubic), useNativeDriver: false };
    const anim = Animated.parallel([Animated.timing(x, { toValue: target.x, ...config }), Animated.timing(w, { toValue: target.width, ...config })]);
    anim.start();
    return () => anim.stop();
  }, [target?.x, target?.width, reduced, x, w]); // eslint-disable-line react-hooks/exhaustive-deps

  const onTabLayout = (v: string) => (e: LayoutChangeEvent) => {
    const { x: ox, width } = e.nativeEvent.layout;
    setBoxes((prev) => (prev[v] && prev[v]!.x === ox && prev[v]!.width === width ? prev : { ...prev, [v]: { x: ox, width } }));
  };

  return (
    <View role="tablist" aria-label={label} testID={`${testIDPrefix}-tabs`} style={{ flexDirection: 'row' }}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            testID={`${testIDPrefix}-${o.value}`}
            onPress={() => onChange(o.value)}
            onLayout={onTabLayout(o.value)}
            role="tab"
            aria-label={o.accessibilityLabel ?? o.label}
            aria-selected={selected}
            style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingBottom: 3 }}
          >
            <Text style={{ color: selected ? colors.textPrimary : colors.textSecondary, fontSize: fontSize.body, fontWeight: selected ? '700' : '500', fontFamily: fontFamily.body }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
      {/* the sliding underline */}
      {target && <Animated.View pointerEvents="none" style={{ position: 'absolute', left: x, width: w, bottom: 0, height: 3, borderRadius: 2, backgroundColor: colors.primaryText }} />}
    </View>
  );
}
