import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { api, ApiError, type Network } from '../api';
import { msg, outcomeText } from '../messages';
import { theme } from '../theme';
import { Button } from './LoginScreen';
import { styles } from './ExchangeScreen';

const NETWORKS: { id: Network; label: string }[] = [
  { id: 'polygon', label: 'Polygon' }, { id: 'base', label: 'Base' }, { id: 'ethereum', label: 'Ethereum' }, { id: 'solana', label: 'Solana' },
];
/** Must match the server's Travel Rule threshold (DEFAULT_POLICY.travelRuleThresholdUsdCents). */
const TRAVEL_RULE_USD = 1000;

export function WithdrawScreen({ token, onBack }: { token: string; onBack: () => void }) {
  const [network, setNetwork] = useState<Network>('polygon');
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [beneficiary, setBeneficiary] = useState('');
  const [walletType, setWalletType] = useState<'self_hosted' | 'vasp'>('self_hosted');
  const [vasp, setVasp] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  // One idempotency key per withdrawal intent; reused on network retries, reset on any edit.
  const intentKey = useRef<string | null>(null);
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); intentKey.current = null; };

  const normalized = amount.trim().replace(',', '.');
  const needsTravelRule = Number(normalized) >= TRAVEL_RULE_USD;

  async function submit() {
    setBusy(true); setNotice(null);
    intentKey.current ??= api.newIdempotencyKey();
    try {
      const r = await api.withdraw(token, intentKey.current, {
        network, address: address.trim(), amount: normalized,
        ...(needsTravelRule ? {
          travel_rule: { beneficiary_name: beneficiary.trim(), wallet_type: walletType, ...(walletType === 'vasp' ? { vasp_name: vasp.trim() } : {}) },
        } : {}),
      });
      intentKey.current = null;
      setNotice(outcomeText(r.data.status, r.data.reasons));
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'retry') intentKey.current = null;
      setNotice({ text: msg(e instanceof ApiError ? e.code : 'network_error'), ok: false });
    } finally { setBusy(false); }
  }

  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.container}>
      <Pressable onPress={onBack}><Text style={styles.link}>‹ Volver</Text></Pressable>
      <Text style={styles.title}>Retirar USDC</Text>
      <Text style={styles.label}>Red</Text>
      <View style={styles.row}>
        {NETWORKS.map((n) => (
          <Pressable key={n.id} onPress={() => edit(setNetwork)(n.id)} style={[styles.chip, network === n.id && styles.chipOn]} accessibilityRole="button">
            <Text style={network === n.id ? styles.chipTextOn : styles.chipText}>{n.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput style={styles.input} value={address} onChangeText={edit(setAddress)} placeholder="Dirección de la billetera"
        autoCapitalize="none" autoCorrect={false} />
      <TextInput style={styles.input} value={amount} onChangeText={edit(setAmount)} keyboardType="decimal-pad" placeholder="Monto (USD)" />
      {needsTravelRule ? (
        <View style={[styles.card, { marginBottom: 12 }]}>
          <Text style={styles.label}>Por regulación, para US$1.000 o más necesitamos los datos del beneficiario.</Text>
          <TextInput style={styles.input} value={beneficiary} onChangeText={edit(setBeneficiary)} placeholder="Nombre completo del beneficiario" />
          <View style={styles.row}>
            {(['self_hosted', 'vasp'] as const).map((w) => (
              <Pressable key={w} onPress={() => edit(setWalletType)(w)} style={[styles.chip, walletType === w && styles.chipOn]}>
                <Text style={walletType === w ? styles.chipTextOn : styles.chipText}>{w === 'self_hosted' ? 'Billetera propia' : 'Exchange'}</Text>
              </Pressable>
            ))}
          </View>
          {walletType === 'vasp' ? <TextInput style={styles.input} value={vasp} onChangeText={edit(setVasp)} placeholder="Nombre del exchange" /> : null}
        </View>
      ) : null}
      <Text style={[styles.muted, { marginBottom: 12 }]}>Revisa la red y la dirección: los envíos en blockchain no se pueden revertir.</Text>
      <Button title="Retirar" onPress={submit} busy={busy} />
      {notice ? <Text style={{ color: notice.ok ? theme.positive : theme.danger, marginTop: 12 }}>{notice.text}</Text> : null}
    </ScrollView>
  );
}
