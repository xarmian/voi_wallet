// TASK-455 — a failed PIN-credential read never reads as "no PIN". hasPin() and
// getCredentialSource() used to swallow a read failure to false / null, and
// every caller treated that as "no credential":
//
//   P1  getPrivateKey (vault locked): no PIN → AMBIENT read, which device-decrypts
//       a Format-A key with no auth at all;
//   P7  ChangePinScreen: null → initial setup, skipping the current-PIN step.
//
// These run the REAL AccountSecureStorage over an in-memory platform whose PIN
// read can be made to fail. Against the swallowing code each one fails.
//
// SECURITY NOTE: synthetic byte patterns stand in for key material; nothing
// real is used or logged.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const failing = new Set<string>();
  const read = (k: string) =>
    failing.has(k)
      ? Promise.reject(new Error('keychain unavailable'))
      : Promise.resolve(secure.has(k) ? secure.get(k)! : null);
  return {
    __secure: secure,
    __failing: failing,
    __reset: () => {
      secure.clear();
      kv.clear();
      failing.clear();
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: read,
      setItem: async (k: string, v: string) => {
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        secure.delete(k);
      },
      getItemWithAuth: read,
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
      getDeviceId: async () => 'task455-test-device',
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
import { SessionKeyVault } from '../SessionKeyVault';

const DEVICE_ID = 'task455-test-device';
const PIN_KEY = 'voi_wallet_pin';
const CREDENTIAL = JSON.stringify({
  hash: 'ab'.repeat(32),
  iterations: 8000,
  secretSource: 'passphrase',
});

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __failing: Set<string>;
  __reset: () => void;
};

const fakeKey = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 13 + 7) & 0xff);

/** A legacy Format-A (device-key) blob, as encryptPrivateKey writes it. */
function makeFormatA(privateKey: Uint8Array): string {
  const saltHex = randomBytes(32).toString('hex');
  const ivHex = randomBytes(16).toString('hex');
  const baseEntropy = createHash('sha256')
    .update(`voi_wallet_${DEVICE_ID}`)
    .digest('hex');
  const keyMaterial = CryptoJS.PBKDF2(
    baseEntropy,
    CryptoJS.enc.Hex.parse(saltHex),
    { keySize: 32 / 4, iterations: 10000, hasher: CryptoJS.algo.SHA256 }
  ).toString(CryptoJS.enc.Hex);
  const ct = CryptoJS.AES.encrypt(
    Buffer.from(privateKey).toString('hex'),
    CryptoJS.enc.Hex.parse(keyMaterial),
    {
      iv: CryptoJS.enc.Hex.parse(ivHex),
      mode: CryptoJS.mode.CTR,
      padding: CryptoJS.pad.NoPadding,
    }
  ).toString();
  const hmacKey = CryptoJS.SHA256(keyMaterial + 'hmac_salt').toString();
  const hmac = CryptoJS.HmacSHA256(ct, hmacKey).toString();
  return `${saltHex}:${ivHex}:${ct}:${hmac}`;
}

beforeEach(() => {
  mockPlatform.__reset();
  AccountSecureStorage.clearPrivateKeyCache();
  SessionKeyVault.clear(); // a LOCKED vault
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  SessionKeyVault.clear();
  jest.restoreAllMocks();
});

describe('TASK-455 P1: getPrivateKey with a locked vault', () => {
  it('a failed PIN read refuses the ambient read; no key is returned', async () => {
    const accountId = 'acct-p1';
    mockPlatform.__secure.set(PIN_KEY, CREDENTIAL);
    mockPlatform.__secure.set(
      `voi_account_secret_${accountId}`,
      JSON.stringify({
        accountId,
        encryptedPrivateKey: makeFormatA(fakeKey(64)),
        authMethod: 'pin',
      })
    );
    mockPlatform.__failing.add(PIN_KEY);

    await expect(AccountSecureStorage.getPrivateKey(accountId)).rejects.toThrow(
      'keychain unavailable'
    );
  });
});

describe('TASK-455 P7: getCredentialSource', () => {
  it('a failed read rejects instead of reading as "no credential"', async () => {
    mockPlatform.__secure.set(PIN_KEY, CREDENTIAL);
    mockPlatform.__failing.add(PIN_KEY);
    await expect(AccountSecureStorage.getCredentialSource()).rejects.toThrow(
      'keychain unavailable'
    );
  });

  it('genuine absence is still null, and a stored credential reports its kind', async () => {
    await expect(AccountSecureStorage.getCredentialSource()).resolves.toBe(
      null
    );
    mockPlatform.__secure.set(PIN_KEY, CREDENTIAL);
    await expect(AccountSecureStorage.getCredentialSource()).resolves.toBe(
      'passphrase'
    );
  });
});
