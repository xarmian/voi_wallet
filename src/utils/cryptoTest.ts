// Test file to verify crypto polyfills are working
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

    // Test basic algosdk functionality
    const account = algosdk.generateAccount();
    if (!account || !account.addr || !account.sk) {
      console.error('algosdk.generateAccount failed');
      return false;
    }

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

    console.log('✅ All crypto polyfills are working correctly');
    return true;
  } catch (error) {
    console.error('❌ Crypto polyfill test failed:', error);
    return false;
  }
};
