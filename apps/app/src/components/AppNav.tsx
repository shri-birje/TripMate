import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardVisible } from '../lib/useKeyboardVisible';
import { NAV_ITEMS, type NavKey } from '../lib/navigation';
import { duration, useReducedMotion } from '../theme/motion';
import { useTheme } from '../theme/ThemeProvider';
import { fontFamily } from '../theme/fonts';
import { radius, spacing } from '../theme/tokens';
import { AppText } from './AppText';
import { useProfile } from '../features/profile/profileApi';
import { Avatar } from './Avatar';
import { Icon, type IconName } from './Icon';

const ICON: Record<Exclude<NavKey, 'create'>, IconName> = { home: 'home', search: 'search', archived: 'archive', profile: 'user' };

function useGo() {
  const router = useRouter();
  return (key: NavKey, href: (typeof NAV_ITEMS)[number]['href']) => {
    if (key === 'create') router.push(href);
    else router.navigate(href);
  };
}

/** A gentle fade for the active marker (160 ms; instant with reduced motion). */
function useFade(on: boolean) {
  const reduced = useReducedMotion();
  const v = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(v, { toValue: on ? 1 : 0, duration: duration('nav', reduced), easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [on, reduced, v]);
  return v;
}

/** The persistent bottom navigation for phones and narrow windows: Home, Search, Create trip (filled circle), Archived, Profile. */
export function BottomNav({ active }: { active: NavKey | null }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const go = useGo();
  // While the keyboard is open the whole bar steps aside (it would otherwise ride up above the keyboard); it returns when the keyboard closes.
  const keyboardOpen = useKeyboardVisible();
  if (keyboardOpen) return null;
  return (
    <View
      role="navigation"
      aria-label="Main"
      testID="bottom-nav"
      style={{ flexDirection: 'row', backgroundColor: colors.surface, paddingTop: spacing.sm, paddingBottom: Math.max(insets.bottom, spacing.sm), paddingHorizontal: spacing.xs }}
    >
      {NAV_ITEMS.map((item) => (
        <BottomItem key={item.key} item={item} active={active === item.key} onPress={() => go(item.key, item.href)} />
      ))}
    </View>
  );
}

function BottomItem({ item, active, onPress }: { item: (typeof NAV_ITEMS)[number]; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const fade = useFade(active);
  const isCreate = item.key === 'create';
  const color = active ? colors.primaryText : colors.textSecondaryOnSurface;
  return (
    <Pressable
      testID={item.testID}
      onPress={onPress}
      role="link"
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      style={({ pressed }) => ({ flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3, opacity: pressed ? 0.7 : 1 })}
    >
      {isCreate ? (
        <View style={{ width: 46, height: 46, borderRadius: 23, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="plus" color={colors.onPrimary} size={24} />
        </View>
      ) : (
        <>
          <Icon name={ICON[item.key as Exclude<NavKey, 'create'>]} color={color} size={24} />
          <AppText variant="small" style={{ fontSize: 11, lineHeight: 14, fontWeight: active ? '700' : '600', color, fontFamily: fontFamily.body }}>
            {item.label}
          </AppText>
          {/* the small active marker */}
          <Animated.View style={{ position: 'absolute', bottom: 0, width: 5, height: 5, borderRadius: 3, backgroundColor: colors.primaryText, opacity: fade }} />
        </>
      )}
    </Pressable>
  );
}

/** The desktop web dashboard's side navigation: brand, the four main destinations, and Profile anchored at the bottom. */
export function SideNav({ active }: { active: NavKey | null }) {
  const { colors } = useTheme();
  const go = useGo();
  const { data: profile } = useProfile();
  const main = NAV_ITEMS.filter((i) => i.key !== 'profile');
  const profileItem = NAV_ITEMS.find((i) => i.key === 'profile')!;
  const onProfile = active === 'profile';
  return (
    <View
      role="navigation"
      aria-label="Main"
      testID="side-nav"
      style={{ width: 248, backgroundColor: colors.surface, paddingVertical: spacing.lg, paddingHorizontal: spacing.md, gap: spacing.xs }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm, paddingBottom: spacing.lg }}>
        <View style={{ width: 22, height: 22, borderTopLeftRadius: 11, borderTopRightRadius: 11, borderBottomRightRadius: 11, borderBottomLeftRadius: 3, backgroundColor: colors.primary, transform: [{ rotate: '-45deg' }] }} />
        <AppText variant="heading" tone="brand">
          TripMate
        </AppText>
      </View>
      {main.map((item) => (
        <SideItem key={item.key} item={item} active={active === item.key} onPress={() => go(item.key, item.href)} />
      ))}
      {/* pushes Profile to the bottom edge whatever the window height */}
      <View style={{ flex: 1 }} />
      <Pressable
        testID={profileItem.testID}
        onPress={() => go('profile', profileItem.href)}
        role="link"
        aria-label={profile?.displayName ? `Profile, ${profile.displayName}` : 'Profile'}
        aria-current={onProfile ? 'page' : undefined}
        style={({ pressed }) => ({
          minHeight: 56,
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm + 2,
          paddingHorizontal: spacing.sm + 2,
          borderRadius: radius.md,
          backgroundColor: onProfile ? colors.surface2 : 'transparent',
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <Avatar name={profile?.displayName} size={36} testID="side-avatar" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText numberOfLines={1} testID="side-profile-name" style={{ fontWeight: '700', color: onProfile ? colors.primaryText : colors.textPrimary }}>
            {profile?.displayName ?? 'Profile'}
          </AppText>
          <AppText variant="small" tone="secondary">
            Profile
          </AppText>
        </View>
      </Pressable>
    </View>
  );
}

function SideItem({ item, active, onPress }: { item: (typeof NAV_ITEMS)[number]; active: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  const isCreate = item.key === 'create';
  const color = isCreate ? colors.onPrimary : active ? colors.primaryText : colors.textPrimary;
  return (
    <Pressable
      testID={item.testID}
      onPress={onPress}
      role="link"
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      style={({ pressed }) => ({
        minHeight: 48,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        borderRadius: radius.md,
        backgroundColor: isCreate ? colors.primary : active ? colors.surface2 : 'transparent',
        opacity: pressed ? 0.8 : 1,
        marginTop: isCreate ? spacing.sm : 0,
      })}
    >
      <Icon name={isCreate ? 'plus' : ICON[item.key as Exclude<NavKey, 'create'>]} color={color} size={22} />
      <AppText style={{ color, fontWeight: active || isCreate ? '700' : '500' }}>{item.label}</AppText>
    </Pressable>
  );
}
