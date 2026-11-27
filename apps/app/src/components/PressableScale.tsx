import { useRef, type ReactNode } from 'react';
import { Animated, Easing, Pressable, type PressableProps } from 'react-native';
import { duration, useReducedMotion } from '../theme/motion';

/** A pressable that shrinks very slightly (98 %) while pressed. No movement at all with reduced motion. */
export function PressableScale({ children, ...props }: Omit<PressableProps, 'children' | 'style'> & { children: ReactNode }) {
  const reduced = useReducedMotion();
  const s = useRef(new Animated.Value(1)).current;
  const to = (v: number) => Animated.timing(s, { toValue: v, duration: duration('press', reduced), easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  return (
    <Pressable {...props} onPressIn={(e) => { to(0.98); props.onPressIn?.(e); }} onPressOut={(e) => { to(1); props.onPressOut?.(e); }}>
      <Animated.View style={{ transform: [{ scale: s }] }}>{children}</Animated.View>
    </Pressable>
  );
}
