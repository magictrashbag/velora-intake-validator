import Svg, { Ellipse, Circle, G, Path, Rect } from 'react-native-svg';
import { theme } from '../theme';

/** Shared geometry (viewBox 0 0 48 48), also used to render the app icons. */
export const KAME_TURTLE = {
  head: { cx: 24, cy: 8.6, r: 4.2 },
  flippers: [
    { cx: 13.2, cy: 15.5, rot: -35 }, { cx: 34.8, cy: 15.5, rot: 35 },
    { cx: 13.2, cy: 34.5, rot: 35 }, { cx: 34.8, cy: 34.5, rot: -35 },
  ],
  tail: 'M21.6 38.2 24 43.4l2.4-5.2z',
  shell: { cx: 24, cy: 25, rx: 12.2, ry: 13.8 },
  plates: 'M24 19.6l4.7 2.7v5.4L24 30.4l-4.7-2.7v-5.4zM24 19.6v-7.6M28.7 22.3L33.7 19.4M28.7 27.7L33.7 30.6M24 30.4v7.6M19.3 27.7L14.3 30.6M19.3 22.3L14.3 19.4',
};

/**
 * Kame mark: a turtle seen from above on a gold tile. Ink body; the shell plates are drawn in the
 * tile colour. An original drawing, using no third-party characters or symbols.
 */
export function KameMark({ size = 40 }: { size?: number }) {
  const t = KAME_TURTLE;
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityLabel="Kame">
      <Rect x={0} y={0} width={48} height={48} rx={13} fill={theme.primary} />
      <G fill={theme.ink}>
        <Circle cx={t.head.cx} cy={t.head.cy} r={t.head.r} />
        {t.flippers.map((f, i) => (
          <Ellipse key={i} cx={f.cx} cy={f.cy} rx={4.6} ry={2.7} rotation={f.rot} origin={`${f.cx}, ${f.cy}`} />
        ))}
        <Path d={t.tail} />
        <Ellipse cx={t.shell.cx} cy={t.shell.cy} rx={t.shell.rx} ry={t.shell.ry} />
      </G>
      <Path d={t.plates} stroke={theme.primary} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}
