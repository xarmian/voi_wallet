/**
 * PBKDF2 backend shim (TASK-311).
 *
 * The whole point of this module is that it is a PURE BACKEND SWAP: whatever
 * runs, the bytes must equal what `CryptoJS.PBKDF2` produced before, or every
 * stored PIN hash and wrapped blob on every existing install becomes
 * unreadable. These tests pin exactly that.
 *
 * Under jest there is no native runtime, so `pbkdf2Hex` resolves to the CryptoJS
 * backend — which is the pre-existing implementation. That makes these tests a
 * regression gate on the fallback path and on the KAT itself; the native path is
 * gated at runtime by the same KAT and verified on-device.
 */
import CryptoJS from 'crypto-js';
import 'crypto-js/pbkdf2';

import {
  pbkdf2Hex,
  getPbkdf2Backend,
  PBKDF2_PARITY_KAT,
  __resetPbkdf2BackendForTests,
} from '../pbkdf2Kdf';

/** The exact call the old inline `customPBKDF2` made, kept as the oracle. */
const legacyCryptoJsPbkdf2 = (
  password: string,
  saltHex: string,
  iterations: number,
  keyLength: number
): string => {
  const saltWA = CryptoJS.enc.Hex.parse(saltHex);
  return CryptoJS.PBKDF2(password, saltWA, {
    keySize: keyLength / 4,
    iterations,
    hasher: CryptoJS.algo.SHA256,
  }).toString(CryptoJS.enc.Hex);
};

beforeEach(() => {
  __resetPbkdf2BackendForTests();
});

describe('pbkdf2Kdf', () => {
  it('reproduces the hardcoded known-answer vector', async () => {
    const out = await pbkdf2Hex(
      PBKDF2_PARITY_KAT.pw,
      PBKDF2_PARITY_KAT.saltHex,
      PBKDF2_PARITY_KAT.iterations,
      PBKDF2_PARITY_KAT.dkLen
    );
    expect(out).toBe(PBKDF2_PARITY_KAT.expectedHex);
  });

  it('the KAT itself matches what CryptoJS produces', () => {
    // Guards against a typo'd vector silently disabling the native path
    // forever: if this drifts, the parity gate would reject a CORRECT native
    // backend and every device would fall back to the slow implementation.
    expect(
      legacyCryptoJsPbkdf2(
        PBKDF2_PARITY_KAT.pw,
        PBKDF2_PARITY_KAT.saltHex,
        PBKDF2_PARITY_KAT.iterations,
        PBKDF2_PARITY_KAT.dkLen
      )
    ).toBe(PBKDF2_PARITY_KAT.expectedHex);
  });

  it.each([
    ['1234', 'aabbccddeeff00112233445566778899', 1000, 32],
    ['a-much-longer-passphrase with spaces', '00'.repeat(16), 500, 32],
    ['unicode-✓-secret', 'ff'.repeat(16), 250, 16],
  ])(
    'is byte-identical to the previous CryptoJS implementation (%s)',
    async (pw, salt, iters, len) => {
      const expected = legacyCryptoJsPbkdf2(
        pw as string,
        salt as string,
        iters as number,
        len as number
      );
      await expect(
        pbkdf2Hex(pw as string, salt as string, iters as number, len as number)
      ).resolves.toBe(expected);
    }
  );

  it('falls back to the JS backend when no native module is present', async () => {
    expect(getPbkdf2Backend()).toBe('unresolved');
    await pbkdf2Hex('x', '00'.repeat(16), 10, 32);
    // jest has no react-native-quick-crypto runtime, so the require fails safely.
    expect(getPbkdf2Backend()).toBe('js');
  });

  it('returns lowercase hex of exactly keyLength bytes', async () => {
    const out = await pbkdf2Hex('secret', '00'.repeat(16), 10, 32);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });
});
