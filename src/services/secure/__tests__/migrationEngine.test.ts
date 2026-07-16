// PR5 (TASK-27, DOC-137 §4) — the V2 MIGRATION ENGINE. FUND-RISKING core.
//
// SAFETY FOCUS. These tests prove:
//   * a 64-byte algosdk `sk` round-trips BYTE-IDENTICALLY through a Format-A→v2
//     lazy migration, with the derived public address unchanged and a real
//     Ed25519 (Pera-style) sign still verifying (§0 P1-A / AC8);
//   * migrateAccountToV2 finalizes to a v2-ONLY payload (legacy device-key copy
//     dropped) under the CURRENT secret, and is idempotent (ALREADY_V2);
//   * an injected verify failure leaves the OLD copy readable, drops the unproven
//     new blob, and returns NOT_MIGRATED (never throws, never strands — §4.4/AC3);
//   * a wrong/absent secret (for a secret-gated account) is a NOT_MIGRATED no-op
//     that never touches storage;
//   * watch-only payloads are untouched;
//   * per-account in-flight dedup coalesces the lazy trigger + the sweep onto ONE
//     scrypt+rewrap;
//   * the post-unlock sweep migrates every idle account, STOPS on a mid-sweep
//     lock, and one account's failure never aborts the rest;
//   * the getPrivateKey lazy trigger fires on a legacy-tier decrypt with a secret
//     and NOT when the vault is locked with no PIN.
//
// SECURITY NOTE: key material is a throwaway Ed25519 keypair; PINs are throwaway
// test strings. Nothing real is used, and nothing is logged.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  return {
    __secure: secure,
    __kv: kv,
    __reset: () => {
      secure.clear();
      kv.clear();
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: jest.fn(async (k: string) =>
        secure.has(k) ? secure.get(k)! : null
      ),
      setItem: jest.fn(async (k: string, v: string) => {
        secure.set(k, v);
      }),
      deleteItem: jest.fn(async (k: string) => {
        secure.delete(k);
      }),
      getItemWithAuth: jest.fn(async (k: string) =>
        secure.has(k) ? secure.get(k)! : null
      ),
      setItemWithAuth: jest.fn(async (k: string, v: string) => {
        secure.set(k, v);
      }),
    },
    storage: {
      getItem: jest.fn(async (k: string) => (kv.has(k) ? kv.get(k)! : null)),
      setItem: jest.fn(async (k: string, v: string) => {
        kv.set(k, v);
      }),
      removeItem: jest.fn(async (k: string) => {
        kv.delete(k);
      }),
      multiRemove: jest.fn(async (keys: string[]) => {
        keys.forEach((k) => kv.delete(k));
      }),
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: {
      getDeviceId: async () => 'pr5-test-device-idfv',
    },
  };
});

import CryptoJS from 'crypto-js';
import 'crypto-js/hmac-sha256';
import 'crypto-js/sha256';
import 'crypto-js/aes';
import 'crypto-js/mode-ctr';
import 'crypto-js/pad-nopadding';
import 'crypto-js/enc-hex';
import 'crypto-js/pbkdf2';
import { createHash, randomBytes } from 'crypto';
import nacl from 'tweetnacl';
import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import type { MigrationResult } from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';
import {
  encryptKeyEnvelopeV2,
  decryptKeyEnvelopeV2,
  KeyEnvelopeV2,
} from '../envelopeV2';
import type { ScryptKdfParams } from '../../backup/types';

const DEVICE_ID = 'pr5-test-device-idfv';
const PIN_ITERATIONS = 8000; // AccountSecureStorage.PIN_ITERATIONS
const ENCRYPTION_KEY_ITERATIONS = 10000; // AccountSecureStorage.ENCRYPTION_KEY_ITERATIONS
// Small (power-of-two, within caps) scrypt params keep the suites fast. The
// DEFAULT (2^14) is exercised by the byte-identity round-trip test, which uses
// the real writer with no injection.
const FAST_PARAMS: ScryptKdfParams = { N: 2 ** 12, r: 8, p: 1, dkLen: 32 };

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
  secureStorage: {
    getItem: jest.Mock;
    setItem: jest.Mock;
    getItemWithAuth: jest.Mock;
    setItemWithAuth: jest.Mock;
    deleteItem: jest.Mock;
  };
};

