import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { session } from './src/session';
import { LoginScreen } from './src/screens/LoginScreen';
import { WalletScreen } from './src/screens/WalletScreen';

export default function App() {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => { session.get().then(setToken); }, []);

  if (token === undefined) {
    return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator /></View>;
  }
  return (
    <>
      <StatusBar style="dark" />
      {token ? <WalletScreen token={token} onLogout={() => setToken(null)} /> : <LoginScreen onLoggedIn={setToken} />}
    </>
  );
}
