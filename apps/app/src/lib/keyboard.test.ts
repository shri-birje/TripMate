import { describe, expect, it } from 'vitest';
import { hidesOnFocus, initialKeyboardNav, isNavHidden, keyboardEventNames, keyboardNavReducer, type KeyboardNavEvent } from './keyboard';

describe('keyboardEventNames', () => {
  it('iOS listens to the "will" events so the bar leaves with the keyboard', () => {
    expect(keyboardEventNames('ios')).toEqual({ show: 'keyboardWillShow', hide: 'keyboardWillHide' });
  });
  it('Android only has the "did" events', () => {
    expect(keyboardEventNames('android')).toEqual({ show: 'keyboardDidShow', hide: 'keyboardDidHide' });
  });
  it('the web has no keyboard events, so the navigation is never hidden there', () => {
    expect(keyboardEventNames('web')).toBeNull();
  });
});

describe('hidesOnFocus', () => {
  it('only Android hides the bar on focus; iOS keeps its existing early keyboard events and the web never hides it', () => {
    expect(hidesOnFocus('android')).toBe(true);
    expect(hidesOnFocus('ios')).toBe(false);
    expect(hidesOnFocus('web')).toBe(false);
  });
});

const run = (...events: KeyboardNavEvent[]) => events.reduce(keyboardNavReducer, initialKeyboardNav);

describe('keyboard navigation state', () => {
  it('starts with the bar showing', () => {
    expect(isNavHidden(initialKeyboardNav)).toBe(false);
  });
  it('hides the bar the moment a field takes focus, before the keyboard has announced itself', () => {
    expect(isNavHidden(run('focus'))).toBe(true);
  });
  it('stays hidden when the keyboard then opens, and returns when it closes', () => {
    expect(isNavHidden(run('focus', 'show'))).toBe(true);
    expect(isNavHidden(run('focus', 'show', 'hide'))).toBe(false);
  });
  it('Android back button: the keyboard closes while the field keeps focus, and the bar still comes back', () => {
    // no blur event is sent: only the keyboard's hide event
    expect(isNavHidden(run('focus', 'show', 'hide'))).toBe(false);
  });
  it('switching between fields keeps it hidden (blur then focus while the keyboard stays open)', () => {
    expect(isNavHidden(run('focus', 'show', 'blur', 'focus'))).toBe(true);
    expect(isNavHidden(run('focus', 'show', 'blur', 'focus', 'hide'))).toBe(false);
  });
  it('a keyboard that is asked for but never opens (hardware keyboard) gives the bar back when the wait times out', () => {
    expect(isNavHidden(run('focus', 'timeout'))).toBe(false);
  });
  it('a field that loses focus before the keyboard appears does not leave the bar hidden', () => {
    expect(isNavHidden(run('focus', 'blur'))).toBe(false);
  });
  it('changing screen while a request is pending does not leave the bar hidden', () => {
    expect(isNavHidden(run('focus', 'navigate'))).toBe(false);
  });
  it('an open keyboard survives a screen change (its own hide event ends it), so the bar does not pop up over it', () => {
    expect(isNavHidden(run('focus', 'show', 'navigate'))).toBe(true);
    expect(isNavHidden(run('focus', 'show', 'navigate', 'hide'))).toBe(false);
  });
  it('a stray hide or blur on a fresh state changes nothing', () => {
    expect(run('hide')).toEqual(initialKeyboardNav);
    expect(run('blur')).toEqual(initialKeyboardNav);
  });
  it('a long random sequence always ends with the bar showing after a hide event', () => {
    const events: KeyboardNavEvent[] = ['focus', 'blur', 'show', 'hide', 'timeout', 'navigate'];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    let s = initialKeyboardNav;
    for (let i = 0; i < 2000; i += 1) {
      s = keyboardNavReducer(s, events[next() % events.length]!);
    }
    expect(isNavHidden(keyboardNavReducer(s, 'hide'))).toBe(false);
  });
});