// Reach the private statics the way the merged suites do (cast, no `any`).
const asPriv = AccountSecureStorage as unknown as {
  encryptPrivateKeyV2: (
    keyBytes: Uint8Array,
    secret: string,
    secretSource: 'pin' | 'passphrase',
    options: { deviceBound: boolean }
  ) => Promise<KeyEnvelopeV2>;
  persistPinCredential: (data: {
    hash: string;
    iterations: number;
    salt: string;
    secretSource: 'pin' | 'passphrase';
  }) => Promise<void>;
  constantTimeEqualBytes: (a: Uint8Array, b: Uint8Array) => boolean;
  hashPin: (pin: string, salt: string, iterations: number) => string;
  throttleMirror: unknown;
  legacyCheckRequired: boolean | undefined;
};

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function nodeSha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function customPBKDF2(
  password: string,
  saltHex: string,
  iterations: number,
  keyLength: number
): string {
  const saltWA = CryptoJS.enc.Hex.parse(saltHex);
  const derived = CryptoJS.PBKDF2(password, saltWA, {
    keySize: keyLength / 4,
    iterations,
    hasher: CryptoJS.algo.SHA256,
  });
  return derived.toString(CryptoJS.enc.Hex);
}

/** A real 64-byte Ed25519 secret key (seed‖pubkey), as algosdk stores. */
function makeAlgoKey(): {
  sk: Uint8Array;
  pubkey: Uint8Array;
  address: string;
} {
  const kp = nacl.sign.keyPair();
  return {
    sk: kp.secretKey, // 64 bytes
    pubkey: kp.publicKey, // 32 bytes = sk.slice(32)
    address: algosdk.encodeAddress(kp.publicKey),
  };
}

/** Build a legacy 4-colon blob under a given base-entropy string. */
function makeLegacyBlob(privateKey: Uint8Array, entropyString: string): string {
  const saltHex = randomBytes(32).toString('hex');
  const ivHex = randomBytes(16).toString('hex');
  const baseEntropy = nodeSha256Hex(entropyString);
  const keyMaterial = customPBKDF2(
    baseEntropy,
    saltHex,
    ENCRYPTION_KEY_ITERATIONS,
    32
  );
  const privateKeyHex = hex(privateKey);
  const encrypted = CryptoJS.AES.encrypt(
    privateKeyHex,
    CryptoJS.enc.Hex.parse(keyMaterial),
    {
      iv: CryptoJS.enc.Hex.parse(ivHex),
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    }
  );
  const ct = encrypted.toString();
  const hmacKey = CryptoJS.SHA256(keyMaterial + 'hmac_salt').toString();
  const hmac = CryptoJS.HmacSHA256(ct, hmacKey).toString();
  return `${saltHex}:${ivHex}:${ct}:${hmac}`;
}

/** Format A: device-key wrap (voi_wallet_<deviceId>), PIN-independent. */
function makeFormatA(privateKey: Uint8Array): string {
  return makeLegacyBlob(privateKey, `voi_wallet_${DEVICE_ID}`);
}

/** Format C: legacy PIN-mixed wrap (voi_wallet_pin_<pin>_<deviceId>). */
function makeFormatC(privateKey: Uint8Array, pin: string): string {
  return makeLegacyBlob(privateKey, `voi_wallet_pin_${pin}_${DEVICE_ID}`);
}

function secretKey(id: string): string {
  return `voi_account_secret_${id}`;
}

function addToList(id: string): void {
  const raw = mockPlatform.__kv.get('voi_account_list');
  const list: string[] = raw ? JSON.parse(raw) : [];
  if (!list.includes(id)) {
    list.push(id);
  }
  mockPlatform.__kv.set('voi_account_list', JSON.stringify(list));
}

function seedFormatA(id: string, sk: Uint8Array): void {
  mockPlatform.__secure.set(
    secretKey(id),
    JSON.stringify({
      accountId: id,
      encryptedPrivateKey: makeFormatA(sk),
      authMethod: 'pin',
    })
  );
  addToList(id);
}

