import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { motion } from './tokens';

/**
 * True when the person asked the operating system / browser to reduce motion. Works on native and on the web
 * (react-native-web reads the `prefers-reduced-motion` media query). Until the answer arrives it is `false`.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => alive && setReduced(v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduced(v));
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/** The duration to use for an animation: the approved one, or 0 (instant) with reduced motion. */
export function duration(kind: keyof typeof motion, reduced: boolean): number {
  return reduced ? 0 : motion[kind];
}
