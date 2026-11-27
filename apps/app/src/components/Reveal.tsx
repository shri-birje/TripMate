import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, View } from 'react-native';
import { duration, useReducedMotion } from '../theme/motion';

/**
 * Fades and expands its content when it first appears (180 ms; instant with reduced motion). Used for the amount
 * boxes that appear when the split method changes. Mount it with a `key` that changes to replay the reveal.
 * `maxHeight` is only a ceiling for the expansion; once finished the content is free to be any height.
 */
export function Reveal({ children, maxHeight = 160 }: { children: ReactNode; maxHeight?: number }) {
  const reduced = useReducedMotion();
  const t = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const [done, setDone] = useState(reduced);

  useEffect(() => {
    if (reduced) {
      t.setValue(1);
      setDone(true);
      return;
    }
    const anim = Animated.timing(t, { toValue: 1, duration: duration('split', false), easing: Easing.out(Easing.cubic), useNativeDriver: false });
    anim.start(({ finished }) => finished && setDone(true));
    return () => anim.stop();
  }, [reduced, t]);

  // One tree for the whole life of the component, so the inputs inside are never remounted (they keep focus and text).
  return (
    <Animated.View
      style={done ? undefined : { overflow: 'hidden', opacity: t, maxHeight: t.interpolate({ inputRange: [0, 1], outputRange: [0, maxHeight] }) }}
    >
      <View>{children}</View>
    </Animated.View>
  );
}
