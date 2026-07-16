// Unit tests for the native-first scrypt KDF shim (HT-138 fix).
//
// The shim swaps the at-rest scrypt engine to native (react-native-quick-crypto)
// on device while keeping @noble as a byte-identical fallback. jest has no native
// runtime, so these tests exercise the fallback path AND pin the byte contract
// that makes the swap safe: identical output to @noble means existing v2 blobs
// stay decryptable with no envelope change.

import {
  scryptRaw,
  SCRYPT_PARITY_KAT,
  getScryptBackend,
  __resetScryptBackendForTests,
} from '../scryptKdf';
import { scryptAsync } from '@noble/hashes/scrypt';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';

const MAXMEM = 256 * 1024 * 1024;

beforeEach(() => {
  __resetScryptBackendForTests();
});

describe('scryptKdf shim', () => {
  it('reproduces the hardcoded parity KAT via the @noble fallback', async () => {
    // Pins the vector the on-device native backend must reproduce before it is
    // trusted. If @noble ever changed output for these params, this catches it.
    const out = await scryptRaw(
      SCRYPT_PARITY_KAT.pw,
      utf8ToBytes(SCRYPT_PARITY_KAT.salt),
      SCRYPT_PARITY_KAT.params
    );
    expect(bytesToHex(out)).toBe(SCRYPT_PARITY_KAT.expectedHex);
  });

  it('resolves to the JS backend under jest (no native module present)', async () => {
    await scryptRaw('pin-123456', utf8ToBytes('0123456789abcdef'), {
      N: 256,
      r: 8,
      p: 1,
      dkLen: 32,
    });
    expect(getScryptBackend()).toBe('js');
  });

  it('output is byte-identical to a direct @noble derivation (v2-blob compatibility)', async () => {
    const secret = 'correct horse battery staple';
    const salt = utf8ToBytes('another-salt-16b');
    const params = { N: 1024, r: 8, p: 1, dkLen: 32 };

    const viaShim = await scryptRaw(secret, salt, params);
    const viaNoble = await scryptAsync(utf8ToBytes(secret), salt, {
      ...params,
      maxmem: MAXMEM,
    });

    expect(bytesToHex(viaShim)).toBe(bytesToHex(viaNoble));
  });

  it('honors dkLen', async () => {
    const out = await scryptRaw('x', utf8ToBytes('saltsaltsaltsalt'), {
      N: 256,
      r: 8,
      p: 1,
      dkLen: 64,
    });
    expect(out.length).toBe(64);
  });
});
