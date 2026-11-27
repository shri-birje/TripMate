/** Width from which the web app uses the desktop dashboard layout (side navigation, wider content). */
export const DESKTOP_MIN_WIDTH = 1024;

export type LayoutMode = 'mobile' | 'desktop';

/** Pure: the layout for a platform and window width. Phones, tablets and narrow browser windows stay 'mobile'. */
export function layoutModeFor(os: string, width: number): LayoutMode {
  return os === 'web' && width >= DESKTOP_MIN_WIDTH ? 'desktop' : 'mobile';
}

/** Widest a page's content may be: comfortable single column on phones/tablets, a wider column on desktop. */
export function contentMaxWidth(mode: LayoutMode, width: number): number {
  if (mode === 'desktop') return 880;
  return width >= 700 ? 640 : 520;
}
