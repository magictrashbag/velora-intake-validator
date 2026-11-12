import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { api, type Me } from '../api';
import { session } from '../session';
import { theme } from '../theme';
import { QrCode } from '../components/QrCode';
import { parsePaymentUri } from '../payment-uri';
import { Button } from './LoginScreen';

const TIER_LABEL = ['Sin verificar', 'Verificado', 'Verificado plus'];

/** Same surname rule as the API's maskName: 4+ words -> paternal surname (second to last). */
export function initials(name: string | null, phone: string) {
  if (!name) return phone.slice(-2);
  const p = name.trim().split(/\s+/);
  const s = p.length >= 4 ? p.length - 2 : p.length - 1;
  return ((p[0]?.[0] ?? '') + (p.length > 1 ? p[s]![0] : '')).toUpperCase();
}

export function ProfileScreen({ token, initialTab = 'code', onBack, onLogout, onPay }: {
  token: string;
  initialTab?: 'code' | 'scan';
  onBack: () => void;
  onLogout: () => void;
  onPay: (phone: string) => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<'code' | 'scan'>(initialTab);

  useEffect(() => { api.me(token).then((r) => setMe(r.data)).catch(() => {}); }, [token]);

  async function logout() {
    await api.logout(token).catch(() => {});
    await session.clear();
    onLogout();
  }

  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.container}>
      <Pressable onPress={onBack} accessibilityRole="button"><Text style={styles.link}>‹ Volver</Text></Pressable>

      <View style={styles.head}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{me ? initials(me.name, me.phone) : ''}</Text></View>
        <Text style={styles.name}>{me?.name ?? 'Tu cuenta'}</Text>
        <Text style={styles.muted}>{me?.phone ?? ''}</Text>
      </View>

      <View style={styles.segment} accessibilityRole="tablist">
        {(['code', 'scan'] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.segBtn, tab === t && styles.segOn]} accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }}>
            <Text style={tab === t ? styles.segTextOn : styles.segText}>{t === 'code' ? 'Mi código' : 'Escanear'}</Text>
          </Pressable>
        ))}
      </View>

      {tab === 'code' ? (
        <View style={styles.card}>
          {me ? <QrCode value={me.payment_uri} size={232} /> : <View style={{ height: 232 }} />}
          <Text style={[styles.muted, styles.center]}>Muestra este código para recibir dólares. Solo contiene tu número.</Text>
          <Button title="Compartir mi código" onPress={() => me && Share.share({
            message: `Envíame dólares con Kame al ${me.phone} — ${me.payment_uri}`,
          })} />
        </View>
      ) : (
        <Scanner onPay={onPay} />
      )}

      {me ? (
        <View style={styles.card}>
          <Row label="Nivel" value={TIER_LABEL[me.kyc_tier] ?? '—'} />
          {me.limits ? (
            <>
              <Row label="Límite por envío" value={`US$ ${me.limits.per_transaction_usd}`} />
              <Row label="Límite diario" value={`US$ ${me.limits.daily_usd}`} />
              <Row label="Límite mensual" value={`US$ ${me.limits.monthly_usd}`} />
            </>
          ) : <Text style={styles.warn}>Verifica tu identidad para enviar dinero.</Text>}
          <Row label="Miembro desde" value={me.member_since} />
        </View>
      ) : null}

      <Pressable onPress={logout} accessibilityRole="button" style={styles.logout}>
        <Text style={{ color: theme.danger, fontWeight: '600' }}>Cerrar sesión</Text>
      </Pressable>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

function Scanner({ onPay }: { onPay: (phone: string) => void }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [handled, setHandled] = useState(false);

  if (Platform.OS === 'web') {
    return <View style={styles.card}><Text style={[styles.muted, styles.center]}>El escáner está disponible en la app para teléfonos.</Text></View>;
  }
  if (!perm) return <View style={styles.card} />;
  if (!perm.granted) {
    return (
      <View style={styles.card}>
        <Text style={[styles.muted, styles.center]}>Para escanear un código necesitamos usar tu cámara.</Text>
        <Button title="Permitir cámara" onPress={requestPerm} />
      </View>
    );
  }
  return (
    <View style={styles.card}>
      <View style={styles.cameraBox}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handled ? undefined : ({ data }) => {
            const p = parsePaymentUri(data);
            if (!p) { setError('Este código no es de Kame.'); return; }
            setHandled(true);
            onPay(p.phone);
          }}
        />
      </View>
      <Text style={[error ? styles.warn : styles.muted, styles.center]}>{error ?? 'Apunta al código Kame de quien recibirá el dinero.'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 60, gap: 16 },
  link: { color: theme.ink, fontSize: 16, fontWeight: '600' },
  head: { alignItems: 'center', gap: 4 },
  avatar: { width: 72, height: 72, borderRadius: 36, backgroundColor: theme.primary, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  avatarText: { color: theme.onPrimary, fontSize: 26, fontWeight: '800' },
  name: { fontSize: 22, fontWeight: '800', color: theme.text, textAlign: 'center' },
  muted: { color: theme.muted },
  center: { textAlign: 'center' },
  warn: { color: theme.danger },
  segment: { flexDirection: 'row', backgroundColor: theme.border, borderRadius: 999, padding: 4 },
  segBtn: { flex: 1, paddingVertical: 10, borderRadius: 999, alignItems: 'center' },
  segOn: { backgroundColor: theme.card },
  segText: { color: theme.muted, fontWeight: '600' },
  segTextOn: { color: theme.text, fontWeight: '800' },
  card: { backgroundColor: theme.card, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: theme.border, alignItems: 'stretch', gap: 12 },
  cameraBox: { height: 280, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  value: { color: theme.text, fontWeight: '600' },
  logout: { alignItems: 'center', padding: 12 },
});
