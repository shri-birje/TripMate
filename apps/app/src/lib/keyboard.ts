/**
 * Which keyboard events to listen to on each platform. iOS announces the keyboard BEFORE it moves ("will"), which lets the
 * navigation bar vanish with it; Android only announces once it has moved ("did"). The web has no on-screen-keyboard events,
 * so nothing is hidden there. Pure, so it is unit-tested.
 */
export function keyboardEventNames(os: string): { show: string; hide: string } | null {
  if (os === 'ios') return { show: 'keyboardWillShow', hide: 'keyboardWillHide' };
  if (os === 'android') return { show: 'keyboardDidShow', hide: 'keyboardDidHide' };
  return null;
}

/** Whether a text field gaining focus should hide the bar at once, before the keyboard has moved. Android only (iOS already announces early). */
export const hidesOnFocus = (os: string): boolean => os === 'android';

/** How long the bar stays hidden for a keyboard that was asked for but never appears (for example a hardware keyboard is attached). */
export const KEYBOARD_REQUEST_TIMEOUT_MS = 700;

/**
 * The state behind "hide the bottom bar while typing".
 *  - `requested`: a text field just took focus and the keyboard has been asked for but has not announced itself yet (Android: the bar
 *    hides now instead of riding up above the keyboard for a few frames).
 *  - `visible`: the keyboard has announced that it is open.
 * The bar is hidden while either is true. Both are cleared by the events that end them, so the bar can never stay hidden by a field that
 * merely keeps focus: the keyboard's hide event (the keyboard's own button, tapping outside, the Android back button) clears `visible`
 * even if the field is still focused; a blur, a navigation change or the request timing out clears `requested`.
 */
export interface KeyboardNavState {
  requested: boolean;
  visible: boolean;
}

export type KeyboardNavEvent = 'focus' | 'blur' | 'show' | 'hide' | 'timeout' | 'navigate';

export const initialKeyboardNav: KeyboardNavState = { requested: false, visible: false };

export function keyboardNavReducer(state: KeyboardNavState, event: KeyboardNavEvent): KeyboardNavState {
  switch (event) {
    case 'focus':
      // Switching between fields while the keyboard is open changes nothing: it is already visible.
      return state.visible ? state : { requested: true, visible: false };
    case 'blur':
      return state.requested ? { ...state, requested: false } : state;
    case 'show':
      return { requested: false, visible: true };
    case 'hide':
      return { requested: false, visible: false };
    case 'timeout':
    case 'navigate':
      return state.requested ? { ...state, requested: false } : state;
  }
}

export const isNavHidden = (s: KeyboardNavState): boolean => s.requested || s.visible;
