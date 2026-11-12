import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError } from '../api';
import { msg } from '../messages';
import { session } from '../session';
import { theme } from '../theme';

export function LoginScreen({ onLoggedIn }: { onLoggedIn: (token: string) => void }) {
  const [phone, setPhone] = useState('+58');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | undefined>();

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(msg(e instanceof ApiError ? e.code : 'network_error')); }
    finally { setBusy(false); }
  }

  const start = () => run(async () => {
    const r = await api.startOtp(phone.replace(/[\s-]/g, ''));
    setDevCode(r.data.dev_code);
    setStep('code');
  });

  const verify = () => run(async () => {
    const r = await api.verifyOtp(phone.replace(/[\s-]/g, ''), code);
    await session.set(r.data.token);
    onLoggedIn(r.data.token);
  });

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>Puente</Text>
      <Text style={styles.subtitle}>Tus dólares, seguros y a la mano.</Text>
      {step === 'phone' ? (
        <>
          <Text style={styles.label}>Número de teléfono</Text>
          <TextInput style={styles.input} value={phone} onChangeText={setPhone} keyboardType="phone-pad"
            autoComplete="tel" textContentType="telephoneNumber" />
          <Button title="Recibir código" onPress={start} busy={busy} />
        </>
      ) : (
        <>
          <Text style={styles.label}>Código de 6 dígitos enviado a {phone}</Text>
          <TextInput style={styles.input} value={code} onChangeText={setCode} keyboardType="number-pad"
            maxLength={6} autoComplete="sms-otp" textContentType="oneTimeCode" />
          {devCode ? <Text style={styles.dev}>Modo desarrollo — código: {devCode}</Text> : null}
          <Button title="Entrar" onPress={verify} busy={busy} />
          <Pressable onPress={() => setStep('phone')}><Text style={styles.link}>Cambiar número</Text></Pressable>
        </>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function Button({ title, onPress, busy }: { title: string; onPress: () => void; busy?: boolean }) {
  return (
    <Pressable style={[styles.button, busy && { opacity: 0.6 }]} onPress={onPress} disabled={busy} accessibilityRole="button">
      {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{title}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: theme.bg },
  brand: { fontSize: 40, fontWeight: '800', color: theme.primary },
  subtitle: { fontSize: 16, color: theme.muted, marginBottom: 32 },
  label: { fontSize: 14, color: theme.text, marginBottom: 8 },
  input: { borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, fontSize: 18, marginBottom: 16, color: theme.text, backgroundColor: theme.card },
  button: { backgroundColor: theme.primary, borderRadius: 12, padding: 16, alignItems: 'center', marginBottom: 12 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  link: { color: theme.primary, textAlign: 'center', padding: 8 },
  error: { color: theme.danger, marginTop: 8 },
  dev: { color: theme.muted, fontStyle: 'italic', marginBottom: 12 },
});
