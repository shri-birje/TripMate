import { Platform, useWindowDimensions } from 'react-native';
import { layoutModeFor, type LayoutMode } from './layout';

export function useLayoutMode(): LayoutMode {
  const { width } = useWindowDimensions();
  return layoutModeFor(Platform.OS, width);
}
