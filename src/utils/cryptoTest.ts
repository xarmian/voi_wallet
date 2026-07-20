// Verifies the crypto polyfills required by algosdk are present.
//
// The polyfills themselves are installed by the entry module (index.ts:1-13):
// react-native-get-random-values, the global Buffer, and ./src/utils/polyfills.
// This function only *checks* that they took effect — it does not initialize
// anything, so it is safe to trim from the production cold-boot path.
import algosdk from 'algosdk';

export const testCryptoPolyfills = (): boolean => {
  try {
    // Test that crypto.getRandomValues is available
    if (
      typeof crypto === 'undefined' ||
      typeof crypto.getRandomValues !== 'function'
    ) {
      console.error('crypto.getRandomValues is not available');
      return false;
    }

    // Test that Buffer is available globally
    if (typeof global.Buffer === 'undefined') {
      console.error('global.Buffer is not available');
      return false;
    }

    // The algosdk round-trip is a dev-only sanity probe. It is pure-JS ed25519
    // keygen plus a SHA-512 mnemonic checksum and allocates a throwaway secret
    // key, so it stays off the release cold-boot path; equivalent coverage lives
    // in src/utils/__tests__/cryptoTest.test.ts. The cheap typeof checks above
    // still run in production.
    if (__DEV__) {
      // Test basic algosdk functionality
      const account = algosdk.generateAccount();
      if (!account || !account.addr || !account.sk) {
        console.error('algosdk.generateAccount failed');
        return false;
      }

      try {
        // Test mnemonic generation
        const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
        if (
          !mnemonic ||
          typeof mnemonic !== 'string' ||
          mnemonic.split(' ').length !== 25
        ) {
          console.error('algosdk.secretKeyToMnemonic failed');
          return false;
        }
      } finally {
        // Overwrite the throwaway secret key so it does not linger in memory.
        account.sk.fill(0);
      }
    }

    console.log('✅ All crypto polyfills are working correctly');
    return true;
  } catch (error) {
    console.error('❌ Crypto polyfill test failed:', error);
    return false;
  }
};
