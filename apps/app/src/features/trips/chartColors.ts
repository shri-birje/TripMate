import { UNCATEGORIZED_KEY } from '@tripmate/core';
import type { Scheme } from '../../theme/scheme';
import type { IconName } from '../../components/Icon';

/**
 * One muted, nature-inspired colour per category, used by BOTH the bar chart and the donut chart so a category always looks the same.
 * Order: forest, sage, olive, ocean, timber, ochre, terracotta, grey. The seven system categories take the first seven (in their list
 * order); Uncategorized is always the neutral grey. Light and dark each have their own tuning so every colour stays visible against the card.
 */
export const CHART_PALETTE: Record<Scheme, readonly string[]> = {
  light: ['#2F5D44', '#5B8A68', '#7A7A2E', '#3F7A85', '#7A5232', '#A8741A', '#B0573D', '#6F6F6F'],
  dark: ['#4E8A68', '#8DBB98', '#B0B058', '#6FA3A8', '#B88A5E', '#D9A441', '#D9806A', '#9A9A9A'],
};

export function categoryColor(key: string, colorIndex: number, scheme: Scheme): string {
  const palette = CHART_PALETTE[scheme];
  if (key === UNCATEGORIZED_KEY) return palette[palette.length - 1]!;
  return palette[colorIndex % (palette.length - 1)]!; // the last colour is reserved for Uncategorized
}

const ICONS: Record<string, IconName> = {
  bus: 'bus',
  bed: 'bed',
  utensils: 'utensils',
  'shopping-bag': 'bag',
  ticket: 'ticket',
  fuel: 'fuel',
  dots: 'dots',
};

/** The drawn icon for a category's stored icon name. Unknown names and "no category" use the tag icon. */
export function categoryIconName(icon: string | null | undefined): IconName {
  return (icon ? ICONS[icon] : undefined) ?? 'tag';
}
