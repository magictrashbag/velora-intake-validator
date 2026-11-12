import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError, type Wallet } from '../api';
import { msg, outcomeText } from '../messages';
import { session } from '../session';
import { theme } from '../theme';
import { Button } from './LoginScreen';

export function WalletScreen({ token, onLogout, onNavigate }: {
  token: string; onLogout: () => void; onNavigate: (r: 'exchange' | 'withdraw') => void;
}) {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [to, setTo] = useState('+58');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  // One key per send intent; kept across retries, reset only after a definitive answer.
  const intentKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try { setWallet((await api.wallet(token)).data); }
    catch (e) { if (e instanceof ApiError && e.status === 401) await logout(); }
    finally { setRefreshing(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function logout() {
    await api.logout(token).catch(() => {});
    await session.clear();
    onLogout();
  }

  async function send() {
    setBusy(true);
    setNotice(null);
    intentKey.current ??= api.newIdempotencyKey();
    try {
      const r = await api.send(token, to.replace(/[\s-]/g, ''), amount.trim().replace(',', '.'), intentKey.current);
      intentKey.current = null;
      setNotice(outcomeText(r.data.status, r.data.reasons));
      if (r.data.status === 'posted') setAmount('');
      await load();
    } catch (e) {
      // Network errors keep the same key so a retry is safe. Definitive API errors reset it.
      if (e instanceof ApiError && e.code !== 'retry') intentKey.current = null;
      setNotice({ text: msg(e instanceof ApiError ? e.code : 'network_error'), ok: false });
    } finally {
      setBusy(false);
    }
  }

  const usd = wallet?.balances.find((b) => b.currency === 'USDC');
  const ves = wallet?.balances.find((b) => b.currency === 'VES');

  return (
    <FlatList
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
      data={wallet?.activity ?? []}
      keyExtractor={(a) => a.id}
      ListHeaderComponent={
        <View>
          <View style={styles.header}>
            <Text style={styles.brand}>Puente</Text>
            <Pressable onPress={logout}><Text style={styles.link}>Salir</Text></Pressable>
          </View>
          <View style={styles.card}>
            <Text style={styles.muted}>Saldo en dólares</Text>
            <Text style={styles.balance}>$ {usd ? Number(usd.amount).toFixed(2) : '—'}</Text>
            <Text style={styles.muted}>Bs. {ves?.amount ?? '—'}</Text>
            <View style={styles.actions}>
              <Pressable style={styles.action} onPress={() => onNavigate('exchange')} accessibilityRole="button">
                <Text style={styles.actionText}>Cambiar Bs ↔ USD</Text>
              </Pressable>
              <Pressable style={styles.action} onPress={() => onNavigate('withdraw')} accessibilityRole="button">
                <Text style={styles.actionText}>Retirar</Text>
              </Pressable>
            </View>
            {wallet && wallet.user.kyc_tier === 0 ? (
              <Text style={styles.warn}>Verifica tu identidad para enviar y cambiar dinero.</Text>
            ) : null}
          </View>
          <View style={styles.card}>
            <Text style={styles.section}>Enviar dólares</Text>
            <TextInput style={styles.input} value={to} onChangeText={(v) => { setTo(v); intentKey.current = null; }}
              keyboardType="phone-pad" placeholder="Teléfono destino" />
            <TextInput style={styles.input} value={amount} onChangeText={(v) => { setAmount(v); intentKey.current = null; }}
              keyboardType="decimal-pad" placeholder="Monto (USD)" />
            <Button title="Enviar" onPress={send} busy={busy} />
            {notice ? <Text style={{ color: notice.ok ? theme.positive : theme.danger }}>{notice.text}</Text> : null}
          </View>
          <Text style={styles.section}>Movimientos</Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Text style={styles.rowText}>{item.description}</Text>
          <Text style={{ color: item.amount.startsWith('-') ? theme.text : theme.positive, fontWeight: '600' }}>
            {item.amount} {item.currency === 'USDC' ? 'USD' : 'Bs.'}
          </Text>
        </View>
      )}
      ListEmptyComponent={<Text style={styles.muted}>Aún no tienes movimientos.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 60 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  brand: { fontSize: 28, fontWeight: '800', color: theme.primary },
  link: { color: theme.primary, fontSize: 16 },
  card: { backgroundColor: theme.card, borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: theme.border },
  balance: { fontSize: 40, fontWeight: '800', color: theme.text, marginVertical: 4 },
  muted: { color: theme.muted },
  warn: { color: theme.danger, marginTop: 12 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  action: { flex: 1, borderWidth: 1, borderColor: theme.primary, borderRadius: 12, paddingVertical: 10, alignItems: 'center' },
  actionText: { color: theme.primary, fontWeight: '700' },
  section: { fontSize: 18, fontWeight: '700', color: theme.text, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 12, fontSize: 16, marginBottom: 12, color: theme.text },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.border },
  rowText: { color: theme.text, flex: 1, marginRight: 12 },
});
