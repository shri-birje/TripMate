import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import {
  THEME_STORAGE_KEY,
  loadThemePreference,
  resolveScheme,
  saveThemePreference,
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

describe('resolveScheme', () => {
  it('light and dark ignore the device setting', () => {
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
  });
  it('system follows the device', () => {
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'light')).toBe('light');
  });
  it('system with an unknown device setting falls back to light', () => {
    expect(resolveScheme('system', null)).toBe('light');
    expect(resolveScheme('system', undefined)).toBe('light');
    expect(resolveScheme('system', 'unspecified')).toBe('light');
  });
});

describe('theme persistence on this device', () => {
  it('first launch (nothing saved) is LIGHT, even if the device is in dark mode', async () => {
    expect(await loadThemePreference(memoryStore())).toBe('light');
    // the device setting is only consulted when the user explicitly chose "system"
    expect(resolveScheme(await loadThemePreference(memoryStore()), 'dark')).toBe('light');
  });

  it('remembers each choice across restarts', async () => {
    for (const pref of ['light', 'dark', 'system'] as const) {
      const store = memoryStore();
      await saveThemePreference(store, pref);
      expect(await loadThemePreference(store)).toBe(pref);
    }
  });

  it('ignores a corrupt saved value and uses light', async () => {
    expect(await loadThemePreference(memoryStore({ [THEME_STORAGE_KEY]: 'neon' }))).toBe('light');
    expect(await loadThemePreference(memoryStore({ [THEME_STORAGE_KEY]: '' }))).toBe('light');
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
    expect(await loadThemePreference(broken)).toBe('light');
    await expect(saveThemePreference(broken, 'dark')).resolves.toBeUndefined();
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

  it('dark never uses pure black or pure white as the background', () => {
    expect(darkColors.background.toLowerCase()).not.toBe('#000000');
    expect(darkColors.background.toLowerCase()).not.toBe('#ffffff');
    expect(lightColors.background.toLowerCase()).not.toBe('#ffffff');
  });

  describe.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as const)('%s palette is readable (WCAG AA: 4.5 : 1 for text)', (_name, c) => {
    it('main text on background and cards', () => {
      expect(contrastRatio(c.textPrimary, c.background)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(c.textPrimary, c.surface)).toBeGreaterThanOrEqual(7);
    });
    it('secondary text on background and cards', () => {
      expect(contrastRatio(c.textSecondary, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.textSecondary, c.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it('button text on the primary colour', () => {
      expect(contrastRatio(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
    });
    it('links and brand text (primary) on background and cards', () => {
      expect(contrastRatio(c.primary, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(c.primary, c.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it('status colours used as text on cards', () => {
      for (const s of [c.statusOk, c.statusWarn, c.statusError]) {
        expect(contrastRatio(s, c.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(s, c.background)).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});
