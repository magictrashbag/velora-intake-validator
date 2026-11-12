import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { session } from './src/session';
import { LoginScreen } from './src/screens/LoginScreen';
import { WalletScreen } from './src/screens/WalletScreen';
import { ExchangeScreen } from './src/screens/ExchangeScreen';
import { WithdrawScreen } from './src/screens/WithdrawScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';

export type Route = 'wallet' | 'exchange' | 'withdraw' | 'profile' | 'scan';

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>('wallet');
  // Recipient from a scanned QR code; the wallet remounts with it prefilled (payer still confirms).
  const [prefill, setPrefill] = useState<{ phone: string; n: number } | null>(null);

  useEffect(() => { session.get().then(setToken); }, []);

  if (token === undefined) {
    return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  }
  return (
    <>
      <StatusBar style="dark" />
      {!token ? <LoginScreen onLoggedIn={(t) => { setRoute('wallet'); setToken(t); }} />
        : route === 'exchange' ? <ExchangeScreen token={token} onBack={() => setRoute('wallet')} />
        : route === 'withdraw' ? <WithdrawScreen token={token} onBack={() => setRoute('wallet')} />
        : route === 'profile' || route === 'scan'
          ? <ProfileScreen token={token} initialTab={route === 'scan' ? 'scan' : 'code'} onBack={() => setRoute('wallet')}
              onLogout={() => setToken(null)}
              onPay={(phone) => { setPrefill((p) => ({ phone, n: (p?.n ?? 0) + 1 })); setRoute('wallet'); }} />
        : <WalletScreen key={prefill?.n ?? 0} token={token} onLogout={() => setToken(null)} onNavigate={setRoute}
            {...(prefill ? { prefillTo: prefill.phone } : {})} />}
    </>
  );
}