function seedFormatC(id: string, sk: Uint8Array, pin: string): void {
  mockPlatform.__secure.set(
    secretKey(id),
    JSON.stringify({
      accountId: id,
      encryptedPrivateKey: makeFormatC(sk, pin),
      authMethod: 'pin',
    })
  );
  addToList(id);
}

/** Watch-only: exists in the list + metadata, but no secret payload. */
function seedWatchOnly(id: string): void {
  addToList(id);
}

async function seedV2(
  id: string,
  sk: Uint8Array,
  secret: string
): Promise<void> {
  const blob = await encryptKeyEnvelopeV2({
    plaintext: sk,
    secret,
    secretSource: 'pin',
    deviceSecret: DEVICE_ID,
    kdfParams: FAST_PARAMS,
  });
  mockPlatform.__secure.set(
    secretKey(id),
    JSON.stringify({
      accountId: id,
      encryptedPrivateKey: '',
      authMethod: 'pin',
      version: 2,
      blobs: [blob],
    })
  );
  addToList(id);
}

interface Payload {
  accountId: string;
  encryptedPrivateKey: string;
  authMethod: string;
  version?: number;
  blobs?: KeyEnvelopeV2[];
}

function readPayload(id: string): Payload {
  return JSON.parse(mockPlatform.__secure.get(secretKey(id))!);
}

/** Force the WRITER path to FAST_PARAMS so re-wraps stay fast + deterministic. */
function useFastWriter(): void {
  jest
    .spyOn(asPriv, 'encryptPrivateKeyV2')
    .mockImplementation(async (keyBytes, secret, secretSource, options) =>
      encryptKeyEnvelopeV2({
        plaintext: keyBytes,
        secret,
        secretSource,
        deviceSecret: options.deviceBound ? DEVICE_ID : undefined,
        kdfParams: FAST_PARAMS,
      })
    );
}

/** Persist a folded PIN credential directly (skips the rewrap flow). */
async function seedCredential(pin: string): Promise<void> {
  const salt = 'a'.repeat(64);
  await asPriv.persistPinCredential({
    hash: asPriv.hashPin(pin, salt, PIN_ITERATIONS),
    iterations: PIN_ITERATIONS,
    salt,
    secretSource: 'pin',
  });
}

const PIN = '135790';

/** Enable biometrics so the `pin=undefined` reader branch passes its gate (the
 *  realistic unlocked-vault read path — a PIN-only+no-biometric wallet still
 *  requires an explicit PIN on that branch, unchanged by PR5). */
function enableBiometrics(): void {
  mockPlatform.__kv.set('voi_biometric_enabled', 'true');
}

beforeEach(() => {
  mockPlatform.__reset();
  AccountSecureStorage.clearPrivateKeyCache();
  SessionKeyVault.clear();
  asPriv.throttleMirror = null;
  asPriv.legacyCheckRequired = undefined;
  mockPlatform.secureStorage.getItem.mockImplementation(async (k: string) =>
    mockPlatform.__secure.has(k) ? mockPlatform.__secure.get(k)! : null
  );
  mockPlatform.secureStorage.setItem.mockImplementation(
    async (k: string, v: string) => {
      mockPlatform.__secure.set(k, v);
    }
  );
});

afterEach(() => {
  SessionKeyVault.clear();
  jest.restoreAllMocks();
});

