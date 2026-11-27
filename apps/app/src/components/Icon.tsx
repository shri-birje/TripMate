import type { ReactElement } from 'react';
import { View, type ViewStyle } from 'react-native';

export type IconName = 'home' | 'search' | 'plus' | 'archive' | 'user' | 'gear' | 'back' | 'check' | 'users' | 'split' | 'scale' | 'link' | 'clock' | 'route' | 'sun' | 'moon' | 'bus' | 'bed' | 'utensils' | 'bag' | 'ticket' | 'fuel' | 'dots' | 'tag' | 'chevron' | 'arrowRight' | 'copy';

/**
 * Small line icons drawn from plain shapes (no icon library and no SVG dependency), so they look the same on
 * Android, iOS and the web, and take their colour from the caller (so they follow the theme).
 * They are decorative: the control that holds one must carry the accessible label.
 */
export function Icon({ name, color, size = 24 }: { name: IconName; color: string; size?: number }) {
  const s = size;
  const sw = Math.max(1.6, s / 12);
  const box: ViewStyle = { width: s, height: s };
  const abs: ViewStyle = { position: 'absolute' };
  let body: ReactElement;

  switch (name) {
    case 'home':
      body = (
        <>
          {/* roof: the top-left corner of a turned square */}
          <View style={{ ...abs, left: s * 0.26, top: s * 0.2, width: s * 0.48, height: s * 0.48, borderLeftWidth: sw, borderTopWidth: sw, borderColor: color, borderTopLeftRadius: sw, transform: [{ rotate: '45deg' }] }} />
          {/* walls */}
          <View style={{ ...abs, left: s * 0.2, top: s * 0.46, width: s * 0.6, height: s * 0.4, borderLeftWidth: sw, borderRightWidth: sw, borderBottomWidth: sw, borderColor: color, borderBottomLeftRadius: sw, borderBottomRightRadius: sw }} />
          {/* door */}
          <View style={{ ...abs, left: s * 0.43, top: s * 0.62, width: s * 0.14, height: s * 0.24, backgroundColor: color, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
        </>
      );
      break;
    case 'search':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.12, top: s * 0.12, width: s * 0.58, height: s * 0.58, borderRadius: s, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.58, top: s * 0.74, width: s * 0.36, height: sw, borderRadius: sw, backgroundColor: color, transform: [{ rotate: '45deg' }] }} />
        </>
      );
      break;
    case 'plus':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.18, top: (s - sw) / 2, width: s * 0.64, height: sw, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, top: s * 0.18, left: (s - sw) / 2, height: s * 0.64, width: sw, borderRadius: sw, backgroundColor: color }} />
        </>
      );
      break;
    case 'archive':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.1, top: s * 0.16, width: s * 0.8, height: s * 0.22, borderWidth: sw, borderColor: color, borderRadius: 3 }} />
          <View style={{ ...abs, left: s * 0.18, top: s * 0.36, width: s * 0.64, height: s * 0.48, borderLeftWidth: sw, borderRightWidth: sw, borderBottomWidth: sw, borderColor: color, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 }} />
          <View style={{ ...abs, left: s * 0.38, top: s * 0.5, width: s * 0.24, height: sw, borderRadius: sw, backgroundColor: color }} />
        </>
      );
      break;
    case 'user':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.3, top: s * 0.1, width: s * 0.4, height: s * 0.4, borderRadius: s, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.14, top: s * 0.58, width: s * 0.72, height: s * 0.3, borderTopLeftRadius: s, borderTopRightRadius: s, borderTopWidth: sw, borderLeftWidth: sw, borderRightWidth: sw, borderColor: color }} />
        </>
      );
      break;
    case 'gear':
      body = (
        <>
          {/* eight short square teeth around the outside ... */}
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
            <View key={deg} style={{ ...abs, ...box, alignItems: 'center', transform: [{ rotate: `${deg}deg` }] }}>
              <View style={{ width: s * 0.2, height: s * 0.17, marginTop: s * 0.03, borderRadius: 1.5, backgroundColor: color }} />
            </View>
          ))}
          {/* ... a round body drawn as an outline, like the other icons ... */}
          <View style={{ ...abs, left: s * 0.19, top: s * 0.19, width: s * 0.62, height: s * 0.62, borderRadius: s, borderWidth: sw * 1.4, borderColor: color }} />
          {/* ... and a clear circular hole in the middle */}
          <View style={{ ...abs, left: s * 0.39, top: s * 0.39, width: s * 0.22, height: s * 0.22, borderRadius: s, borderWidth: sw, borderColor: color }} />
        </>
      );
      break;
    case 'users':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.08, top: s * 0.2, width: s * 0.34, height: s * 0.34, borderRadius: s, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.02, top: s * 0.62, width: s * 0.46, height: s * 0.26, borderTopLeftRadius: s, borderTopRightRadius: s, borderTopWidth: sw, borderLeftWidth: sw, borderRightWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.54, top: s * 0.28, width: s * 0.3, height: s * 0.3, borderRadius: s, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.52, top: s * 0.66, width: s * 0.4, height: s * 0.22, borderTopLeftRadius: s, borderTopRightRadius: s, borderTopWidth: sw, borderLeftWidth: sw, borderRightWidth: sw, borderColor: color }} />
        </>
      );
      break;
    case 'split':
      body = (
        <>
          <View style={{ ...abs, left: (s - sw) / 2, top: s * 0.12, width: sw, height: s * 0.4, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.26, top: s * 0.4, width: sw, height: s * 0.5, borderRadius: sw, backgroundColor: color, transform: [{ rotate: '35deg' }] }} />
          <View style={{ ...abs, left: s * 0.74 - sw, top: s * 0.4, width: sw, height: s * 0.5, borderRadius: sw, backgroundColor: color, transform: [{ rotate: '-35deg' }] }} />
        </>
      );
      break;
    case 'scale':
      body = (
        <>
          <View style={{ ...abs, left: (s - sw) / 2, top: s * 0.12, width: sw, height: s * 0.76, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.12, top: s * 0.26, width: s * 0.76, height: sw, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.1, top: s * 0.5, width: s * 0.3, height: s * 0.16, borderBottomLeftRadius: s, borderBottomRightRadius: s, borderWidth: sw, borderTopWidth: 0, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.6, top: s * 0.5, width: s * 0.3, height: s * 0.16, borderBottomLeftRadius: s, borderBottomRightRadius: s, borderWidth: sw, borderTopWidth: 0, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.3, top: s * 0.86, width: s * 0.4, height: sw, borderRadius: sw, backgroundColor: color }} />
        </>
      );
      break;
    case 'link':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.06, top: s * 0.36, width: s * 0.5, height: s * 0.28, borderRadius: s, borderWidth: sw, borderColor: color, transform: [{ rotate: '-35deg' }] }} />
          <View style={{ ...abs, left: s * 0.44, top: s * 0.36, width: s * 0.5, height: s * 0.28, borderRadius: s, borderWidth: sw, borderColor: color, transform: [{ rotate: '-35deg' }] }} />
        </>
      );
      break;
    case 'clock':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.1, top: s * 0.1, width: s * 0.8, height: s * 0.8, borderRadius: s, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: (s - sw) / 2, top: s * 0.28, width: sw, height: s * 0.24, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.5, top: (s - sw) / 2 + sw / 2, width: s * 0.2, height: sw, borderRadius: sw, backgroundColor: color }} />
        </>
      );
      break;
    case 'route':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.08, top: s * 0.62, width: s * 0.26, height: s * 0.26, borderRadius: s, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.66, top: s * 0.12, width: s * 0.26, height: s * 0.26, borderRadius: s, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.34, top: s * 0.4, width: s * 0.5, height: s * 0.4, borderTopWidth: sw, borderRightWidth: sw, borderColor: color, borderTopRightRadius: s * 0.2 }} />
        </>
      );
      break;
    case 'sun':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.3, top: s * 0.3, width: s * 0.4, height: s * 0.4, borderRadius: s, backgroundColor: color }} />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
            <View key={deg} style={{ ...abs, ...box, alignItems: 'center', transform: [{ rotate: `${deg}deg` }] }}>
              <View style={{ width: Math.max(1.5, s / 14), height: s * 0.13, marginTop: s * 0.02, borderRadius: sw, backgroundColor: color }} />
            </View>
          ))}
        </>
      );
      break;
    case 'moon':
      body = <View style={{ ...abs, left: s * 0.14, top: s * 0.14, width: s * 0.72, height: s * 0.72, borderRadius: s, borderWidth: s * 0.17, borderColor: 'transparent', borderLeftColor: color, borderBottomColor: color, transform: [{ rotate: '15deg' }] }} />;
      break;
    case 'bus':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.14, top: s * 0.14, width: s * 0.72, height: s * 0.62, borderRadius: 4, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.14, top: s * 0.42, width: s * 0.72, height: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.26, top: s * 0.76, width: s * 0.14, height: s * 0.14, borderRadius: s, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.6, top: s * 0.76, width: s * 0.14, height: s * 0.14, borderRadius: s, backgroundColor: color }} />
        </>
      );
      break;
    case 'bed':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.1, top: s * 0.2, width: sw, height: s * 0.62, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.1, top: s * 0.62, width: s * 0.8, height: sw, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.88 - sw, top: s * 0.62, width: sw, height: s * 0.2, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.2, top: s * 0.38, width: s * 0.22, height: s * 0.16, borderRadius: 3, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.5, top: s * 0.4, width: s * 0.4, height: s * 0.22, borderTopLeftRadius: 4, borderTopRightRadius: 4, borderTopWidth: sw, borderRightWidth: sw, borderLeftWidth: sw, borderColor: color }} />
        </>
      );
      break;
    case 'utensils':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.2, top: s * 0.1, width: s * 0.2, height: s * 0.3, borderBottomLeftRadius: s, borderBottomRightRadius: s, borderWidth: sw, borderTopWidth: 0, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.3 - sw / 2, top: s * 0.1, width: sw, height: s * 0.8, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.66, top: s * 0.1, width: s * 0.16, height: s * 0.4, borderTopLeftRadius: s, borderTopRightRadius: s, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.74 - sw / 2, top: s * 0.4, width: sw, height: s * 0.5, borderRadius: sw, backgroundColor: color }} />
        </>
      );
      break;
    case 'bag':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.16, top: s * 0.3, width: s * 0.68, height: s * 0.56, borderRadius: 4, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.32, top: s * 0.1, width: s * 0.36, height: s * 0.32, borderTopLeftRadius: s, borderTopRightRadius: s, borderWidth: sw, borderBottomWidth: 0, borderColor: color }} />
        </>
      );
      break;
    case 'ticket':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.08, top: s * 0.26, width: s * 0.84, height: s * 0.48, borderRadius: 4, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.62, top: s * 0.3, width: sw, height: s * 0.4, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.24, top: s * 0.44, width: s * 0.24, height: sw, borderRadius: sw, backgroundColor: color }} />
        </>
      );
      break;
    case 'fuel':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.14, top: s * 0.12, width: s * 0.46, height: s * 0.76, borderRadius: 4, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.22, top: s * 0.22, width: s * 0.3, height: s * 0.18, borderRadius: 2, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.6, top: s * 0.4, width: s * 0.2, height: s * 0.34, borderTopRightRadius: s * 0.1, borderTopWidth: sw, borderRightWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.8 - sw, top: s * 0.3, width: sw, height: s * 0.3, borderRadius: sw, backgroundColor: color }} />
        </>
      );
      break;
    case 'dots':
      body = (
        <>
          {[0.14, 0.4, 0.66].map((x) => (
            <View key={x} style={{ ...abs, left: s * x, top: s * 0.4, width: s * 0.2, height: s * 0.2, borderRadius: s, backgroundColor: color }} />
          ))}
        </>
      );
      break;
    case 'tag':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.2, top: s * 0.2, width: s * 0.6, height: s * 0.6, borderRadius: 4, borderWidth: sw, borderColor: color, transform: [{ rotate: '45deg' }, { scale: 0.85 }] }} />
          <View style={{ ...abs, left: s * 0.42, top: s * 0.28, width: s * 0.12, height: s * 0.12, borderRadius: s, backgroundColor: color }} />
        </>
      );
      break;
    case 'chevron':
      body = <View style={{ ...abs, left: s * 0.3, top: s * 0.26, width: s * 0.4, height: s * 0.4, borderRightWidth: sw, borderBottomWidth: sw, borderColor: color, transform: [{ rotate: '45deg' }] }} />;
      break;
    case 'arrowRight':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.14, top: (s - sw) / 2, width: s * 0.7, height: sw, borderRadius: sw, backgroundColor: color }} />
          <View style={{ ...abs, left: s * 0.46, top: s * 0.3, width: s * 0.4, height: s * 0.4, borderRightWidth: sw, borderTopWidth: sw, borderColor: color, transform: [{ rotate: '45deg' }, { scale: 0.8 }] }} />
        </>
      );
      break;
    case 'copy':
      body = (
        <>
          <View style={{ ...abs, left: s * 0.12, top: s * 0.12, width: s * 0.5, height: s * 0.56, borderRadius: 3, borderWidth: sw, borderColor: color }} />
          <View style={{ ...abs, left: s * 0.36, top: s * 0.32, width: s * 0.5, height: s * 0.56, borderRadius: 3, borderWidth: sw, borderColor: color }} />
        </>
      );
      break;
    case 'back':
      body = <View style={{ ...abs, left: s * 0.36, top: s * 0.3, width: s * 0.4, height: s * 0.4, borderLeftWidth: sw, borderBottomWidth: sw, borderColor: color, transform: [{ rotate: '45deg' }] }} />;
      break;
    case 'check':
      body = <View style={{ ...abs, left: s * 0.28, top: s * 0.2, width: s * 0.28, height: s * 0.5, borderRightWidth: sw, borderBottomWidth: sw, borderColor: color, transform: [{ rotate: '40deg' }] }} />;
      break;
  }

  return (
    <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={box}>
      {body}
    </View>
  );
}
