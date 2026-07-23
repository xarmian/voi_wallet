// PR4 (TASK-27, DOC-137 §2/§4.4/§5) — the FUND-RISKING core:
//   - the v2 at-rest key writer (encryptPrivateKeyV2 / writeSecretV2);
//   - atomic setupPin/changePin re-wrap (dual-blob verify-before-delete);
//   - the global key-mutation mutex (P1-B);
//   - deletePin policy; salt-in-credential; the 2-blob/2048-byte budget.
//
// SAFETY FOCUS. These tests prove:
//   * a 64-byte algosdk `sk` round-trips BYTE-IDENTICALLY through a Format-A→v2
//     re-wrap, with the derived public address unchanged and a real Ed25519
//     (Pera-style) sign still verifying (§0 P1-A / AC8);
//   * changePin re-wraps EVERY account atomically and each new blob verifies;
//   * an injected failure at each re-wrap step (after add-blob, after
//     partial-verify, before/after commit) leaves ≥1 readable copy and NEVER
//     strands an account (§4.4 / AC3/AC5);
//   * deletePin throws for a key-bearing wallet, allowed for watch-only;
//   * setupPin migrates device-key (Format A) accounts to v2;
//   * the global mutex serializes a concurrent storeAccount vs changePin so a
//     new account is never wrapped under the old secret and stranded (P1-B);
//   * the payload budget is enforced on write; the credential folds the salt.
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
      getDeviceId: async () => 'pr4-test-device-idfv',
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
import { SessionKeyVault } from '../SessionKeyVault';
import {
  encryptKeyEnvelopeV2,
  decryptKeyEnvelopeV2,
  KeyEnvelopeV2,
} from '../envelopeV2';
import type { ScryptKdfParams } from '../../backup/types';
import { AccountType } from '../../../types/wallet';
import type { StandardAccountMetadata } from '../../../types/wallet';

