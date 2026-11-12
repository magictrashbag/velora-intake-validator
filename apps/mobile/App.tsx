import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { session } from './src/session';
import { LoginScreen } from './src/screens/LoginScreen';
import { WalletScreen } from './src/screens/WalletScreen';
import { ExchangeScreen } from './src/screens/ExchangeScreen';
import { WithdrawScreen } from './src/screens/WithdrawScreen';

export type Route = 'wallet' | 'exchange' | 'withdraw';

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [route, setRoute] = useState<Route>('wallet');

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
        : <WalletScreen token={token} onLogout={() => setToken(null)} onNavigate={setRoute} />}
    </>
  );
}
