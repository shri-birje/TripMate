import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, navPlan } from './navigation';
import { DESKTOP_MIN_WIDTH, contentMaxWidth, layoutModeFor } from './layout';

describe('navPlan', () => {
  it('main destinations show the navigation with the right one active', () => {
    expect(navPlan('/')).toEqual({ visible: true, active: 'home' });
    expect(navPlan('/search')).toEqual({ visible: true, active: 'search' });
    expect(navPlan('/archived')).toEqual({ visible: true, active: 'archived' });
    expect(navPlan('/profile')).toEqual({ visible: true, active: 'profile' });
  });
  it('trip pages keep the navigation, with Home active', () => {
    expect(navPlan('/trips/abc')).toEqual({ visible: true, active: 'home' });
    expect(navPlan('/trips/abc/expenses')).toEqual({ visible: true, active: 'home' });
    expect(navPlan('/trips/abc/expenses/e1')).toEqual({ visible: true, active: 'home' });
  });
  it('full-screen forms and Settings hide it', () => {
    expect(navPlan('/trips/new').visible).toBe(false);
    expect(navPlan('/trips/new').active).toBe('create');
    expect(navPlan('/trips/abc/edit').visible).toBe(false);
    expect(navPlan('/trips/abc/expenses/new').visible).toBe(false);
    expect(navPlan('/trips/abc/expenses/e1/edit').visible).toBe(false);
    expect(navPlan('/settings')).toEqual({ visible: false, active: 'profile' });
  });
  it('ignores a trailing slash; unknown addresses show nothing', () => {
    expect(navPlan('/search/')).toEqual({ visible: true, active: 'search' });
    expect(navPlan('/nowhere')).toEqual({ visible: false, active: null });
  });
  it('has exactly the five approved destinations in order, and no Settings item', () => {
    expect(NAV_ITEMS.map((i) => i.key)).toEqual(['home', 'search', 'create', 'archived', 'profile']);
    expect(NAV_ITEMS.find((i) => i.key === 'create')?.href).toBe('/trips/new');
  });
});

describe('layout mode', () => {
  it('only the web at desktop width uses the desktop dashboard', () => {
    expect(layoutModeFor('web', DESKTOP_MIN_WIDTH)).toBe('desktop');
    expect(layoutModeFor('web', DESKTOP_MIN_WIDTH - 1)).toBe('mobile');
    expect(layoutModeFor('android', 2000)).toBe('mobile');
    expect(layoutModeFor('ios', 2000)).toBe('mobile');
  });
  it('content width grows with the layout', () => {
    expect(contentMaxWidth('mobile', 360)).toBe(520);
    expect(contentMaxWidth('mobile', 820)).toBe(640);
    expect(contentMaxWidth('desktop', 1440)).toBe(880);
  });
});