describe('migrateAccountToV2 — happy path', () => {
  it('migrates a Format-A account to a v2-ONLY payload, byte-identically', async () => {
    const k = makeAlgoKey();
    seedFormatA('acct-A', k.sk);
    await seedCredential(PIN);

    // Real default-param writer here (no useFastWriter) — the byte-identity AC8
    // proof runs the actual 2^14 KDF once.
    const result: MigrationResult =
      await AccountSecureStorage.migrateAccountToV2('acct-A', PIN, 'pin');
    expect(result).toBe('MIGRATED');

    const payload = readPayload('acct-A');
    // v2-only: legacy device-key copy is gone; exactly one blob remains.
    expect(payload.encryptedPrivateKey).toBe('');
    expect(payload.version).toBe(2);
    expect(payload.blobs).toHaveLength(1);

    // The blob decrypts under the secret to the EXACT original 64-byte sk.
    const recovered = await decryptKeyEnvelopeV2(
      payload.blobs![0],
      PIN,
      DEVICE_ID
    );
    expect(recovered).not.toBeNull();
    expect(hex(recovered!)).toBe(hex(k.sk));

    // AC8: address unchanged + a real Ed25519 (Pera-style) sign verifies.
    const derivedAddr = algosdk.encodeAddress(recovered!.slice(32));
    expect(derivedAddr).toBe(k.address);
    const msg = Uint8Array.from(randomBytes(48));
    const sig = nacl.sign.detached(msg, recovered!);
    expect(nacl.sign.detached.verify(msg, sig, k.pubkey)).toBe(true);
  });

  it('migrates a Format-C (legacy PIN-mixed) account under the correct PIN', async () => {
    const k = makeAlgoKey();
    seedFormatC('acct-C', k.sk, PIN);
    await seedCredential(PIN);
    useFastWriter();

    const result = await AccountSecureStorage.migrateAccountToV2(
      'acct-C',
      PIN,
      'pin'
    );
    expect(result).toBe('MIGRATED');

    const payload = readPayload('acct-C');
    expect(payload.encryptedPrivateKey).toBe('');
    expect(payload.blobs).toHaveLength(1);
    const recovered = await decryptKeyEnvelopeV2(
      payload.blobs![0],
      PIN,
      DEVICE_ID
    );
    expect(hex(recovered!)).toBe(hex(k.sk));
  });

  it('is idempotent: a second migration returns ALREADY_V2 and re-wraps nothing', async () => {
    const k = makeAlgoKey();
    await seedV2('acct-V', k.sk, PIN);
    await seedCredential(PIN);

    const before = mockPlatform.__secure.get(secretKey('acct-V'));
    const spy = jest.spyOn(asPriv, 'encryptPrivateKeyV2');

    const result = await AccountSecureStorage.migrateAccountToV2('acct-V', PIN);
    expect(result).toBe('ALREADY_V2');
    // No re-wrap happened; payload bytes unchanged.
    expect(spy).not.toHaveBeenCalled();
    expect(mockPlatform.__secure.get(secretKey('acct-V'))).toBe(before);
  });
});

describe('migrateAccountToV2 — safety / no-op paths', () => {
  it('returns NOT_MIGRATED and touches nothing for a watch-only account', async () => {
    seedWatchOnly('watch');
    await seedCredential(PIN);
    const setSpy = jest.spyOn(mockPlatform.secureStorage, 'setItem');

    const result = await AccountSecureStorage.migrateAccountToV2('watch', PIN);
    expect(result).toBe('NOT_MIGRATED');
    // No secret payload was ever written for this id.
    expect(setSpy.mock.calls.some((c) => c[0] === secretKey('watch'))).toBe(
      false
    );
    expect(mockPlatform.__secure.has(secretKey('watch'))).toBe(false);
  });

  it('returns NOT_MIGRATED for a v2 account when the WRONG secret is supplied, leaving it intact', async () => {
    const k = makeAlgoKey();
    await seedV2('acct-V', k.sk, PIN); // wrapped under PIN
    await seedCredential(PIN);
    const before = mockPlatform.__secure.get(secretKey('acct-V'));

    const result = await AccountSecureStorage.migrateAccountToV2(
      'acct-V',
      '000000' // wrong secret — cannot unwrap the v2 blob
    );
    expect(result).toBe('NOT_MIGRATED');
    // Untouched: still decryptable under the ORIGINAL secret.
    expect(mockPlatform.__secure.get(secretKey('acct-V'))).toBe(before);
    const recovered = await decryptKeyEnvelopeV2(
      readPayload('acct-V').blobs![0],
      PIN,
      DEVICE_ID
    );
    expect(hex(recovered!)).toBe(hex(k.sk));
  });
});

