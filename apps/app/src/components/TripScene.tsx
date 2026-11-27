import { useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

import { SCENE_KINDS, sceneFor, type SceneKind } from '../lib/sceneKind';
export { SCENE_KINDS, sceneFor, type SceneKind };

const W = 400;
const H = 220;

/** Flat illustrated landscape built from plain shapes (no image files, no SVG library), themed for light and dark. */
export function TripScene({ kind, height, radiusTop = 0, radiusAll = 0 }: { kind: SceneKind; height: number; radiusTop?: number; radiusAll?: number }) {
  const { scheme } = useTheme();
  const [width, setWidth] = useState(0);
  const c = scheme === 'dark' ? DARK : LIGHT;
  const scale = width > 0 ? Math.max(width / W, height / H) : 1;
  const ox = (width - W * scale) / 2;
  const oy = (height - H * scale) / 2;
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={onLayout}
      style={{
        width: '100%',
        height,
        overflow: 'hidden',
        backgroundColor: c.sky,
        borderTopLeftRadius: radiusAll || radiusTop,
        borderTopRightRadius: radiusAll || radiusTop,
        borderBottomLeftRadius: radiusAll,
        borderBottomRightRadius: radiusAll,
      }}
    >
      {width > 0 && (
        <View style={{ position: 'absolute', left: ox, top: oy, width: W, height: H, transform: [{ scale }], transformOrigin: 'top left' }}>
          <Shapes kind={kind} c={c} />
        </View>
      )}
    </View>
  );
}

interface Palette {
  sky: string;
  sun: string;
  far: string;
  mid: string;
  near: string;
  water: string;
  tree: string;
  sand: string;
}
const LIGHT: Palette = { sky: '#EADFC4', sun: '#E9C98E', far: '#B9C4A6', mid: '#7E9A80', near: '#2F5D44', water: '#8FB0B0', tree: '#244A38', sand: '#D8C39A' };
const DARK: Palette = { sky: '#262626', sun: '#C4A073', far: '#3A3F3B', mid: '#2F3A33', near: '#1D2A22', water: '#2F5156', tree: '#141C17', sand: '#4A4332' };

function Tri({ x, y, w, h, color, lean = 0 }: { x: number; y: number; w: number; h: number; color: string; lean?: number }) {
  // x,y = left/top of the bounding box; `lean` shifts the apex (-1 = left corner .. 1 = right corner) for asymmetric peaks
  const left = (w / 2) * (1 + lean);
  const right = w - left;
  return <View style={{ position: 'absolute', left: x, top: y, width: 0, height: 0, borderLeftWidth: left, borderRightWidth: right, borderBottomWidth: h, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: color }} />;
}
function Rect({ x, y, w, h, color }: { x: number; y: number; w: number; h: number; color: string }) {
  return <View style={{ position: 'absolute', left: x, top: y, width: w, height: h, backgroundColor: color }} />;
}
function Blob({ x, y, w, h, color }: { x: number; y: number; w: number; h: number; color: string }) {
  return <View style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: Math.max(w, h), backgroundColor: color }} />;
}
function Tree({ x, base, h, color }: { x: number; base: number; h: number; color: string }) {
  return <Tri x={x - h * 0.27} y={base - h} w={h * 0.54} h={h} color={color} />;
}

