import { createContext, useContext } from 'react';

/**
 * Tells text whether it sits directly on the page background or on a tonal surface (a card or panel).
 * `AppText` reads it to pick the accessible text colour for that surface (see theme/tokens.ts).
 */
export type SurfaceLevel = 'page' | 'surface';
export const SurfaceContext = createContext<SurfaceLevel>('page');
export const useSurface = () => useContext(SurfaceContext);
