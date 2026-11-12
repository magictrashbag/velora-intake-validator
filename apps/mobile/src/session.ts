import * as SecureStore from 'expo-secure-store';

// Session token lives in the OS keychain/keystore, never AsyncStorage (plaintext on disk).
const KEY = 'puente.session';

export const session = {
  get: () => SecureStore.getItemAsync(KEY),
  set: (token: string) => SecureStore.setItemAsync(KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  clear: () => SecureStore.deleteItemAsync(KEY),
};
