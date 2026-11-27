import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import type { Scheme } from '../theme/scheme';
import { useChangeTheme } from '../features/profile/themeSync';
import { duration, useReducedMotion } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { Icon, type IconName } from './Icon';

const OPTIONS: { value: Scheme; label: string; icon: IconName }[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
];

const SIZE = 44;
const GAP = 2;
const PAD = 3;

/**
 * A compact two-state Light / Dark control for the public website (landing header and the information pages).
 * It is the SAME theme preference the app uses (`useChangeTheme`): remembered on this device straight away, so it survives a refresh and
 * sign-in, and, if the person happens to be signed in, saved to the account like the Settings control.
 * The highlight slides between the two options (about 220 ms, instant with reduced motion). Nothing remounts.
 * `idPrefix` only keeps test ids unique when two switches could be on one screen.
 */
export function ThemeSwitch({ idPrefix = 'site-theme' }: { idPrefix?: string }) {
  const { colors } = useTheme();
  const theme = useChangeTheme();
  const reduced = useReducedMotion();
  const index = theme.preference === 'dark' ? 1 : 0;
  const x = useRef(new Animated.Value(index * (SIZE + GAP))).current;

  useEffect(() => {
    const anim = Animated.timing(x, { toValue: index * (SIZE + GAP), duration: duration('tab', reduced), easing: Easing.out(Easing.cubic), useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [index, reduced, x]);

  return (
    <View role="radiogroup" aria-label="Appearance" testID={`${idPrefix}-group`} style={{ flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.md, padding: PAD, gap: GAP }}>
      <Animated.View
        pointerEvents="none"
        testID={`${idPrefix}-indicator`}
        style={{ position: 'absolute', left: PAD, top: PAD, width: SIZE, height: SIZE, borderRadius: radius.md - 3, backgroundColor: colors.primary, transform: [{ translateX: x }] }}
      />
      {OPTIONS.map((o) => {
        const selected = theme.preference === o.value;
        return (
          <Pressable
            key={o.value}
            testID={`${idPrefix}-${o.value}`}
            onPress={() => theme.change(o.value)}
            role="radio"
            aria-label={o.label}
            aria-checked={selected}
            // @ts-expect-error `title` is a web-only tooltip that react-native-web passes through
            title={`${o.label} appearance`}
            style={{ width: SIZE, height: SIZE, borderRadius: radius.md - 3, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={o.icon} color={selected ? colors.onPrimary : colors.textSecondaryOnSurface} size={22} />
          </Pressable>
        );
      })}
    </View>
  );
}
