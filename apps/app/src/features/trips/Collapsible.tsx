import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, View } from 'react-native';
import { duration, useReducedMotion } from '../../theme/motion';

/**
 * Shows or hides its children by animating the height (about 200 ms, instant with reduced motion), using React Native's own Animated.
 * While closed the children are NOT mounted at all, so nothing inside can be seen, focused or read by a screen reader.
 * The content is measured once it is mounted (it sits absolutely inside a clipped box), and re-measured if it changes size while open.
 */
export function Collapsible({ open, children, testID }: { open: boolean; children: ReactNode; testID?: string }) {
  const reduced = useReducedMotion();
  const height = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(open);
  const [measured, setMeasured] = useState(0);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (open && !mounted) return;
    if (open && measured === 0) return; // wait for the first measurement
    const anim = Animated.timing(height, {
      toValue: open ? measured : 0,
      duration: duration('tab', reduced), // 220 ms
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    anim.start(({ finished }) => {
      if (finished && !open) setMounted(false);
    });
    return () => anim.stop();
  }, [open, mounted, measured, reduced, height]);

  if (!mounted) return null;
  return (
    <Animated.View testID={testID} style={{ height, overflow: 'hidden' }}>
      <View
        style={{ position: 'absolute', left: 0, right: 0, top: 0 }}
        onLayout={(e) => {
          const h = Math.ceil(e.nativeEvent.layout.height);
          if (h > 0 && h !== measured) setMeasured(h);
        }}
      >
        {children}
      </View>
    </Animated.View>
  );
}
