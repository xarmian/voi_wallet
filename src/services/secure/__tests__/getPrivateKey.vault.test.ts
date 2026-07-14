// Unit tests proving PR3 introduces NO behavior change to Format-A decryption
// (DOC-137 §6.4). The SessionKeyVault is populated at unlock by AuthContext, but
// getPrivateKey must decrypt existing device-key (Format A) payloads EXACTLY as
// before whether the vault is empty (locked) or unlocked — because Format-A
// payloads carry no `blobs` and therefore never enter the vault-aware v2 branch.
//
// SECURITY NOTE: synthetic byte patterns stand in for key material; secrets are
// throwaway test strings. No real mnemonic/key is used.

// In-memory platform mock (SecureStore/AsyncStorage/deviceId/crypto). Node backs
// getRandomBytes/sha256 so the REAL device-key crypto path runs end-to-end.
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
      getDeviceId: async () => 'vault-test-device-idfv',
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
import { SessionKeyVault, VaultLockedError } from '../SessionKeyVault';
import { encryptKeyEnvelopeV2 } from '../envelopeV2';
import type { ScryptKdfParams } from '../../backup/types';

const DEVICE_ID = 'vault-test-device-idfv';
const PIN = '123456';
// Small (power-of-two, within caps) scrypt params keep the suite fast.
const FAST_PARAMS: ScryptKdfParams = { N: 2 ** 12, r: 8, p: 1, dkLen: 32 };

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __reset: () => void;
};

function fakeKey(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 13 + 7) & 0xff);
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
    hasher: CryptoJS.algo.SHA256,
  });
  return derived.toString(CryptoJS.enc.Hex);
}

/** Build a legacy Format-A (device-key) 4-colon blob (as encryptPrivateKey does). */
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
  SessionKeyVault.clear(); // ensure an EMPTY (locked) vault
});

afterEach(() => {
  SessionKeyVault.clear();
  jest.restoreAllMocks();
});

describe('getPrivateKey — Format A is unchanged with an EMPTY vault', () => {
  it('decrypts a Format-A blob via the device key (pin supplied) and does NOT touch the vault', async () => {
    jest
      .spyOn(AccountSecureStorage, 'verifyPin')
      .mockResolvedValue(true as unknown as boolean);

    const sk = fakeKey(64);
    const accountId = 'acct-formatA-emptyvault';
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: makeFormatA(sk),
      authMethod: 'pin',
    });

    expect(SessionKeyVault.isUnlocked()).toBe(false);
    const out = await AccountSecureStorage.getPrivateKey(accountId, PIN);
    expect(hex(out)).toBe(hex(sk));

    // getPrivateKey is a pure reader: it never populates the vault.
    expect(SessionKeyVault.isUnlocked()).toBe(false);
  });

  it('decrypts a Format-A blob with pin=undefined + empty vault (no PIN set) — no throw', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-formatA-nopin';
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: makeFormatA(sk),
      authMethod: 'pin',
    });

    // No PIN, no biometric, empty vault: the device-key path succeeds exactly as
    // before (the classic pin=undefined caller scenario).
    const out = await AccountSecureStorage.getPrivateKey(accountId);
    expect(hex(out)).toBe(hex(sk));
  });
});

describe('getPrivateKey — Format A is unchanged with an UNLOCKED vault (v2 branch inert)', () => {
  it('an unlocked vault does not change Format-A decryption (no blobs => device key)', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-formatA-vaultunlocked';
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: makeFormatA(sk),
      authMethod: 'pin',
    });

    // Populate the vault (as AuthContext would at unlock). The Format-A payload
    // carries no `blobs`, so the vault-aware v2 branch is skipped and decryption
    // still flows through the device-key path.
    SessionKeyVault.set(PIN, 'pin');

    const out = await AccountSecureStorage.getPrivateKey(accountId);
    expect(hex(out)).toBe(hex(sk));
  });
});