function Shapes({ kind, c }: { kind: SceneKind; c: Palette }) {
  const sun = (cx: number, cy = 62, r = 26) => <Blob x={cx - r} y={cy - r} w={r * 2} h={r * 2} color={c.sun} />;
  switch (kind) {
    case 'mountain':
      return (
        <>
          {sun(300)}
          <Tri x={-20} y={50} w={200} h={110} color={c.far} lean={-0.1} />
          <Tri x={120} y={30} w={220} h={140} color={c.far} lean={0.1} />
          <Tri x={280} y={85} w={160} h={85} color={c.far} />
          <Tri x={-40} y={105} w={240} h={95} color={c.mid} lean={0.1} />
          <Tri x={150} y={90} w={260} h={110} color={c.mid} lean={-0.15} />
          <Rect x={0} y={190} w={W} h={30} color={c.mid} />
          <Blob x={-80} y={170} w={340} h={120} color={c.near} />
          <Blob x={180} y={182} w={320} h={110} color={c.near} />
          <Tree x={40} base={212} h={36} color={c.tree} />
          <Tree x={68} base={216} h={26} color={c.tree} />
          <Tree x={332} base={210} h={34} color={c.tree} />
          <Tree x={362} base={214} h={24} color={c.tree} />
        </>
      );
    case 'hills':
      return (
        <>
          {sun(310)}
          <Blob x={-120} y={105} w={460} h={200} color={c.far} />
          <Blob x={150} y={115} w={420} h={200} color={c.far} />
          <Blob x={-60} y={150} w={400} h={200} color={c.mid} />
          <Blob x={190} y={160} w={380} h={200} color={c.mid} />
          <Blob x={-100} y={190} w={460} h={160} color={c.near} />
          <Blob x={140} y={196} w={380} h={160} color={c.near} />
          {[0, 1, 2, 3].map((r) => (
            <Rect key={r} x={30 + r * 12} y={176 + r * 9} w={150} h={2} color={c.mid} />
          ))}
          <Tree x={300} base={178} h={26} color={c.tree} />
          <Tree x={332} base={184} h={22} color={c.tree} />
          <Tree x={360} base={176} h={26} color={c.tree} />
        </>
      );
    case 'coast':
      return (
        <>
          {sun(120)}
          <Rect x={0} y={120} w={W} h={100} color={c.water} />
          {[138, 156, 176].map((y) => (
            <Rect key={y} x={30 + (y % 40)} y={y} w={90} h={2} color={c.far} />
          ))}
          <Rect x={250} y={134} w={80} h={2} color={c.far} />
          <Blob x={-100} y={186} w={420} h={140} color={c.sand} />
          <Blob x={150} y={192} w={320} h={120} color={c.sand} />
          {/* a small sailing boat */}
          <Rect x={304} y={100} w={2} h={32} color={c.tree} />
          <Tri x={306} y={104} w={26} h={26} color={c.sky} lean={-1} />
          <Rect x={292} y={130} w={46} h={8} color={c.near} />
          {/* a palm */}
          <Rect x={56} y={146} w={4} h={62} color={c.tree} />
          <Blob x={30} y={134} w={44} h={14} color={c.near} />
          <Blob x={52} y={128} w={46} h={14} color={c.near} />
        </>
      );
    case 'desert':
      return (
        <>
          {sun(300)}
          <Blob x={-120} y={120} w={420} h={200} color={c.far} />
          <Blob x={140} y={112} w={420} h={220} color={c.far} />
          <Blob x={-80} y={158} w={440} h={200} color={c.sand} />
          <Blob x={170} y={170} w={380} h={200} color={c.sand} />
          <Blob x={-100} y={196} w={400} h={160} color={c.mid} />
          <Blob x={170} y={204} w={380} h={160} color={c.near} />
        </>
      );
    case 'lake':
      return (
        <>
          {sun(300, 58, 24)}
          <Tri x={-30} y={52} w={210} h={74} color={c.far} lean={-0.2} />
          <Tri x={130} y={36} w={240} h={90} color={c.far} lean={0.1} />
          <Tri x={300} y={72} w={150} h={54} color={c.far} />
          <Rect x={0} y={125} w={W} h={95} color={c.water} />
          <Rect x={60} y={150} w={110} h={2} color={c.far} />
          <Rect x={230} y={170} w={100} h={2} color={c.far} />
          <Blob x={-100} y={196} w={420} h={120} color={c.near} />
          <Blob x={180} y={202} w={320} h={110} color={c.near} />
          <Tree x={32} base={208} h={36} color={c.tree} />
          <Tree x={60} base={212} h={26} color={c.tree} />
          <Tree x={352} base={206} h={36} color={c.tree} />
        </>
      );
    case 'forest':
    default:
      return (
        <>
          {sun(310, 50, 22)}
          {Array.from({ length: 11 }, (_, i) => (
            <Tree key={`f${i}`} x={14 + i * 38} base={150} h={60 + ((i * 7) % 25)} color={c.far} />
          ))}
          <Rect x={0} y={148} w={W} h={72} color={c.mid} />
          {Array.from({ length: 14 }, (_, i) => (
            <Tree key={`m${i}`} x={8 + i * 30} base={190} h={70 + ((i * 5) % 30)} color={c.mid} />
          ))}
          <Rect x={0} y={188} w={W} h={32} color={c.near} />
          {Array.from({ length: 10 }, (_, i) => (
            <Tree key={`n${i}`} x={5 + i * 44} base={216} h={78 + ((i * 3) % 26)} color={c.tree} />
          ))}
        </>
      );
  }
}
