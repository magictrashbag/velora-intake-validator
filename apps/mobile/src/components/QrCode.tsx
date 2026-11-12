import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import QRCodeLib from 'qrcode';
import { theme } from '../theme';

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
        <Path d={d} fill="#0F172A" />
      </Svg>
      <View style={{
        position: 'absolute', width: badge, height: badge, borderRadius: badge * 0.28, backgroundColor: theme.primary,
        borderWidth: 4, borderColor: '#ffffff', alignItems: 'center', justifyContent: 'center',
      }}>
        <Svg width={badge * 0.5} height={badge * 0.5} viewBox="0 0 24 24">
          {/* Puente mark: a simple bridge arch */}
          <Path d="M2 18h20M4 18v-4a8 8 0 0 1 16 0v4M9 18v-3M15 18v-3" stroke="#ffffff" strokeWidth={2.2} fill="none" strokeLinecap="round" />
        </Svg>
      </View>
    </View>
  );
}
