import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

// Session token lives in the OS keychain/keystore, never AsyncStorage (plaintext on disk).
const KEY = 'puente.session';

// Web is a development preview only. The token stays in memory (lost on reload) rather than in
// browser storage, so the web build never weakens how credentials are stored.
let webToken: string | null = null;

export const session = Platform.OS === 'web'
  ? {
      get: async () => webToken,
      set: async (token: string) => { webToken = token; },
      clear: async () => { webToken = null; },
    }
  : {
      get: () => SecureStore.getItemAsync(KEY),
      set: (token: string) => SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
      clear: () => SecureStore.deleteItemAsync(KEY),
    };
