/**
 * Design tokens - "Field Journal" identity (approved UI redesign). EVERY colour in the UI comes from here,
 * never typed inline, so switching theme changes the whole app in one place.
 *
 * Two complete palettes: light (the default for new users) = warm ivory + forest green with sand, sage, wood and
 * muted-ocean accents; dark = neutral charcoal (never pure black, not green-black) with forest-green buttons and sage, ocean and wood accents.
 *
 * The HEX values for the approved roles (background, surface, surface2, textPrimary, textSecondary, primary, onPrimary,
 * wood, sage, ocean, success = statusOk, warning = statusWarn) are exactly the approved ones. Because a few of them
 * (secondary text, wood, ocean, success, warning) fall just under the 4.5:1 text-contrast minimum when they sit on
 * the tonal SURFACES in the light theme, each has an `…OnSurface` / `…Text` companion that is the same hue, slightly
 * deeper. `AppText` switches to it automatically inside a Card/Panel, so the approved colour is used on the page
 * background and the accessible one on surfaces. In dark the companions equal the approved values.
 */
export interface ColorTokens {
  background: string; // screen background
  surface: string; // Surface 1: cards, inputs, tonal bands
  surface2: string; // Surface 2: emphasis panels, selected tonal fills
  border: string; // used only where a boundary is functionally needed (focus ring, input outline on error)
  textPrimary: string;
  textSecondary: string;
  primary: string; // fill of main actions and brand marks (buttons, the Create circle, status chips); pair with onPrimary
  primaryText: string; // primary-coloured TEXT, icons, indicators and focus rings (on dark, the forest-green fill is too dark for these)
  onPrimary: string; // text/icons on top of `primary`
  wood: string; // wood accent (decorative marks, upcoming badge fill)
  onWood: string; // text on `wood`
  sage: string; // soft accent
  ocean: string; // muted ocean accent
  statusOk: string; // success / settled
  statusWarn: string; // warning / pending
  statusError: string; // problems
  // Accessible companions for text that sits on a surface (see the note above).
  textSecondaryOnSurface: string;
  woodText: string;
  statusOkOnSurface: string;
  statusWarnOnSurface: string;
  statusErrorOnSurface: string;
}

export const lightColors: ColorTokens = {
  background: '#F4EEE1', // warm ivory
  surface: '#EBE3D0', // sand
  surface2: '#E0D6BD', // deeper sand
  border: '#D3C8AC',
  textPrimary: '#2A2E22', // charcoal-green
  textSecondary: '#6A6A58', // muted grey-green
  primary: '#2F5D44', // forest green
  primaryText: '#2F5D44',
  onPrimary: '#FBF8EF',
  wood: '#9C7A4C',
  onWood: '#FBF8EF',
  sage: '#A3B59A',
  ocean: '#4F7F86',
  statusOk: '#2B7048',
  statusWarn: '#8F5F12',
  statusError: '#A63F34',
  textSecondaryOnSurface: '#5D5D4D',
  woodText: '#705837',
  statusOkOnSurface: '#286843',
  statusWarnOnSurface: '#7C5310',
  statusErrorOnSurface: '#9E3C31',
};

export const darkColors: ColorTokens = {
  // Neutral charcoal (not green-black); nature shows in the accents. The forest-green FILL (#2F5D44) is too dark to read as
  // text on these backgrounds, so text/icons/indicators use `primaryText` (sage).
  background: '#101010',
  surface: '#1C1C1C',
  surface2: '#272727',
  border: '#343434',
  textPrimary: '#F1EEE7', // warm off-white
  textSecondary: '#B3B3B3',
  primary: '#2F5D44',
  primaryText: '#8DBB98',
  onPrimary: '#F1EEE7',
  wood: '#C4A073',
  onWood: '#14110A',
  sage: '#8DBB98',
  ocean: '#6FA3A8',
  statusOk: '#74C792',
  statusWarn: '#E0AC55',
  statusError: '#E8897F',
  textSecondaryOnSurface: '#B3B3B3',
  woodText: '#C4A073',
  statusOkOnSurface: '#74C792',
  statusWarnOnSurface: '#E0AC55',
  statusErrorOnSurface: '#E8897F',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
/** md = controls (12), lg = cards (18), xl = large website panels (28). */
export const radius = { md: 12, lg: 18, xl: 28 } as const;
export const fontSize = { small: 13, body: 16, heading: 18, title: 28 } as const;

/** Motion: durations in ms (approved directions). With reduced motion on they become 0 (see `motion.ts`). */
export const motion = { tab: 220, split: 180, screen: 200, nav: 160, press: 90 } as const;
