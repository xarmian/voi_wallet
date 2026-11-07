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

// DR-7 / HT-377: every fallback path is LOUD in all builds (console.warn, which
// release bundles keep) and logs ONLY the backend name and the error class.
describe('pbkdf2Kdf loud fallback (DR-7)', () => {
  const nodeCrypto = require('crypto') as typeof import('crypto');
  const SECRET = 'leak-canary-pin-4b2d';
  const SALT_HEX = 'c0ffee00'.repeat(4);
  const ERR_MSG = 'leak-canary-native-error-message';
  // An identifier-shaped secret smuggled in as Error.name must not be logged.
  const HOSTILE_NAME = 'leakCanaryPin4b2d';

  type Mod = typeof import('../pbkdf2Kdf');

  const loadWith = (qc: Record<string, unknown>): Mod => {
    jest.resetModules();
    jest.doMock('react-native-quick-crypto', () => qc);
    return require('../pbkdf2Kdf') as Mod;
  };

  const realNative = (
    pw: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    cb: (err: Error | null, out: Uint8Array) => void
  ) => {
    cb(null, nodeCrypto.pbkdf2Sync(pw, salt, iterations, keylen, digest));
  };

  /** A fake native pbkdf2: correct on the parity KAT, then per `mode`. */
  const fakeNative =
    (mode: 'throw-on-parity' | 'throw-after-parity' | 'getter-after-parity') =>
    (
      pw: Uint8Array,
      salt: Uint8Array,
      iterations: number,
      keylen: number,
      digest: string,
      cb: (err: Error | null, out: Uint8Array) => void
    ) => {
      const isParity =
        Buffer.from(pw).toString('utf8') === PBKDF2_PARITY_KAT.pw;
      if (mode === 'throw-on-parity' || !isParity) {
        // synchronous native throw
        throw mode === 'throw-on-parity'
          ? new TypeError(ERR_MSG)
          : mode === 'getter-after-parity'
            ? Object.defineProperty(new Error(ERR_MSG), 'name', {
                get() {
                  throw new Error('name getter');
                },
              })
            : Object.assign(new Error(ERR_MSG), { name: HOSTILE_NAME });
      }
      realNative(pw, salt, iterations, keylen, digest, cb);
    };

  const assertNoLeak = (warn: jest.SpyInstance, derivedHex: string) => {
    const forbidden = [
      SECRET,
      SALT_HEX,
      derivedHex,
      PBKDF2_PARITY_KAT.pw,
      PBKDF2_PARITY_KAT.saltHex,
      PBKDF2_PARITY_KAT.expectedHex,
      ERR_MSG,
      HOSTILE_NAME,
    ];
    for (const call of warn.mock.calls) {
      for (const arg of call) {
        expect(typeof arg).toBe('string');
        for (const f of forbidden) expect(arg as string).not.toContain(f);
      }
    }
  };

  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    jest.dontMock('react-native-quick-crypto');
  });

  it('warns (backend name only) when the native module is absent', async () => {
    const mod = loadWith({});
    const out = await mod.pbkdf2Hex(SECRET, SALT_HEX, 100, 32);
    expect(mod.getPbkdf2Backend()).toBe('js');
    // Exact equality: nothing beyond the fixed message can ride along.
    expect(warn.mock.calls).toEqual([
      [
        '[pbkdf2Kdf] backend=js: native pbkdf2 module unavailable; using CryptoJS fallback',
      ],
    ]);
    assertNoLeak(warn, out);
  });

  it('warns with the error class only when native throws during the parity check', async () => {
    const mod = loadWith({ pbkdf2: fakeNative('throw-on-parity') });
    const out = await mod.pbkdf2Hex(SECRET, SALT_HEX, 100, 32);
    expect(mod.getPbkdf2Backend()).toBe('js');
    expect(warn.mock.calls).toEqual([
      [
        '[pbkdf2Kdf] backend=js: native pbkdf2 threw during parity check; using CryptoJS fallback',
        'TypeError',
      ],
    ]);
    assertNoLeak(warn, out);
  });

  it('warns with the error class only when a native call fails after parity passed', async () => {
    const mod = loadWith({ pbkdf2: fakeNative('throw-after-parity') });
    const out = await mod.pbkdf2Hex(SECRET, SALT_HEX, 100, 32);
    expect(mod.getPbkdf2Backend()).toBe('native');
    expect(out).toBe(legacyCryptoJsPbkdf2(SECRET, SALT_HEX, 100, 32));
    expect(warn.mock.calls).toEqual([
      [
        '[pbkdf2Kdf] backend=native: native call failed; CryptoJS for this call',
        'Error(custom)',
      ],
    ]);
    assertNoLeak(warn, out);
  });

  it('still falls back when the error has a throwing name getter', async () => {
    const mod = loadWith({ pbkdf2: fakeNative('getter-after-parity') });
    await expect(
      mod.pbkdf2Hex(SECRET, SALT_HEX, 100, 32)
    ).resolves.toBeDefined();
    expect(mod.getPbkdf2Backend()).toBe('native');
    expect(warn.mock.calls).toEqual([
      [
        '[pbkdf2Kdf] backend=native: native call failed; CryptoJS for this call',
        'Error(unreadable)',
      ],
    ]);
  });

  it('warns (backend name only) when native fails byte-parity', async () => {
    const wrong = (
      _pw: Uint8Array,
      _salt: Uint8Array,
      _iterations: number,
      keylen: number,
      _digest: string,
      cb: (err: Error | null, out: Uint8Array) => void
    ) => cb(null, new Uint8Array(keylen)); // all-zero output: present but WRONG
    const mod = loadWith({ pbkdf2: wrong });
    const out = await mod.pbkdf2Hex(SECRET, SALT_HEX, 100, 32);
    expect(mod.getPbkdf2Backend()).toBe('js');
    expect(warn.mock.calls).toEqual([
      [
        '[pbkdf2Kdf] backend=js: native pbkdf2 failed byte-parity; using CryptoJS fallback',
      ],
    ]);
    assertNoLeak(warn, out);
  });

  it('stays silent when native passes parity and succeeds', async () => {
    const mod = loadWith({ pbkdf2: realNative });
    const out = await mod.pbkdf2Hex(SECRET, SALT_HEX, 100, 32);
    expect(mod.getPbkdf2Backend()).toBe('native');
    expect(out).toBe(legacyCryptoJsPbkdf2(SECRET, SALT_HEX, 100, 32));
    expect(warn).not.toHaveBeenCalled();
  });
});
