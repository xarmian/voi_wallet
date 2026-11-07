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

// DR-7 / HT-377: every fallback path is LOUD in all builds (console.warn, which
// release bundles keep) and logs ONLY the backend name and the error class.
describe('scryptKdf loud fallback (DR-7)', () => {
  const SECRET = 'leak-canary-password-7f3a';
  const SALT = 'leak-canary-salt-9c1e';
  const ERR_MSG = 'leak-canary-native-error-message';
  // An identifier-shaped secret smuggled in as Error.name must not be logged.
  const HOSTILE_NAME = 'leakCanaryPassword7f3a';
  const PARAMS = { N: 256, r: 8, p: 1, dkLen: 32 };

  type Mod = typeof import('../scryptKdf');

  /** Load a fresh copy of the shim against the given quick-crypto module. */
  const loadWith = (qc: Record<string, unknown>): Mod => {
    jest.resetModules();
    jest.doMock('react-native-quick-crypto', () => qc);
    return require('../scryptKdf') as Mod;
  };

  /** A fake native scrypt: correct on the parity KAT, then per `mode`. */
  const fakeNative =
    (mode: 'throw-on-parity' | 'throw-after-parity' | 'getter-after-parity') =>
    (
      pw: Uint8Array,
      salt: Uint8Array,
      keylen: number,
      opts: { N: number; r: number; p: number; maxmem?: number },
      cb: (err: Error | null, out: Uint8Array) => void
    ) => {
      const isParity =
        bytesToHex(pw) === bytesToHex(utf8ToBytes(SCRYPT_PARITY_KAT.pw));
      if (mode === 'throw-on-parity' || !isParity) {
        const err =
          mode === 'throw-on-parity'
            ? new TypeError(ERR_MSG)
            : mode === 'getter-after-parity'
              ? Object.defineProperty(new Error(ERR_MSG), 'name', {
                  get() {
                    throw new Error('name getter');
                  },
                })
              : Object.assign(new Error(ERR_MSG), { name: HOSTILE_NAME });
        cb(err, new Uint8Array());
        return;
      }
      scryptAsync(pw, salt, { ...opts, dkLen: keylen }).then(
        (out) => cb(null, out),
        (e: Error) => cb(e, new Uint8Array())
      );
    };

  /** Every warn arg must be a plain string free of inputs, outputs and error text. */
  const assertNoLeak = (warn: jest.SpyInstance, derived: Uint8Array) => {
    const forbidden = [
      SECRET,
      SALT,
      bytesToHex(utf8ToBytes(SALT)),
      bytesToHex(derived),
      SCRYPT_PARITY_KAT.pw,
      SCRYPT_PARITY_KAT.salt,
      SCRYPT_PARITY_KAT.expectedHex,
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
    const out = await mod.scryptRaw(SECRET, utf8ToBytes(SALT), PARAMS);
    expect(mod.getScryptBackend()).toBe('js');
    // Exact equality: nothing beyond the fixed message can ride along.
    expect(warn.mock.calls).toEqual([
      [
        '[scryptKdf] backend=js: native scrypt module unavailable; using @noble fallback',
      ],
    ]);
    assertNoLeak(warn, out);
  });

  it('warns with the error class only when native throws during the parity check', async () => {
    const mod = loadWith({ scrypt: fakeNative('throw-on-parity') });
    const out = await mod.scryptRaw(SECRET, utf8ToBytes(SALT), PARAMS);
    expect(mod.getScryptBackend()).toBe('js');
    expect(warn.mock.calls).toEqual([
      [
        '[scryptKdf] backend=js: native scrypt threw during parity check; using @noble fallback',
        'TypeError',
      ],
    ]);
    assertNoLeak(warn, out);
  });

  it('warns with the error class only when a native call fails after parity passed', async () => {
    const mod = loadWith({ scrypt: fakeNative('throw-after-parity') });
    const out = await mod.scryptRaw(SECRET, utf8ToBytes(SALT), PARAMS);
    // Backend selection is unchanged: parity passed, so native stays selected
    // and only THIS call degrades to @noble (still byte-identical).
    expect(mod.getScryptBackend()).toBe('native');
    const viaNoble = await scryptAsync(utf8ToBytes(SECRET), utf8ToBytes(SALT), {
      ...PARAMS,
      maxmem: MAXMEM,
    });
    expect(bytesToHex(out)).toBe(bytesToHex(viaNoble));
    expect(warn.mock.calls).toEqual([
      [
        '[scryptKdf] backend=native: native call failed; @noble for this call',
        'Error(custom)',
      ],
    ]);
    assertNoLeak(warn, out);
  });

  it('still falls back when the error has a throwing name getter', async () => {
    const mod = loadWith({ scrypt: fakeNative('getter-after-parity') });
    await expect(
      mod.scryptRaw(SECRET, utf8ToBytes(SALT), PARAMS)
    ).resolves.toBeDefined();
    expect(mod.getScryptBackend()).toBe('native');
    expect(warn.mock.calls).toEqual([
      [
        '[scryptKdf] backend=native: native call failed; @noble for this call',
        'Error(unreadable)',
      ],
    ]);
  });

  it('warns (backend name only) when native fails byte-parity', async () => {
    const wrong = (
      _pw: Uint8Array,
      _salt: Uint8Array,
      keylen: number,
      _opts: unknown,
      cb: (err: Error | null, out: Uint8Array) => void
    ) => cb(null, new Uint8Array(keylen)); // all-zero output: present but WRONG
    const mod = loadWith({ scrypt: wrong });
    const out = await mod.scryptRaw(SECRET, utf8ToBytes(SALT), PARAMS);
    expect(mod.getScryptBackend()).toBe('js');
    expect(warn.mock.calls).toEqual([
      [
        '[scryptKdf] backend=js: native scrypt failed byte-parity; using @noble fallback',
      ],
    ]);
    assertNoLeak(warn, out);
  });

  it('stays silent when native passes parity and succeeds', async () => {
    const ok = (
      pw: Uint8Array,
      salt: Uint8Array,
      keylen: number,
      opts: { N: number; r: number; p: number; maxmem?: number },
      cb: (err: Error | null, out: Uint8Array) => void
    ) => {
      scryptAsync(pw, salt, { ...opts, dkLen: keylen }).then(
        (out) => cb(null, out),
        (e: Error) => cb(e, new Uint8Array())
      );
    };
    const mod = loadWith({ scrypt: ok });
    await mod.scryptRaw(SECRET, utf8ToBytes(SALT), PARAMS);
    expect(mod.getScryptBackend()).toBe('native');
    expect(warn).not.toHaveBeenCalled();
  });
});
