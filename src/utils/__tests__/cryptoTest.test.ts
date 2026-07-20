import algosdk from 'algosdk';
import { testCryptoPolyfills } from '../cryptoTest';

// These assertions preserve the coverage that used to run on every app launch
// via testCryptoPolyfills(): the crypto/Buffer polyfills are present and
// algosdk's ed25519 keygen + mnemonic round-trip work end-to-end. Keeping this
// in jest lets us gate the runtime probe behind __DEV__ without losing the
// guarantee that release builds ship a working crypto stack.
describe('crypto polyfills', () => {
  it('exposes crypto.getRandomValues', () => {
    expect(typeof crypto).not.toBe('undefined');
    expect(typeof crypto.getRandomValues).toBe('function');
  });

  it('exposes a global Buffer', () => {
    expect(typeof global.Buffer).not.toBe('undefined');
  });

  it('crypto.getRandomValues fills a byte array with entropy', () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // A working RNG will not leave all 32 bytes zero.
    expect(bytes.some((b) => b !== 0)).toBe(true);
  });

  it('algosdk.generateAccount + secretKeyToMnemonic round-trips', () => {
    const account = algosdk.generateAccount();
    let recovered: { sk: Uint8Array } | undefined;
    try {
      expect(account.addr).toBeTruthy();
      expect(account.sk).toBeInstanceOf(Uint8Array);

      const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
      expect(typeof mnemonic).toBe('string');
      expect(mnemonic.split(' ')).toHaveLength(25);

      // The mnemonic must recover the exact same secret key.
      recovered = algosdk.mnemonicToSecretKey(mnemonic);
      expect(recovered.sk).toEqual(account.sk);
    } finally {
      // Zero the throwaway secret keys so no key material lingers.
      account.sk.fill(0);
      recovered?.sk.fill(0);
    }
  });

  it('testCryptoPolyfills() reports the polyfills are working', () => {
    expect(testCryptoPolyfills()).toBe(true);
  });
});
