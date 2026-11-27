import { Platform } from 'react-native';
import { KEYBOARD_REQUEST_TIMEOUT_MS, hidesOnFocus, initialKeyboardNav, keyboardNavReducer, type KeyboardNavEvent, type KeyboardNavState } from './keyboard';

/**
 * One shared "is the keyboard coming or open" state for the whole app (see `keyboard.ts` for the rules). Text fields report focus and blur
 * here, the bottom bar listens, and `useKeyboardVisible` feeds it the platform's keyboard events. Nothing is persisted.
 */
let state: KeyboardNavState = initialKeyboardNav;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

export function dispatchKeyboardNav(event: KeyboardNavEvent): void {
  const next = keyboardNavReducer(state, event);
  clearTimer();
  if (next.requested) {
    // A keyboard that was asked for but never opens must not leave the bar hidden.
    timer = setTimeout(() => dispatchKeyboardNav('timeout'), KEYBOARD_REQUEST_TIMEOUT_MS);
  }
  if (next === state) return;
  state = next;
  listeners.forEach((l) => l());
}

export const subscribeKeyboardNav = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getKeyboardNavState = (): KeyboardNavState => state;

/** Called by text fields. Only does anything on Android, where the keyboard would otherwise announce itself too late. */
export function reportFieldFocus(): void {
  if (hidesOnFocus(Platform.OS)) dispatchKeyboardNav('focus');
}
export function reportFieldBlur(): void {
  if (hidesOnFocus(Platform.OS)) dispatchKeyboardNav('blur');
}

/** For tests: back to the start. */
export function resetKeyboardNav(): void {
  clearTimer();
  state = initialKeyboardNav;
  listeners.forEach((l) => l());
}
