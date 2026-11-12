import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError, type Quote } from '../api';
import { msg, outcomeText } from '../messages';
import { theme } from '../theme';
import { Button } from './LoginScreen';

/** Bs <-> USD exchange. Every trade settles through USDC; the customer sees the firm quote,
 *  the spread and a countdown before confirming. */
export function ExchangeScreen({ token, onBack }: { token: string; onBack: () => void }) {
  const [sell, setSell] = useState<'USDC' | 'VES'>('VES');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const buy = sell === 'VES' ? 'USDC' : 'VES';

  useEffect(() => {
    if (!quote) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(quote.expires_at).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [quote]);

  async function getQuote() {
    setBusy(true); setNotice(null); setQuote(null);
    try { setQuote((await api.quote(token, sell, buy, amount.trim().replace(',', '.'))).data); }
    catch (e) { setNotice({ text: msg(e instanceof ApiError ? e.code : 'network_error'), ok: false }); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!quote) return;
    setBusy(true);
    try {
      const r = await api.executeQuote(token, quote.quote_id);
      setNotice(outcomeText(r.data.status, r.data.reasons));
      setQuote(null);
      setAmount('');
    } catch (e) {
      // Safe to retry: the server executes a quote at most once.
      setNotice({ text: msg(e instanceof ApiError ? e.code : 'network_error'), ok: false });
    } finally { setBusy(false); }
  }

  const label = (c: string) => (c === 'USDC' ? 'dólares' : 'bolívares');
  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.container}>
      <Pressable onPress={onBack}><Text style={styles.link}>‹ Volver</Text></Pressable>
      <Text style={styles.title}>Cambiar</Text>
      <View style={styles.row}>
        {(['VES', 'USDC'] as const).map((c) => (
          <Pressable key={c} onPress={() => { setSell(c); setQuote(null); }}
            style={[styles.chip, sell === c && styles.chipOn]} accessibilityRole="button">
            <Text style={sell === c ? styles.chipTextOn : styles.chipText}>Vendo {label(c)}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput style={styles.input} value={amount} onChangeText={(v) => { setAmount(v); setQuote(null); }}
        keyboardType="decimal-pad" placeholder={`Monto en ${label(sell)}`} />
      {!quote ? <Button title="Cotizar" onPress={getQuote} busy={busy} /> : (
        <View style={styles.card}>
          <Text style={styles.big}>Recibes {quote.buy.amount} {quote.buy.currency === 'USDC' ? 'USD' : 'Bs.'}</Text>
          <Text style={styles.muted}>Tasa de referencia {quote.mid_rate} Bs./USD · comisión {(quote.spread_bps / 100).toFixed(2)}%</Text>
          <Text style={styles.muted}>Liquidado vía USDC</Text>
          {left > 0
            ? <Button title={`Confirmar (${left}s)`} onPress={confirm} busy={busy} />
            : <Button title="Cotización vencida — cotizar de nuevo" onPress={getQuote} busy={busy} />}
        </View>
      )}
      {notice ? <Text style={{ color: notice.ok ? theme.positive : theme.danger, marginTop: 12 }}>{notice.text}</Text> : null}
    </ScrollView>
  );
}

export const styles = StyleSheet.create({
  container: { padding: 20, paddingTop: 60 },
  link: { color: theme.primary, fontSize: 16, marginBottom: 12 },
  title: { fontSize: 28, fontWeight: '800', color: theme.text, marginBottom: 16 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 16, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: theme.card },
  chipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { color: theme.text },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  input: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 12, fontSize: 16, marginBottom: 12, color: theme.text, backgroundColor: theme.card },
  card: { backgroundColor: theme.card, borderRadius: 16, padding: 20, borderWidth: 1, borderColor: theme.border, gap: 6 },
  big: { fontSize: 22, fontWeight: '800', color: theme.text },
  muted: { color: theme.muted },
  label: { color: theme.text, marginBottom: 6 },
});