describe('migrateAccountToV2 — verify-before-delete rollback', () => {
  it('an injected verify failure keeps the OLD copy readable, drops the unproven blob, returns NOT_MIGRATED', async () => {
    const k = makeAlgoKey();
    seedFormatA('acct-A', k.sk);
    await seedCredential(PIN);
    useFastWriter();

    // Force the phase-3 byte-equality verify to fail — simulating a torn write.
    const eqSpy = jest
      .spyOn(asPriv, 'constantTimeEqualBytes')
      .mockReturnValue(false);

    const result = await AccountSecureStorage.migrateAccountToV2(
      'acct-A',
      PIN,
      'pin'
    );
    expect(result).toBe('NOT_MIGRATED');
    expect(eqSpy).toHaveBeenCalled();

    // Rollback: the Format-A field is intact and there is NO leftover unproven
    // blob — the account is exactly as it started and still decrypts.
    const payload = readPayload('acct-A');
    expect(payload.encryptedPrivateKey).not.toBe('');
    expect(payload.blobs ?? []).toHaveLength(0);
    const recovered = await AccountSecureStorage.getPrivateKey('acct-A', PIN);
    expect(hex(recovered)).toBe(hex(k.sk));
  });
});

describe('migrateAccountToV2 — per-account in-flight dedup', () => {
  it('coalesces two concurrent migrations onto ONE scrypt+rewrap', async () => {
    const k = makeAlgoKey();
    seedFormatA('acct-A', k.sk);
    await seedCredential(PIN);
    const spy = jest.fn(
      async (
        keyBytes: Uint8Array,
        secret: string,
        secretSource: 'pin' | 'passphrase',
        options: { deviceBound: boolean }
      ) =>
        encryptKeyEnvelopeV2({
          plaintext: keyBytes,
          secret,
          secretSource,
          deviceSecret: options.deviceBound ? DEVICE_ID : undefined,
          kdfParams: FAST_PARAMS,
        })
    );
    jest.spyOn(asPriv, 'encryptPrivateKeyV2').mockImplementation(spy);

    const [r1, r2] = await Promise.all([
      AccountSecureStorage.migrateAccountToV2('acct-A', PIN, 'pin'),
      AccountSecureStorage.migrateAccountToV2('acct-A', PIN, 'pin'),
    ]);
    // Both callers see the same (single) migration.
    expect(r1).toBe('MIGRATED');
    expect(r2).toBe('MIGRATED');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(readPayload('acct-A').blobs).toHaveLength(1);
  });
});

describe('migrateAllAccountsToV2 — post-unlock sweep', () => {
  it('migrates every idle Format-A account under the vault secret', async () => {
    const ks = [makeAlgoKey(), makeAlgoKey(), makeAlgoKey()];
    ks.forEach((k, i) => seedFormatA(`sweep-${i}`, k.sk));
    await seedCredential(PIN);
    useFastWriter();
    SessionKeyVault.set(PIN, 'pin');

    await AccountSecureStorage.migrateAllAccountsToV2();

    for (let i = 0; i < ks.length; i++) {
      const payload = readPayload(`sweep-${i}`);
      expect(payload.encryptedPrivateKey).toBe('');
      expect(payload.blobs).toHaveLength(1);
      const recovered = await decryptKeyEnvelopeV2(
        payload.blobs![0],
        PIN,
        DEVICE_ID
      );
      expect(hex(recovered!)).toBe(hex(ks[i].sk));
    }
  });

  it('does nothing when the vault is locked (no secret to migrate under)', async () => {
    const k = makeAlgoKey();
    seedFormatA('sweep-0', k.sk);
    await seedCredential(PIN);
    const before = mockPlatform.__secure.get(secretKey('sweep-0'));
    // Vault deliberately NOT set (locked).

    await AccountSecureStorage.migrateAllAccountsToV2();

    expect(mockPlatform.__secure.get(secretKey('sweep-0'))).toBe(before);
  });

  it('stops mid-sweep when the vault locks, leaving later accounts on legacy', async () => {
    const ks = [makeAlgoKey(), makeAlgoKey(), makeAlgoKey()];
    ks.forEach((k, i) => seedFormatA(`sweep-${i}`, k.sk));
    await seedCredential(PIN);
    useFastWriter();
    SessionKeyVault.set(PIN, 'pin');

    // Lock the vault right after the first account migrates.
    const origGetSecret = SessionKeyVault.getSecret.bind(SessionKeyVault);
    let calls = 0;
    jest.spyOn(SessionKeyVault, 'getSecret').mockImplementation(() => {
      calls += 1;
      if (calls > 1) {
        return null; // vault locked before account #2
      }
      return origGetSecret();
    });

    await AccountSecureStorage.migrateAllAccountsToV2();

    // Account 0 migrated; 1 and 2 left on legacy (sweep stopped).
    expect(readPayload('sweep-0').encryptedPrivateKey).toBe('');
    expect(readPayload('sweep-1').encryptedPrivateKey).not.toBe('');
    expect(readPayload('sweep-2').encryptedPrivateKey).not.toBe('');
  });

  it('a non-migratable middle account never aborts the sweep of the others', async () => {
    const k0 = makeAlgoKey();
    const k1 = makeAlgoKey();
    const k2 = makeAlgoKey();
    seedFormatA('sweep-0', k0.sk);
    // sweep-1 is a v2 blob under a DIFFERENT secret → unreadable under PIN →
    // migrateAccountToV2 returns NOT_MIGRATED and leaves it untouched.
    await seedV2('sweep-1', k1.sk, '999999');
    seedFormatA('sweep-2', k2.sk);
    await seedCredential(PIN);
    useFastWriter();
    SessionKeyVault.set(PIN, 'pin');

    const before1 = mockPlatform.__secure.get(secretKey('sweep-1'));
    await AccountSecureStorage.migrateAllAccountsToV2();

    // 0 and 2 migrated to v2-only; the non-migratable 1 is byte-for-byte intact.
    expect(readPayload('sweep-0').encryptedPrivateKey).toBe('');
    expect(readPayload('sweep-2').encryptedPrivateKey).toBe('');
    expect(mockPlatform.__secure.get(secretKey('sweep-1'))).toBe(before1);
  });
});

