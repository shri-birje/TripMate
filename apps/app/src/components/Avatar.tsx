import { View } from 'react-native';
import { fontFamily } from '../theme/fonts';
import { useTheme } from '../theme/ThemeProvider';
import { AppText } from './AppText';
import { Icon } from './Icon';

/**
 * A circular profile avatar: the person's initial, or a user icon when there is no name yet.
 * (Profile photos are not part of the app yet; this is the default look a photo would later replace.)
 */
export function Avatar({ name, size = 40, testID }: { name?: string | null; size?: number; testID?: string }) {
  const { colors } = useTheme();
  const initial = (name ?? '').trim().charAt(0).toUpperCase();
  return (
    <View
      testID={testID}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}
    >
      {initial ? (
        <AppText style={{ color: colors.onPrimary, fontSize: Math.round(size * 0.42), lineHeight: Math.round(size * 0.5), fontWeight: '700', fontFamily: fontFamily.heading }}>{initial}</AppText>
      ) : (
        <Icon name="user" color={colors.onPrimary} size={Math.round(size * 0.55)} />
      )}
    </View>
  );
}
