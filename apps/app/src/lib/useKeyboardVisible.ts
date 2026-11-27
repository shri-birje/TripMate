import { usePathname } from 'expo-router';
import { useEffect, useSyncExternalStore } from 'react';
import { Keyboard, Platform } from 'react-native';
import { isNavHidden } from './keyboard';
import { keyboardEventNames } from './keyboard';
import { dispatchKeyboardNav, getKeyboardNavState, subscribeKeyboardNav } from './keyboardNav';

/**
 * True while the on-screen keyboard is open or has just been asked for (native only; always false on the web). The bottom navigation uses
 * it to step out of the way: it disappears the moment a text field takes focus (Android) or when the keyboard announces itself (iOS "will"
 * events), and returns when the keyboard closes by any route (the keyboard's own button, tapping outside, or the Android back button,
 * which all end in the "hide" event, even if the field still has focus). Switching fields keeps it hidden; changing screen, a blur, or a
 * keyboard that never opens (a hardware keyboard) can never leave it hidden. Listeners are removed when the component goes away.
 */
export function useKeyboardVisible(): boolean {
  const state = useSyncExternalStore(subscribeKeyboardNav, getKeyboardNavState, getKeyboardNavState);
  const pathname = usePathname();

  useEffect(() => {
    const names = keyboardEventNames(Platform.OS);
    if (!names) return;
    const show = Keyboard.addListener(names.show as 'keyboardDidShow', () => dispatchKeyboardNav('show'));
    const hide = Keyboard.addListener(names.hide as 'keyboardDidHide', () => dispatchKeyboardNav('hide'));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Moving to another screen ends any pending request (an open keyboard still reports its own hide event).
  useEffect(() => {
    dispatchKeyboardNav('navigate');
  }, [pathname]);

  return isNavHidden(state);
}
