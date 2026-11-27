/**
 * Which main destination is "current" for a given address, and whether the persistent navigation is shown.
 * Pure (no React), so it is unit-tested. The navigation is hidden on full-screen forms (typing with the keyboard open)
 * and on Settings; everywhere else in the signed-in app it stays in place.
 */
export type NavKey = 'home' | 'search' | 'create' | 'archived' | 'profile';

export interface NavPlan {
  /** Show the bottom bar (phones) / side rail (desktop web). */
  visible: boolean;
  /** The highlighted destination, or null when none applies. */
  active: NavKey | null;
}

export function navPlan(pathname: string): NavPlan {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/' || path === '') return { visible: true, active: 'home' };
  if (path === '/search') return { visible: true, active: 'search' };
  if (path === '/archived') return { visible: true, active: 'archived' };
  if (path === '/profile') return { visible: true, active: 'profile' };
  if (path === '/settings') return { visible: false, active: 'profile' };
  if (path === '/trips/new') return { visible: false, active: 'create' };
  if (/^\/trips\/[^/]+$/.test(path)) return { visible: true, active: 'home' };
  if (/^\/trips\/[^/]+\/expenses$/.test(path)) return { visible: true, active: 'home' };
  // an expense's own page is a reading screen; its forms (new, edit) and the trip edit form are full-screen
  if (/^\/trips\/[^/]+\/expenses\/(?!new$)[^/]+$/.test(path)) return { visible: true, active: 'home' };
  if (/^\/trips\/.+/.test(path)) return { visible: false, active: 'home' };
  return { visible: false, active: null };
}

export const NAV_ITEMS: readonly { key: NavKey; label: string; href: '/' | '/search' | '/trips/new' | '/archived' | '/profile'; testID: string }[] = [
  { key: 'home', label: 'Home', href: '/', testID: 'nav-home' },
  { key: 'search', label: 'Search', href: '/search', testID: 'nav-search' },
  { key: 'create', label: 'Create trip', href: '/trips/new', testID: 'nav-create' },
  { key: 'archived', label: 'Archived', href: '/archived', testID: 'nav-archived' },
  { key: 'profile', label: 'Profile', href: '/profile', testID: 'nav-profile' },
];