const DEVICE_ID = 'pr4-test-device-idfv';
const PIN_ITERATIONS = 8000; // AccountSecureStorage.PIN_ITERATIONS
// Small (power-of-two, within caps) scrypt params keep the multi-account
// re-wrap suites fast. The DEFAULT (2^14) is exercised by the byte-identity
// round-trip test below, which uses the real writer with no injection.
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
  storage: {
    getItem: jest.Mock;
    setItem: jest.Mock;
    removeItem: jest.Mock;
    multiRemove: jest.Mock;
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
  finalizePayload: (payload: unknown, keepBlob: KeyEnvelopeV2) => unknown;
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

/** Build a legacy Format-A (device-key) 4-colon blob, as encryptPrivateKey does. */
function makeFormatA(privateKey: Uint8Array): string {
  const saltHex = randomBytes(32).toString('hex');
  const ivHex = randomBytes(16).toString('hex');
  const baseEntropy = nodeSha256Hex(`voi_wallet_${DEVICE_ID}`);
  const keyMaterial = customPBKDF2(baseEntropy, saltHex, 10000, 32);

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

function readPayload(id: string): {
  accountId: string;
  encryptedPrivateKey: string;
  authMethod: string;
  version?: number;
  blobs?: KeyEnvelopeV2[];
} {
  return JSON.parse(mockPlatform.__secure.get(secretKey(id))!);
}

/** Force the WRITER path to use FAST_PARAMS so multi-account re-wraps stay fast
 *  and deterministic. The stored blob still self-describes its kdfParams, so the
 *  verify/read paths pick them up unchanged. */
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

/** Minimal STANDARD account metadata for storeAccount. */
function makeStandardMeta(
  id: string,
  k: ReturnType<typeof makeAlgoKey>
): StandardAccountMetadata {
  return {
    id,
    address: k.address,
    publicKey: hex(k.pubkey),
    type: AccountType.STANDARD,
    label: '',
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    mnemonic: '',
    hasBackup: false,
    backupVerified: false,
  };
}

beforeEach(() => {
  mockPlatform.__reset();
  AccountSecureStorage.clearPrivateKeyCache();
  SessionKeyVault.clear();
  asPriv.throttleMirror = null;
  asPriv.legacyCheckRequired = undefined;
  // clearMocks clears CALLS but not IMPLEMENTATIONS, so restore the default
  // passthrough for any test that overrode secureStorage.getItem (the clobber
  // test) — otherwise the override would leak into later tests.
  mockPlatform.secureStorage.getItem.mockImplementation(async (k: string) =>
    mockPlatform.__secure.has(k) ? mockPlatform.__secure.get(k)! : null
  );
});

afterEach(() => {
  SessionKeyVault.clear();
  jest.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('v2 writer round-trip — 64-byte sk is byte-identical (§0 P1-A / AC8)', () => {
  it('Format-A → v2 (via setupPin) preserves the EXACT 64-byte sk, address, and signing', async () => {
    const { sk, pubkey, address } = makeAlgoKey();
    expect(sk.length).toBe(64);
    const id = 'acct-byte-identity';
    seedFormatA(id, sk);

    // Real writer (default 2^14 KDF) — no injection here.
    await AccountSecureStorage.setupPin('123456', 'pin');

    // Migrated to v2: the legacy device-key copy is gone, a single v2 blob remains.
    const payload = readPayload(id);
    expect(payload.encryptedPrivateKey).toBe('');
    expect(payload.blobs).toHaveLength(1);
    expect(payload.version).toBe(2);

    // Round-trip the stored bytes — BYTE-IDENTICAL, whatever the length.
    const out = await AccountSecureStorage.getPrivateKey(id, '123456');
    expect(out.length).toBe(64);
    expect(hex(out)).toBe(hex(sk));

    // Public address unchanged (derived from sk.slice(32)).
    expect(hex(out.slice(32))).toBe(hex(pubkey));
    expect(algosdk.encodeAddress(out.slice(32))).toBe(address);

    // A real (Pera-style) Ed25519 signature by the round-tripped key verifies.
    const msg = Uint8Array.from(Buffer.from('voi pr4 sign check', 'utf8'));
    const sig = nacl.sign.detached(msg, out);
    expect(nacl.sign.detached.verify(msg, sig, pubkey)).toBe(true);
  }, 20000);

  it('encryptPrivateKeyV2 defaults to the at-rest 2^14 KDF params', async () => {
    const { sk } = makeAlgoKey();
    const blob = await asPriv.encryptPrivateKeyV2(sk, '123456', 'pin', {
      deviceBound: true,
    });
    expect(blob.kdfParams.N).toBe(2 ** 14);
    expect(blob.deviceBound).toBe(true);
    // And it round-trips byte-exactly under the same secret + device id.
    const back = await decryptKeyEnvelopeV2(blob, '123456', DEVICE_ID);
    expect(back && hex(back)).toBe(hex(sk));
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('setupPin — first-secret device→v2 migration (§5.4)', () => {
  it('migrates ALL pre-existing Format-A accounts to v2 under the new PIN', async () => {
    useFastWriter();
    const a = makeAlgoKey();
    const b = makeAlgoKey();
    seedFormatA('acct-a', a.sk);
    seedFormatA('acct-b', b.sk);

    await AccountSecureStorage.setupPin('123456', 'pin');

    for (const [id, k] of [
      ['acct-a', a],
      ['acct-b', b],
    ] as const) {
      const payload = readPayload(id);
      expect(payload.encryptedPrivateKey).toBe(''); // device-key copy dropped
      expect(payload.blobs).toHaveLength(1);
      const out = await AccountSecureStorage.getPrivateKey(id, '123456');
      expect(hex(out)).toBe(hex(k.sk));
    }

    // The credential now verifies the new PIN.
    expect(await AccountSecureStorage.verifyPin('123456')).toBe(true);
  }, 20000);

  it('leaves a watch-only account untouched', async () => {
    useFastWriter();
    // Watch-only = present in the list but no secret payload.
    addToList('acct-watch');
    await AccountSecureStorage.setupPin('123456', 'pin');
    expect(mockPlatform.__secure.has(secretKey('acct-watch'))).toBe(false);
    expect(await AccountSecureStorage.verifyPin('123456')).toBe(true);
  });

  it('clears the pin_setup_pending breadcrumb BEFORE committing the PIN (TASK-213 anti-fail-open)', async () => {
    useFastWriter();
    // A restore-in-progress breadcrumb sits in plaintext AsyncStorage (restore
    // sets it BEFORE the PIN). Establishing the PIN must clear it — with confirmed
    // removal, BEFORE the credential commits — so a PIN can never coexist on disk
    // with a live breadcrumb (which a later keystore break could resume over).
    mockPlatform.__kv.set('pin_setup_pending', 'true');

    await AccountSecureStorage.setupPin('123456', 'pin');

    expect(mockPlatform.__kv.has('pin_setup_pending')).toBe(false);
    // The PIN credential is committed and verifies (the clear did not block it).
    expect(await AccountSecureStorage.verifyPin('123456')).toBe(true);
  });

  it('ABORTS setupPin (no PIN committed) when the breadcrumb removal cannot be confirmed', async () => {
    useFastWriter();
    mockPlatform.__kv.set('pin_setup_pending', 'true');
    // Plaintext removal can never be confirmed → clearPinSetupPending returns
    // false → setupPin MUST abort rather than commit a PIN alongside a live marker.
    const originalRemove =
      mockPlatform.storage.removeItem.getMockImplementation();
    mockPlatform.storage.removeItem.mockRejectedValue(new Error('kv wedged'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        AccountSecureStorage.setupPin('123456', 'pin')
      ).rejects.toThrow(/Failed to set up PIN/);
      // No PIN credential was committed (fail-closed): nothing to verify against.
      expect(await AccountSecureStorage.verifyPin('123456')).toBe(false);
    } finally {
      warnSpy.mockRestore();
      // Restore the shared mock impl (clearMocks preserves impls across tests).
      mockPlatform.storage.removeItem.mockImplementation(
        originalRemove ??
          (async (k: string) => {
            mockPlatform.__kv.delete(k);
          })
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('changePin — atomic re-wrap of every account (§5.3)', () => {
  it('re-wraps ALL accounts from OLD→NEW; each new blob verifies; old copies dropped', async () => {
    useFastWriter();
    const a = makeAlgoKey();
    const b = makeAlgoKey();
    await seedV2('acct-a', a.sk, '111111');
    await seedV2('acct-b', b.sk, '111111');
    // Establish the OLD credential (no accounts unwrapped here since they are
    // already v2 — persist the credential directly).
    await asPriv.persistPinCredential({
      hash: asPriv.hashPin('111111', 'a'.repeat(64), PIN_ITERATIONS),
      iterations: PIN_ITERATIONS,
      salt: 'a'.repeat(64),
      secretSource: 'pin',
    });

    await AccountSecureStorage.changePin('111111', '222222');

    // Both accounts now decrypt under the NEW secret, byte-exact, single blob.
    for (const [id, k] of [
      ['acct-a', a],
      ['acct-b', b],
    ] as const) {
      const payload = readPayload(id);
      expect(payload.blobs).toHaveLength(1);
      const newBlob = payload.blobs![0];
      const check = await decryptKeyEnvelopeV2(newBlob, '222222', DEVICE_ID);
      expect(check && hex(check)).toBe(hex(k.sk));
      // And the OLD secret no longer decrypts the surviving blob.
      expect(
        await decryptKeyEnvelopeV2(newBlob, '111111', DEVICE_ID)
      ).toBeNull();
    }
    expect(await AccountSecureStorage.verifyPin('222222')).toBe(true);
    expect(await AccountSecureStorage.verifyPin('111111')).toBe(false);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('changePin crash-injection — verify-before-delete, never strands (§4.4/AC3/AC5)', () => {
  async function setupTwoV2(oldPin: string): Promise<{
    a: ReturnType<typeof makeAlgoKey>;
    b: ReturnType<typeof makeAlgoKey>;
  }> {
    const a = makeAlgoKey();
    const b = makeAlgoKey();
    await seedV2('acct-a', a.sk, oldPin);
    await seedV2('acct-b', b.sk, oldPin);
    await asPriv.persistPinCredential({
      hash: asPriv.hashPin(oldPin, 'a'.repeat(64), PIN_ITERATIONS),
      iterations: PIN_ITERATIONS,
      salt: 'a'.repeat(64),
      secretSource: 'pin',
    });
    return { a, b };
  }

  /** Every account decrypts to its expected sk under `pin` (≥1 readable copy). */
  async function assertReadable(
    pin: string,
    expected: Record<string, ReturnType<typeof makeAlgoKey>>
  ): Promise<void> {
    for (const [id, k] of Object.entries(expected)) {
      const out = await AccountSecureStorage.getPrivateKey(id, pin);
      expect(hex(out)).toBe(hex(k.sk));
    }
  }

  it('after add-blob: a verify failure rolls back the new blobs; OLD copies stay readable', async () => {
    useFastWriter();
    const { a, b } = await setupTwoV2('111111');

    // Verification fails for every account (as if the new blob wrote wrong).
    jest.spyOn(asPriv, 'constantTimeEqualBytes').mockReturnValue(false);

    await expect(
      AccountSecureStorage.changePin('111111', '222222')
    ).rejects.toThrow();

    // Credential unchanged; both accounts still readable under the OLD secret;
    // the unproven new blobs were dropped (single OLD blob remains).
    expect(await AccountSecureStorage.verifyPin('111111')).toBe(true);
    expect(await AccountSecureStorage.verifyPin('222222')).toBe(false);
    await assertReadable('111111', { 'acct-a': a, 'acct-b': b });
    expect(readPayload('acct-a').blobs).toHaveLength(1);
    expect(readPayload('acct-b').blobs).toHaveLength(1);
  }, 20000);

  it('after partial-verify: acct-a verifies, acct-b fails → BOTH roll back, neither stranded', async () => {
    useFastWriter();
    const { a, b } = await setupTwoV2('111111');

    // First verify passes, second fails (partial verify).
    jest
      .spyOn(asPriv, 'constantTimeEqualBytes')
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await expect(
      AccountSecureStorage.changePin('111111', '222222')
    ).rejects.toThrow();

    expect(await AccountSecureStorage.verifyPin('111111')).toBe(true);
    await assertReadable('111111', { 'acct-a': a, 'acct-b': b });
    expect(readPayload('acct-a').blobs).toHaveLength(1);
    expect(readPayload('acct-b').blobs).toHaveLength(1);
  }, 20000);

  it('during add-blob (before commit): a mid-phase write failure rolls back; nothing stranded', async () => {
    useFastWriter();
    const { a, b } = await setupTwoV2('111111');

    // The SECOND account's new-blob encryption throws mid-phase-2. acct-a was
    // already appended (dual-blob); rollback must drop it, leaving acct-a
    // readable under OLD, acct-b never touched.
    const spy = jest.spyOn(asPriv, 'encryptPrivateKeyV2');
    let calls = 0;
    spy.mockImplementation(async (keyBytes, secret, secretSource, options) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('injected add-blob failure');
      }
      return encryptKeyEnvelopeV2({
        plaintext: keyBytes,
        secret,
        secretSource,
        deviceSecret: options.deviceBound ? DEVICE_ID : undefined,
        kdfParams: FAST_PARAMS,
      });
    });

    await expect(
      AccountSecureStorage.changePin('111111', '222222')
    ).rejects.toThrow();

    expect(await AccountSecureStorage.verifyPin('111111')).toBe(true);
    expect(await AccountSecureStorage.verifyPin('222222')).toBe(false);
    await assertReadable('111111', { 'acct-a': a, 'acct-b': b });
    // acct-a rolled back to its single OLD blob; acct-b never appended.
    expect(readPayload('acct-a').blobs).toHaveLength(1);
    expect(readPayload('acct-b').blobs).toHaveLength(1);
  }, 20000);

  it('before commit: a credential-write failure rolls back; OLD credential + copies intact', async () => {
    useFastWriter();
    const { a, b } = await setupTwoV2('111111');

    // The credential commit (phase 4) throws — committed stays false → rollback.
    jest
      .spyOn(asPriv, 'persistPinCredential')
      .mockRejectedValueOnce(new Error('injected commit failure'));

    await expect(
      AccountSecureStorage.changePin('111111', '222222')
    ).rejects.toThrow();

    // OLD credential still verifies; NEW does not; both accounts readable under OLD.
    expect(await AccountSecureStorage.verifyPin('111111')).toBe(true);
    expect(await AccountSecureStorage.verifyPin('222222')).toBe(false);
    await assertReadable('111111', { 'acct-a': a, 'acct-b': b });
  }, 20000);

  it('after commit: a cleanup failure does NOT fail changePin; keys readable under NEW', async () => {
    useFastWriter();
    const { a, b } = await setupTwoV2('111111');

    // The post-commit cleanup (phase 5) throws for every account. The PIN change
    // has already committed, so changePin must STILL resolve and the keys must be
    // readable under the NEW secret (via the proven new blob).
    jest.spyOn(asPriv, 'finalizePayload').mockImplementation(() => {
      throw new Error('injected cleanup failure');
    });

    await expect(
      AccountSecureStorage.changePin('111111', '222222')
    ).resolves.toBeUndefined();

    expect(await AccountSecureStorage.verifyPin('222222')).toBe(true);
    expect(await AccountSecureStorage.verifyPin('111111')).toBe(false);
    await assertReadable('222222', { 'acct-a': a, 'acct-b': b });

    // Cleanup (phase 5) was skipped, so the account still carries BOTH copies:
    // the OLD blob (kept through commit — Codex P2-5) and the proven NEW blob.
    // This proves old readable copies survive until the post-commit cleanup.
    const blobs = readPayload('acct-a').blobs!;
    expect(blobs).toHaveLength(2);
    const oldDecrypts = await decryptKeyEnvelopeV2(
      blobs[0],
      '111111',
      DEVICE_ID
    );
    const newDecrypts = await decryptKeyEnvelopeV2(
      blobs[1],
      '222222',
      DEVICE_ID
    );
    expect(oldDecrypts && hex(oldDecrypts)).toBe(hex(a.sk)); // OLD copy present
    expect(newDecrypts && hex(newDecrypts)).toBe(hex(a.sk)); // NEW copy present
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('deletePin policy (§5.5)', () => {
  it('THROWS on a wallet that holds standard-account keys (v2 blob)', async () => {
    const a = makeAlgoKey();
    await seedV2('acct-a', a.sk, '111111');
    await asPriv.persistPinCredential({
      hash: asPriv.hashPin('111111', 'a'.repeat(64), PIN_ITERATIONS),
      iterations: PIN_ITERATIONS,
      salt: 'a'.repeat(64),
      secretSource: 'pin',
    });

    await expect(AccountSecureStorage.deletePin()).rejects.toThrow(
      /Cannot remove PIN while accounts hold keys/
    );
    // The credential is untouched — the wallet is not left key-bearing-without-PIN.
    expect(await AccountSecureStorage.verifyPin('111111')).toBe(true);
  });

  it('THROWS on a wallet holding a legacy Format-A (device-key) copy', async () => {
    const a = makeAlgoKey();
    seedFormatA('acct-a', a.sk);
    await expect(AccountSecureStorage.deletePin()).rejects.toThrow(
      /Cannot remove PIN/
    );
  });

  it('ALLOWS removing the PIN on a watch-only wallet (no key material)', async () => {
    addToList('acct-watch'); // no secret payload
    await asPriv.persistPinCredential({
      hash: asPriv.hashPin('111111', 'a'.repeat(64), PIN_ITERATIONS),
      iterations: PIN_ITERATIONS,
      salt: 'a'.repeat(64),
      secretSource: 'pin',
    });

    await expect(AccountSecureStorage.deletePin()).resolves.toBeUndefined();
    expect(await AccountSecureStorage.hasPin()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('storeAccount ALWAYS writes Format-A (Codex P1-2)', () => {
  it('writes a device-key (Format A) blob, NEVER v2 — even with a PIN set + vault unlocked', async () => {
    await seedCredential('111111');
    SessionKeyVault.set('111111', 'pin'); // pre-Codex, this would trigger a v2 write
    const k = makeAlgoKey();

    await AccountSecureStorage.storeAccount(
      makeStandardMeta('acct-fa', k),
      k.sk
    );

    const p = readPayload('acct-fa');
    expect(p.blobs).toBeUndefined(); // NO v2 blob without a changePin/setupPin
    expect(p.version).toBeUndefined();
    expect(p.encryptedPrivateKey.split(':')).toHaveLength(4); // 4-colon Format A
    // Device-readable regardless of PIN/vault.
    const out = await AccountSecureStorage.getPrivateKey('acct-fa', '111111');
    expect(hex(out)).toBe(hex(k.sk));
  }, 20000);
});

describe('global key-mutation mutex (P1-B / P1-1a) — writers serialize with rewrap', () => {
  it('a Format-A account stored concurrently with changePin is NOT lost (device-readable, rewrapped on enumerate)', async () => {
    useFastWriter();
    const existing = makeAlgoKey();
    await seedV2('acct-existing', existing.sk, '111111');
    await seedCredential('111111');
    SessionKeyVault.set('111111', 'pin');

    const fresh = makeAlgoKey();
    // Fire BOTH concurrently. The global mutex serializes them: the store (now
    // always Format-A) runs either fully before the change's enumeration (→ it
    // is re-wrapped to v2 under NEW) or fully after the commit (→ it stays
    // Format-A, device-readable). Either way the key is never lost.
    await Promise.all([
      AccountSecureStorage.changePin('111111', '222222'),
      AccountSecureStorage.storeAccount(
        makeStandardMeta('acct-new', fresh),
        fresh.sk
      ),
    ]);

    expect(await AccountSecureStorage.verifyPin('222222')).toBe(true);
    expect(await AccountSecureStorage.verifyPin('111111')).toBe(false);

    // Both accounts readable under the NEW secret (getPrivateKey falls back to
    // the device key for a still-Format-A new account after verifying the PIN).
    expect(
      hex(await AccountSecureStorage.getPrivateKey('acct-existing', '222222'))
    ).toBe(hex(existing.sk));
    expect(
      hex(await AccountSecureStorage.getPrivateKey('acct-new', '222222'))
    ).toBe(hex(fresh.sk));
  }, 20000);

  it('a concurrent deleteAccount + changePin serialize cleanly; remaining account intact', async () => {
    useFastWriter();
    const a = makeAlgoKey();
    const b = makeAlgoKey();
    await seedV2('acct-a', a.sk, '111111');
    await seedV2('acct-b', b.sk, '111111');
    await seedCredential('111111');

    // deleteAccount (a secret writer) must go through the mutex, so it can't
    // interleave with the rewrap enumeration+commit.
    await Promise.all([
      AccountSecureStorage.changePin('111111', '222222'),
      AccountSecureStorage.deleteAccount('acct-b'),
    ]);

    expect(await AccountSecureStorage.verifyPin('222222')).toBe(true);
    // acct-a survived and is readable under NEW; acct-b is gone.
    expect(
      hex(await AccountSecureStorage.getPrivateKey('acct-a', '222222'))
    ).toBe(hex(a.sk));
    expect(mockPlatform.__secure.has(secretKey('acct-b'))).toBe(false);
  }, 20000);

  it('two concurrent changePins do NOT clobber each other (verify-inside-mutex, Codex P1-3)', async () => {
    useFastWriter();
    const a = makeAlgoKey();
    await seedV2('acct-a', a.sk, '111111');
    await seedCredential('111111');

    // Both verify OLD; without verify-inside-mutex both would pass and clobber.
    // With it, the 2nd acquires the lock only AFTER the 1st commits, so its
    // verifyPin against the now-NEW credential fails.
    const [r1, r2] = await Promise.allSettled([
      AccountSecureStorage.changePin('111111', '222222'),
      AccountSecureStorage.changePin('111111', '333333'),
    ]);
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/Current secret is incorrect/),
    });

    // The first changePin (acquires the lock first) wins → 222222.
    expect(await AccountSecureStorage.verifyPin('222222')).toBe(true);
    expect(
      hex(await AccountSecureStorage.getPrivateKey('acct-a', '222222'))
    ).toBe(hex(a.sk));
  }, 20000);

  it('re-read-before-commit catches a clobbered persisted new blob → aborts, no strand (Codex P1-1b)', async () => {
    useFastWriter();
    const a = makeAlgoKey();
    await seedV2('acct-a', a.sk, '111111');
    await seedCredential('111111');

    // Simulate a clobber/torn write: during changePin, every read of the account
    // secret returns the OLD (pre-append) payload, so phase-3's re-read never
    // sees the new blob it just wrote → verification aborts BEFORE the commit.
    const oldRaw = mockPlatform.__secure.get(secretKey('acct-a'))!;
    mockPlatform.secureStorage.getItem.mockImplementation(async (k: string) => {
      if (k === secretKey('acct-a')) return oldRaw;
      return mockPlatform.__secure.has(k)
        ? mockPlatform.__secure.get(k)!
        : null;
    });

    await expect(
      AccountSecureStorage.changePin('111111', '222222')
    ).rejects.toThrow();

    // Restore normal reads and confirm NO strand: OLD credential still verifies,
    // account still readable under OLD.
    mockPlatform.secureStorage.getItem.mockImplementation(async (k: string) =>
      mockPlatform.__secure.has(k) ? mockPlatform.__secure.get(k)! : null
    );
    expect(await AccountSecureStorage.verifyPin('111111')).toBe(true);
    expect(
      hex(await AccountSecureStorage.getPrivateKey('acct-a', '111111'))
    ).toBe(hex(a.sk));
  }, 20000);
});

// NOTE: PR4's "passphrase credential rejected until PR7" guard was REMOVED in
// PR7 — passphrase credentials are now supported end-to-end. That behavior is
// covered by src/services/secure/__tests__/passphrase.test.ts (setupPin +
// verifyPin + changePin PIN↔passphrase + the length-only policy).

// ─────────────────────────────────────────────────────────────────────────────
describe('payload budget enforced on write (§2.4 / PR1 carry-forward)', () => {
  it('writeSecretV2 throws when appending would exceed MAX_KEY_BLOBS (2)', async () => {
    const k = makeAlgoKey();
    const blob1 = await encryptKeyEnvelopeV2({
      plaintext: k.sk,
      secret: '111111',
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    const blob2 = await encryptKeyEnvelopeV2({
      plaintext: k.sk,
      secret: '222222',
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    const blob3 = await encryptKeyEnvelopeV2({
      plaintext: k.sk,
      secret: '333333',
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    // Seed a payload already holding the 2-blob maximum.
    mockPlatform.__secure.set(
      secretKey('acct-full'),
      JSON.stringify({
        accountId: 'acct-full',
        encryptedPrivateKey: '',
        authMethod: 'pin',
        version: 2,
        blobs: [blob1, blob2],
      })
    );

    await expect(
      AccountSecureStorage.writeSecretV2('acct-full', blob3)
    ).rejects.toThrow(/Too many key blobs/);
    // Nothing was persisted over the existing 2-blob payload.
    expect(readPayload('acct-full').blobs).toHaveLength(2);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('changePin verify gate is throttle-aware (§8)', () => {
  it('rejects a wrong current PIN and leaves every account untouched/readable', async () => {
    useFastWriter();
    const a = makeAlgoKey();
    await seedV2('acct-a', a.sk, '111111');
    await asPriv.persistPinCredential({
      hash: asPriv.hashPin('111111', 'a'.repeat(64), PIN_ITERATIONS),
      iterations: PIN_ITERATIONS,
      salt: 'a'.repeat(64),
      secretSource: 'pin',
    });
    const before = mockPlatform.__secure.get(secretKey('acct-a'));

    // Wrong current PIN → verifyPin (throttle-aware) returns false → changePin
    // aborts BEFORE any re-wrap.
    await expect(
      AccountSecureStorage.changePin('999999', '222222')
    ).rejects.toThrow(/Current secret is incorrect/);

    // The secret payload is byte-for-byte unchanged; account still readable OLD.
    expect(mockPlatform.__secure.get(secretKey('acct-a'))).toBe(before);
    const out = await AccountSecureStorage.getPrivateKey('acct-a', '111111');
    expect(hex(out)).toBe(hex(a.sk));
    expect(await AccountSecureStorage.verifyPin('111111')).toBe(true);
  }, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('salt-in-credential (§5.2)', () => {
  it('setupPin folds {hash, iterations, salt, secretSource} into ONE PIN_KEY write', async () => {
    await AccountSecureStorage.setupPin('123456', 'pin');

    const raw = mockPlatform.__secure.get('voi_wallet_pin')!;
    const parsed = JSON.parse(raw);
    expect(typeof parsed.hash).toBe('string');
    expect(parsed.iterations).toBe(PIN_ITERATIONS);
    expect(typeof parsed.salt).toBe('string');
    expect(parsed.salt.length).toBe(64); // 32 bytes hex
    expect(parsed.secretSource).toBe('pin');
    // No standalone SALT_KEY is relied upon.
    expect(mockPlatform.__secure.has('voi_wallet_salt')).toBe(false);
    // The folded salt verifies the PIN.
    expect(await AccountSecureStorage.verifyPin('123456')).toBe(true);
  });

  it('back-compat: an OLD-shape {hash, iterations} + separate SALT_KEY still verifies, then self-heals to folded', async () => {
    const oldSalt = 'b'.repeat(64);
    const oldHash = customPBKDF2('123456', oldSalt, PIN_ITERATIONS, 32);
    // Seed the PRE-Wave-2 shape: no folded salt; salt in the standalone key.
    mockPlatform.__secure.set(
      'voi_wallet_pin',
      JSON.stringify({ hash: oldHash, iterations: PIN_ITERATIONS })
    );
    mockPlatform.__secure.set('voi_wallet_salt', oldSalt);

    // Verifies via the SALT_KEY fallback.
    expect(await AccountSecureStorage.verifyPin('123456')).toBe(true);

    // ...and the credential self-heals to the folded shape (salt now inside).
    const parsed = JSON.parse(mockPlatform.__secure.get('voi_wallet_pin')!);
    expect(parsed.salt).toBe(oldSalt);
    expect(parsed.secretSource).toBe('pin');
    expect(await AccountSecureStorage.verifyPin('123456')).toBe(true);
  });
});