describe('getPrivateKey — lazy migration trigger', () => {
  it('fires migrateAccountToV2 after a Format-A decrypt with an explicit PIN', async () => {
    const k = makeAlgoKey();
    seedFormatA('acct-A', k.sk);
    await seedCredential(PIN);
    const migSpy = jest
      .spyOn(AccountSecureStorage, 'migrateAccountToV2')
      .mockResolvedValue('MIGRATED');

    const recovered = await AccountSecureStorage.getPrivateKey('acct-A', PIN);
    expect(hex(recovered)).toBe(hex(k.sk)); // read still correct
    expect(migSpy).toHaveBeenCalledWith('acct-A', PIN, 'pin');
  });

  it('fires under an unlocked vault (pin=undefined, biometric read) using the vault secret', async () => {
    const k = makeAlgoKey();
    seedFormatA('acct-A', k.sk);
    await seedCredential(PIN);
    enableBiometrics(); // so the pin=undefined reader branch is allowed
    SessionKeyVault.set(PIN, 'pin');
    const migSpy = jest
      .spyOn(AccountSecureStorage, 'migrateAccountToV2')
      .mockResolvedValue('MIGRATED');

    await AccountSecureStorage.getPrivateKey('acct-A');
    expect(migSpy).toHaveBeenCalledWith('acct-A', PIN, 'pin');
  });

  it('does NOT fire when the vault is locked and no PIN is supplied (no secret)', async () => {
    const k = makeAlgoKey();
    seedFormatA('acct-A', k.sk);
    // No PIN credential + no vault: biometric-less, key-less read path still
    // decrypts Format A via the device key, but there is no secret to migrate under.
    const migSpy = jest
      .spyOn(AccountSecureStorage, 'migrateAccountToV2')
      .mockResolvedValue('NOT_MIGRATED');

    await AccountSecureStorage.getPrivateKey('acct-A');
    expect(migSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire for an already-v2 read (no legacy tier used)', async () => {
    const k = makeAlgoKey();
    await seedV2('acct-V', k.sk, PIN);
    await seedCredential(PIN);
    enableBiometrics(); // so the pin=undefined reader branch is allowed
    SessionKeyVault.set(PIN, 'pin');
    const migSpy = jest
      .spyOn(AccountSecureStorage, 'migrateAccountToV2')
      .mockResolvedValue('ALREADY_V2');

    await AccountSecureStorage.getPrivateKey('acct-V');
    expect(migSpy).not.toHaveBeenCalled();
  });
});
