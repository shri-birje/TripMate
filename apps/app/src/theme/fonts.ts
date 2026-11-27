import { Platform } from 'react-native';

/**
 * System fonts only (no font downloads). Headings use a Georgia-style serif; body text uses Segoe UI on Windows
 * browsers and the platform's own sans-serif elsewhere.
 */
export const fontFamily = {
  heading: Platform.select({
    web: "Georgia, 'Times New Roman', serif",
    ios: 'Georgia',
    default: 'serif',
  }),
  body: Platform.select({
    web: "'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', Arial, sans-serif",
    default: undefined,
  }),
};
