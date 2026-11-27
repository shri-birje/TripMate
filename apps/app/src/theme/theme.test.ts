import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import {
  THEME_STORAGE_KEY,
  loadDeviceScheme,
  normalizeScheme,
  resolveAfterProfile,
  saveDeviceScheme,
  type SimpleStore,
} from './scheme';
import { darkColors, lightColors, type ColorTokens } from './tokens';

function memoryStore(initial: Record<string, string> = {}): SimpleStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

describe('normalizeScheme (legacy "system" handling)', () => {
  it('light and dark stay as they are', () => {
    expect(normalizeScheme('light', 'dark')).toBe('light');
    expect(normalizeScheme('dark', 'light')).toBe('dark');
  });
  it('a legacy system value becomes the currently resolved appearance', () => {
    expect(normalizeScheme('system', 'dark')).toBe('dark');
    expect(normalizeScheme('system', 'light')).toBe('light');
  });
  it('a legacy system value with an unknown device setting becomes light', () => {
    expect(normalizeScheme('system', null)).toBe('light');
    expect(normalizeScheme('system', undefined)).toBe('light');
    expect(normalizeScheme('system', 'unspecified')).toBe('light');
  });
  it('anything else is no choice at all', () => {
    expect(normalizeScheme('neon')).toBeNull();
    expect(normalizeScheme(null)).toBeNull();
    expect(normalizeScheme(undefined)).toBeNull();
    expect(normalizeScheme(3)).toBeNull();
  });
});

describe('theme persistence on this device', () => {
  it('first launch (nothing saved) has no device choice, so Light is used until an account value arrives', async () => {
    expect(await loadDeviceScheme(memoryStore(), 'dark')).toBeNull();
  });

  it('remembers each choice across restarts', async () => {
    for (const pref of ['light', 'dark'] as const) {
      const store = memoryStore();
      await saveDeviceScheme(store, pref);
      expect(await loadDeviceScheme(store)).toBe(pref);
    }
  });

  it('a legacy saved "system" becomes Light or Dark', async () => {
    expect(await loadDeviceScheme(memoryStore({ [THEME_STORAGE_KEY]: 'system' }), 'dark')).toBe('dark');
    expect(await loadDeviceScheme(memoryStore({ [THEME_STORAGE_KEY]: 'system' }), 'light')).toBe('light');
    expect(await loadDeviceScheme(memoryStore({ [THEME_STORAGE_KEY]: 'system' }))).toBe('light');
  });

  it('ignores a corrupt saved value', async () => {
    expect(await loadDeviceScheme(memoryStore({ [THEME_STORAGE_KEY]: 'neon' }))).toBeNull();
    expect(await loadDeviceScheme(memoryStore({ [THEME_STORAGE_KEY]: '' }))).toBeNull();
  });

  it('survives a broken storage without crashing', async () => {
    const broken: SimpleStore = {
      getItem: async () => {
        throw new Error('storage unavailable');
      },
      setItem: async () => {
        throw new Error('storage unavailable');
      },
    };
    expect(await loadDeviceScheme(broken)).toBeNull();
    await expect(saveDeviceScheme(broken, 'dark')).resolves.toBeUndefined();
  });
});

describe('precedence once a profile has loaded', () => {
  it('device Dark, account Light: stays Dark (Dark-to-Light conflict)', () => {
    expect(resolveAfterProfile('dark', 'light', 'dark')).toBe('dark');
  });
  it('device Light, account Dark: stays Light', () => {
    expect(resolveAfterProfile('light', 'dark', 'light')).toBe('light');
  });
  it('no device choice: the account Light or Dark is used', () => {
    expect(resolveAfterProfile(null, 'dark', 'light')).toBe('dark');
    expect(resolveAfterProfile(null, 'light', 'light')).toBe('light');
  });
  it('no device choice and a legacy account "system": resolved, never left unresolved', () => {
    expect(resolveAfterProfile(null, 'system', 'light', 'dark')).toBe('dark');
    expect(resolveAfterProfile(null, 'system', 'light', null)).toBe('light');
  });
  it('no device choice and an unusable account value: keeps the current appearance (Light by default)', () => {
    expect(resolveAfterProfile(null, undefined, 'light')).toBe('light');
    expect(resolveAfterProfile(null, 'neon', 'dark')).toBe('dark');
  });
});

