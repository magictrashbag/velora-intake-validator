import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import QRCodeLib from 'qrcode';
import { theme } from '../theme';
import { KameMark } from './KameMark';

/** Renders a QR code as a single SVG path (fast, crisp at any size). Error correction 'H' so the
 *  centre badge can cover part of the code and it still scans. */
export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const { d, n } = useMemo(() => {
    const qr = QRCodeLib.create(value, { errorCorrectionLevel: 'H' });
    const count = qr.modules.size;
    let path = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.modules.get(r, c)) path += `M${c} ${r}h1v1h-1z`;
      }
    }
    return { d: path, n: count };
  }, [value]);
  const quiet = 2;
  const badge = Math.round(size * 0.2);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' }}
      accessibilityRole="image" accessibilityLabel="Código QR para recibir pagos">
      <Svg width={size} height={size} viewBox={`${-quiet} ${-quiet} ${n + quiet * 2} ${n + quiet * 2}`}>
        <Rect x={-quiet} y={-quiet} width={n + quiet * 2} height={n + quiet * 2} fill="#ffffff" />
        <Path d={d} fill={theme.ink} />
      </Svg>
      <View style={{
        position: 'absolute', width: badge, height: badge, borderRadius: badge * 0.3, backgroundColor: '#ffffff',
        padding: 4, alignItems: 'center', justifyContent: 'center',
      }}>
        <KameMark size={badge - 8} />
      </View>
    </View>
  );
}
