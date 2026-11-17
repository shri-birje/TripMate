/**
 * Design tokens. EVERY colour in the UI comes from here, never typed inline,
 * so switching theme changes the whole app in one place.
 *
 * Two complete palettes: light (the default for new users) and dark.
 * Light = warm ivory + forest green. Dark = deep charcoal + dark forest-green
 * surfaces with muted green highlights (never pure black).
 */
export interface ColorTokens {
  background: string; // screen background
  surface: string; // cards, inputs
  border: string;
  textPrimary: string;
  textSecondary: string;
  primary: string; // main actions, brand
  onPrimary: string; // text/icons on top of `primary`
  sage: string; // soft accent
  statusOk: string; // settled / healthy
  statusWarn: string; // pending
  statusError: string; // problems
}

export const lightColors: ColorTokens = {
  background: '#F6F2E9', // warm ivory
  surface: '#FCFAF5', // soft off-white
  border: '#DDD5C2', // sand
  textPrimary: '#22281F', // charcoal-green
  textSecondary: '#5F6559', // muted grey-green
  primary: '#1F4D3A', // deep forest green
  onPrimary: '#FFFFFF',
  sage: '#9DB39A',
  statusOk: '#2B7048',
  statusWarn: '#8F5F12',
  statusError: '#A63F34',
};

export const darkColors: ColorTokens = {
  background: '#121614', // deep charcoal
  surface: '#1B2520', // dark forest green
  border: '#33423A',
  textPrimary: '#ECE8DD', // soft off-white
  textSecondary: '#A9AFA3',
  primary: '#7FB08F', // muted green highlight
  onPrimary: '#0E1812',
  sage: '#6E8B73',
  statusOk: '#74C792',
  statusWarn: '#E0AC55',
  statusError: '#E8897F',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { md: 12, lg: 16 } as const;
export const fontSize = { small: 13, body: 16, heading: 18, title: 28 } as const;
