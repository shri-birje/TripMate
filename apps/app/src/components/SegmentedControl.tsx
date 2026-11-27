import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { fontFamily } from '../theme/fonts';
import { fontSize, radius, spacing } from '../theme/tokens';
import { duration, useReducedMotion } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { useSurface } from './Surface';

interface Option<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  /** Spoken by screen readers, e.g. "Theme". */
  label: string;
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  testIDPrefix?: string;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A row of choices where exactly one is selected (like radio buttons). Wraps onto more lines if needed.
 * The selected choice is shown by a forest-green indicator that SLIDES to the new choice (180 ms; instant when the
 * person has asked for reduced motion). Behaviour, labels and test ids are unchanged.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange, testIDPrefix }: Props<T>) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const onSurface = useSurface() === 'surface';
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const w = useRef(new Animated.Value(0)).current;
  const h = useRef(new Animated.Value(0)).current;
  const placed = useRef(false);

  const target = boxes[value];
  useEffect(() => {
    if (!target) return;
    if (!placed.current || reduced) {
      // first placement (or reduced motion): jump straight there
      x.setValue(target.x);
      y.setValue(target.y);
      w.setValue(target.width);
      h.setValue(target.height);
      placed.current = true;
      return;
    }
    const config = { duration: duration('split', reduced), easing: Easing.out(Easing.cubic), useNativeDriver: false };
    const anim = Animated.parallel([
      Animated.timing(x, { toValue: target.x, ...config }),
      Animated.timing(y, { toValue: target.y, ...config }),
      Animated.timing(w, { toValue: target.width, ...config }),
      Animated.timing(h, { toValue: target.height, ...config }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [target?.x, target?.y, target?.width, target?.height, reduced, x, y, w, h]); // eslint-disable-line react-hooks/exhaustive-deps

  const onOptionLayout = (v: string) => (e: LayoutChangeEvent) => {
    const { x: ox, y: oy, width, height } = e.nativeEvent.layout;
    setBoxes((prev) => {
      const old = prev[v];
      if (old && old.x === ox && old.y === oy && old.width === width && old.height === height) return prev;
      return { ...prev, [v]: { x: ox, y: oy, width, height } };
    });
  };

  const indicatorReady = !!target;
  return (
    <View role="radiogroup" aria-label={label} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
      {indicatorReady && (
        <Animated.View
          pointerEvents="none"
          style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: radius.md, backgroundColor: colors.primary }}
        />
      )}
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            testID={testIDPrefix ? `${testIDPrefix}-${o.value}` : undefined}
            onPress={() => onChange(o.value)}
            onLayout={onOptionLayout(o.value)}
            role="radio"
            aria-label={o.label}
            aria-checked={selected}
            style={{
              minHeight: 44,
              minWidth: 72,
              paddingHorizontal: spacing.md,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.md,
              // the sliding indicator draws the selected fill; until it has measured, paint it directly
              backgroundColor: selected ? (indicatorReady ? 'transparent' : colors.primary) : onSurface ? colors.surface2 : colors.surface,
            }}
          >
            <Text
              style={{
                color: selected ? colors.onPrimary : colors.textPrimary,
                fontSize: fontSize.body,
                fontWeight: selected ? '700' : '500',
                fontFamily: fontFamily.body,
              }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
