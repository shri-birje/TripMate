import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../theme/contrast';
import { darkColors, lightColors } from '../../theme/tokens';
import { donutTiles } from '../../lib/donut';
import { CHART_PALETTE, categoryColor, categoryIconName } from './chartColors';

describe('chart palette', () => {
  it('has eight distinct colours in each theme', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(new Set(CHART_PALETTE[scheme]).size).toBe(8);
    }
  });
  it('every colour is visible against the card it is drawn on (at least 3:1, the non-text minimum)', () => {
    for (const c of CHART_PALETTE.light) expect(contrastRatio(c, lightColors.surface)).toBeGreaterThanOrEqual(3);
    for (const c of CHART_PALETTE.dark) expect(contrastRatio(c, darkColors.surface)).toBeGreaterThanOrEqual(3);
  });
  it('the same category gets the same colour for the bars and the donut, and uncategorized is the neutral grey', () => {
    expect(categoryColor('food', 2, 'light')).toBe(categoryColor('food', 2, 'light'));
    expect(categoryColor('uncategorized', 7, 'light')).toBe('#6F6F6F');
    expect(categoryColor('uncategorized', 99, 'dark')).toBe('#9A9A9A');
    expect(categoryColor('transportation', 0, 'light')).toBe(CHART_PALETTE.light[0]);
  });
  it('maps the stored icon names to drawn icons, with a tag for anything unknown', () => {
    expect(categoryIconName('utensils')).toBe('utensils');
    expect(categoryIconName('shopping-bag')).toBe('bag');
    expect(categoryIconName('mystery')).toBe('tag');
    expect(categoryIconName(null)).toBe('tag');
  });
});

describe('donutTiles', () => {
  it('no spending draws nothing', () => {
    expect(donutTiles([])).toEqual([]);
    expect(donutTiles([0, 0])).toEqual([]);
  });
  it('one category fills every tile', () => {
    const t = donutTiles([1000]);
    expect(t).toHaveLength(240);
    expect(t.every((x) => x.segment === 0)).toBe(true);
  });
  it('tiles are shared in proportion and in order, starting at the top', () => {
    const t = donutTiles([500, 250, 250]);
    const count = (s: number) => t.filter((x) => x.segment === s).length;
    expect([count(0), count(1), count(2)]).toEqual([120, 60, 60]);
    expect(t[0]!.segment).toBe(0);
    expect(t[239]!.segment).toBe(2);
    expect(t[0]!.angle).toBeCloseTo(0.75);
  });
});
