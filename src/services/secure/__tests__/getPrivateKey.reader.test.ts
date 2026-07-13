// Unit tests for the extended getPrivateKey trial-decrypt reader (DOC-137 §4.3,
// PR1). Proves the reader:
//   - reads a NEW v2 blob (candidate 1) when a verified secret is available,
//   - still reads a legacy Format-A (device-key) blob EXACTLY as before,
//   - falls through v2 -> Format A when the v2 secret does not match,
//   - fails cleanly on a v2-only payload with the wrong secret.
//
// This is the NO-BEHAVIOR-CHANGE guarantee for existing data: payloads without
// `blobs` never enter the v2 branch.
//
// SECURITY NOTE: synthetic byte patterns stand in for key material; secrets are
// throwaway test strings. No real mnemonic/key is used.

// In-memory platform mock (SecureStore/AsyncStorage/deviceId/crypto). getRandomBytes
// and sha256 are backed by Node so the real device-key + envelope crypto runs.
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
      getItem: async (k: string) => (secure.has(k) ? secure.get(k)! : null),
      setItem: async (k: string, v: string) => {
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      setItem: async (k: string, v: string) => {
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        kv.delete(k);
      },
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: {
      getDeviceId: async () => 'reader-test-device-idfv',
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
import * as platform from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { AccountStorageError } from '../../../types/wallet';
import { encryptKeyEnvelopeV2, KeyEnvelopeV2 } from '../envelopeV2';
import type { ScryptKdfParams } from '../../backup/types';

const DEVICE_ID = 'reader-test-device-idfv';
const PIN = '123456';
const FAST_PARAMS: ScryptKdfParams = { N: 2 ** 12, r: 8, p: 1, dkLen: 32 };

// Access the in-memory mock stores/reset.
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __reset: () => void;
};

function fakeKey(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 11 + 5) & 0xff);
}

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
    hasher: (CryptoJS.algo as unknown as { SHA256: object }).SHA256,
  });
  return derived.toString(CryptoJS.enc.Hex);
}

/**
 * Build a legacy Format-A (device-key) 4-colon blob EXACTLY the way
 * `AccountSecureStorage.encryptPrivateKey` does, so the reader path under test
 * is the real one.
 */
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

function seedSecret(accountId: string, payload: object): void {
  mockPlatform.__secure.set(
    `voi_account_secret_${accountId}`,
    JSON.stringify(payload)
  );
}

beforeEach(() => {
  mockPlatform.__reset();
  AccountSecureStorage.clearPrivateKeyCache();
  // The reader gates the v2 candidate on a *verified* secret. verifyPin is
  // exercised elsewhere (backup/throttle tests); here we stub it true so we can
  // focus on the trial-decrypt ladder with an arbitrary supplied secret.
  jest
    .spyOn(AccountSecureStorage, 'verifyPin')
    .mockResolvedValue(true as unknown as boolean);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getPrivateKey trial-decrypt reader (PR1)', () => {
  it('reads a legacy Format-A (device-key) blob unchanged — no blobs present', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-legacy-a';
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: makeFormatA(sk),
      authMethod: 'pin',
    });

    const out = await AccountSecureStorage.getPrivateKey(accountId, PIN);
    expect(hex(out)).toBe(hex(sk));
  });

  it('reads a v2 blob (candidate 1) when a verified secret is supplied', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-v2';
    const blob = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: PIN,
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: '', // fully migrated
      authMethod: 'pin',
      version: 2,
      blobs: [blob],
    });

    const out = await AccountSecureStorage.getPrivateKey(accountId, PIN);
    expect(hex(out)).toBe(hex(sk));
  });

  it('reads a device-bound v2 blob using the stable device id', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-v2-devicebound';
    const blob = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: PIN,
      secretSource: 'pin',
      deviceSecret: DEVICE_ID, // reader supplies the same via getStableDeviceId()
      kdfParams: FAST_PARAMS,
    });
    expect(blob.deviceBound).toBe(true);
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: '',
      authMethod: 'pin',
      version: 2,
      blobs: [blob],
    });

    const out = await AccountSecureStorage.getPrivateKey(accountId, PIN);
    expect(hex(out)).toBe(hex(sk));
  });

  it('falls through v2 -> Format A when the v2 secret does not match (dual-slot)', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-mixed';
    const wrongBlob = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: 'aaaaaa', // blob wrapped under a DIFFERENT secret
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    seedSecret(accountId, {
      accountId,
      // Old copy still present (device-key Format A of the same key).
      encryptedPrivateKey: makeFormatA(sk),
      authMethod: 'pin',
      version: 2,
      blobs: [wrongBlob],
    });

    // v2 blob fails to MAC-verify under this secret -> ladder falls through to
    // the device-key Format A, which is pin-independent -> success.
    const out = await AccountSecureStorage.getPrivateKey(accountId, 'bbbbbb');
    expect(hex(out)).toBe(hex(sk));
  });

  it('fails on a v2-only payload when the secret is wrong (nothing to fall to)', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-v2-wrong';
    const blob = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: PIN,
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: '',
      authMethod: 'pin',
      version: 2,
      blobs: [blob],
    });

    await expect(
      AccountSecureStorage.getPrivateKey(accountId, '000000')
    ).rejects.toBeInstanceOf(AccountStorageError);
  });

  it('caps v2 attempts at MAX_KEY_BLOBS (extra blobs are not tried)', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-cap';
    // Two non-matching blobs first, then the correct one 3rd — which must NOT be
    // reached because the reader only attempts the first MAX_KEY_BLOBS (=2).
    const decoy = (): Promise<KeyEnvelopeV2> =>
      encryptKeyEnvelopeV2({
        plaintext: fakeKey(64),
        secret: 'zzzzzz',
        secretSource: 'pin',
        kdfParams: FAST_PARAMS,
      });
    const correct = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: PIN,
      secretSource: 'pin',
      kdfParams: FAST_PARAMS,
    });
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: '',
      authMethod: 'pin',
      version: 2,
      blobs: [await decoy(), await decoy(), correct],
    });

    await expect(
      AccountSecureStorage.getPrivateKey(accountId, PIN)
    ).rejects.toBeInstanceOf(AccountStorageError);
  });
});