describe('getPrivateKey — v2 vault path derives via SessionKeyVault.getWrapKey (Codex P1-1)', () => {
  it('decrypts a v2 blob via the memoized getWrapKey when pin=undefined + vault unlocked', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-v2-vaultpath';
    const blob = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: PIN,
      secretSource: 'pin',
      kdfParams: FAST_PARAMS, // non-device-bound
    });
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: '',
      authMethod: 'pin',
      version: 2,
      blobs: [blob],
    });

    SessionKeyVault.set(PIN, 'pin');
    const getWrapKeySpy = jest.spyOn(SessionKeyVault, 'getWrapKey');

    const out = await AccountSecureStorage.getPrivateKey(accountId);
    expect(hex(out)).toBe(hex(sk));

    // The derivation went through the vault (not decryptKeyEnvelopeV2's own
    // scrypt): getWrapKey was the derivation path, keyed by (accountId, salt).
    expect(getWrapKeySpy).toHaveBeenCalledWith(
      accountId,
      blob.salt,
      expect.objectContaining({ deviceSecret: undefined })
    );
  });

  it('passes the device id to getWrapKey for a device-bound v2 blob', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-v2-vaultpath-devicebound';
    const blob = await encryptKeyEnvelopeV2({
      plaintext: sk,
      secret: PIN,
      secretSource: 'pin',
      deviceSecret: DEVICE_ID,
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

    SessionKeyVault.set(PIN, 'pin');
    const getWrapKeySpy = jest.spyOn(SessionKeyVault, 'getWrapKey');

    const out = await AccountSecureStorage.getPrivateKey(accountId);
    expect(hex(out)).toBe(hex(sk));
    expect(getWrapKeySpy).toHaveBeenCalledWith(
      accountId,
      blob.salt,
      expect.objectContaining({ deviceSecret: DEVICE_ID })
    );
  });
});

describe('getPrivateKey — v2 vault path aborts on a mid-flight lock (Codex P1-D)', () => {
  it('throws VaultLockedError (and caches nothing) when the vault epoch changes mid-decrypt', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-v2-abort';
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

    SessionKeyVault.set(PIN, 'pin');

    // Simulate a lock landing DURING the first await inside tryDecryptV2Blobs
    // (the device-id read): clearing the vault bumps the epoch, so the post-await
    // re-check must abort before any key material is derived, returned, or cached.
    jest
      .spyOn(
        AccountSecureStorage as unknown as {
          getStableDeviceId: () => Promise<string>;
        },
        'getStableDeviceId'
      )
      .mockImplementation(async () => {
        SessionKeyVault.clear();
        return DEVICE_ID;
      });

    await expect(
      AccountSecureStorage.getPrivateKey(accountId)
    ).rejects.toBeInstanceOf(VaultLockedError);

    // The lock took effect and nothing lingers unlocked.
    expect(SessionKeyVault.isUnlocked()).toBe(false);
  });

  it('throws VaultLockedError when the lock lands during the updateLastAccessed await (final await guard)', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-v2-abort-lastaccessed';
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

    SessionKeyVault.set(PIN, 'pin');

    // The v2 unwrap SUCCEEDS; the lock lands during the LAST await
    // (updateLastAccessed), after which the key must NOT be cached or returned.
    jest
      .spyOn(
        AccountSecureStorage as unknown as {
          updateLastAccessed: (id: string) => Promise<void>;
        },
        'updateLastAccessed'
      )
      .mockImplementation(async () => {
        SessionKeyVault.clear();
      });

    await expect(
      AccountSecureStorage.getPrivateKey(accountId)
    ).rejects.toBeInstanceOf(VaultLockedError);

    // The read aborted before caching: re-reading (still locked) fails rather
    // than returning a stale cached key.
    await expect(
      AccountSecureStorage.getPrivateKey(accountId)
    ).rejects.toBeTruthy();
  });
});