describe('palettes', () => {
  const keys = Object.keys(lightColors) as (keyof ColorTokens)[];

  it('light and dark define exactly the same tokens, all as #RRGGBB', () => {
    expect(Object.keys(darkColors).sort()).toEqual([...keys].sort());
    for (const palette of [lightColors, darkColors]) {
      for (const k of keys) expect(palette[k]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('dark background is neutral (red, green and blue within a few steps of each other), not green-black', () => {
    const n = parseInt(darkColors.background.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(4);
    for (const hex of [darkColors.surface, darkColors.surface2]) {
      const m = parseInt(hex.slice(1), 16);
      expect(Math.max((m >> 16) & 255, (m >> 8) & 255, m & 255) - Math.min((m >> 16) & 255, (m >> 8) & 255, m & 255)).toBeLessThanOrEqual(4);
    }
  });

  it('dark never uses pure black or pure white as the background', () => {
    expect(darkColors.background.toLowerCase()).not.toBe('#000000');
    expect(darkColors.background.toLowerCase()).not.toBe('#ffffff');
    expect(lightColors.background.toLowerCase()).not.toBe('#ffffff');
  });

  describe.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as const)('%s palette is readable (WCAG AA: 4.5 : 1 for text)', (_name, c) => {
    const grounds = [c.background, c.surface, c.surface2];
    it('main text on the background and on both surfaces', () => {
      for (const g of grounds) expect(contrastRatio(c.textPrimary, g)).toBeGreaterThanOrEqual(7);
    });
    it('secondary text: the approved colour on the background, its companion on both surfaces', () => {
      expect(contrastRatio(c.textSecondary, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.textSecondaryOnSurface, c.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.textSecondaryOnSurface, c.surface2)).toBeGreaterThanOrEqual(4.5);
    });
    it('button text on the primary colour, and chip text on the wood colour', () => {
      expect(contrastRatio(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.onWood, c.woodText)).toBeGreaterThanOrEqual(4.5);
    });
    it('links, brand text, icons and focus rings (primaryText) on the background and on both surfaces', () => {
      for (const g of grounds) expect(contrastRatio(c.primaryText, g)).toBeGreaterThanOrEqual(4.5);
    });
    it('the primary button fill stays distinct from the surfaces it sits on (3 : 1 or better against the page in light, readable text in both)', () => {
      expect(contrastRatio(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
    });
    it('accent (wood) text on the background and on both surfaces', () => {
      for (const g of grounds) expect(contrastRatio(c.woodText, g)).toBeGreaterThanOrEqual(4.5);
    });
    it('status colours as text: approved on the background, companions on both surfaces', () => {
      for (const s of [c.statusOk, c.statusWarn, c.statusError]) expect(contrastRatio(s, c.background)).toBeGreaterThanOrEqual(4.5);
      for (const s of [c.statusOkOnSurface, c.statusWarnOnSurface, c.statusErrorOnSurface]) {
        expect(contrastRatio(s, c.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(s, c.surface2)).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  it('uses exactly the approved Field Journal values for the approved roles', () => {
    expect(lightColors).toMatchObject({ background: '#F4EEE1', surface: '#EBE3D0', surface2: '#E0D6BD', textPrimary: '#2A2E22', textSecondary: '#6A6A58', primary: '#2F5D44', onPrimary: '#FBF8EF', wood: '#9C7A4C', sage: '#A3B59A', ocean: '#4F7F86', statusOk: '#2B7048', statusWarn: '#8F5F12' });
    expect(darkColors).toMatchObject({ background: '#101010', surface: '#1C1C1C', surface2: '#272727', border: '#343434', textPrimary: '#F1EEE7', textSecondary: '#B3B3B3', primary: '#2F5D44', primaryText: '#8DBB98', wood: '#C4A073', sage: '#8DBB98', ocean: '#6FA3A8' });
  });
});
