// Unit tests for the biometric-convenience item + the rewritten getPrivateKey
// biometric branch (DOC-137 §3, PR6):
//   - setBiometricSecret writes `{secret, secretSource}` via setItemWithAuth
//     (auth-gated), NOT plain setItem;
//   - getBiometricSecret round-trips it, and returns null (safe) when absent or
//     structurally corrupt;
//   - getPrivateKey's biometric branch reads the KEY ENVELOPE with PLAIN getItem
//     (never getItemWithAuth) and Format-A still decrypts;
//   - clearAll drops the convenience item.
//
// SECURITY NOTE: synthetic byte patterns / throwaway strings stand in for key
// material and secrets. No real mnemonic/key is used, and none is logged.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const authGatedKeys = new Set<string>();
  return {
    __secure: secure,
    __kv: kv,
    __authGatedKeys: authGatedKeys,
    __reset: () => {
      secure.clear();
      kv.clear();
      authGatedKeys.clear();
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
        authGatedKeys.add(k);
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
      getDeviceId: async () => 'bio-conv-test-device-idfv',
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

const DEVICE_ID = 'bio-conv-test-device-idfv';
const BIOMETRIC_SECRET_KEY = 'voi_biometric_secret';
const BIOMETRIC_ENABLED_KEY = 'voi_biometric_enabled';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __authGatedKeys: Set<string>;
  __reset: () => void;
  secureStorage: {
    getItem: jest.Mock;
    setItem: jest.Mock;
    getItemWithAuth: jest.Mock;
    setItemWithAuth: jest.Mock;
    deleteItem: jest.Mock;
  };
};

function fakeKey(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 17 + 3) & 0xff);
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

function seedSecret(accountId: string, payload: object): void {
  mockPlatform.__secure.set(
    `voi_account_secret_${accountId}`,
    JSON.stringify(payload)
  );
}

beforeEach(() => {
  mockPlatform.__reset();
  AccountSecureStorage.clearPrivateKeyCache();
  SessionKeyVault.clear();
});

afterEach(() => {
  SessionKeyVault.clear();
  jest.restoreAllMocks();
});

describe('setBiometricSecret (DOC-137 §3.2/§3.3)', () => {
  it('writes {secret, secretSource} via setItemWithAuth (auth-gated), NOT plain setItem', async () => {
    await AccountSecureStorage.setBiometricSecret(
      '123456',
      'pin',
      'Enable biometric unlock'
    );

    // Went through the WRITE-TIME auth gate, not plain setItem.
    expect(mockPlatform.secureStorage.setItemWithAuth).toHaveBeenCalledTimes(1);
    const [key, value, options] =
      mockPlatform.secureStorage.setItemWithAuth.mock.calls[0];
    expect(key).toBe(BIOMETRIC_SECRET_KEY);
    expect(options).toEqual({ prompt: 'Enable biometric unlock' });
    expect(JSON.parse(value)).toEqual({
      secret: '123456',
      secretSource: 'pin',
    });
    expect(mockPlatform.__authGatedKeys.has(BIOMETRIC_SECRET_KEY)).toBe(true);

    // The convenience item is the ONLY key written via setItemWithAuth.
    expect(mockPlatform.secureStorage.setItem).not.toHaveBeenCalledWith(
      BIOMETRIC_SECRET_KEY,
      expect.anything()
    );
  });

  it('round-trips through getBiometricSecret', async () => {
    await AccountSecureStorage.setBiometricSecret(
      'correct horse',
      'passphrase',
      'Unlock'
    );
    const out = await AccountSecureStorage.getBiometricSecret('Unlock');
    expect(out).toEqual({
      secret: 'correct horse',
      secretSource: 'passphrase',
    });
  });
});

describe('getBiometricSecret null-safety (DOC-137 §3.4)', () => {
  it('returns null when the item is absent/invalidated (no throw)', async () => {
    const out = await AccountSecureStorage.getBiometricSecret('Unlock');
    expect(out).toBeNull();
  });

  it('returns null (not a throw) on a structurally corrupt item', async () => {
    mockPlatform.__secure.set(BIOMETRIC_SECRET_KEY, 'not json{');
    const out = await AccountSecureStorage.getBiometricSecret('Unlock');
    expect(out).toBeNull();
  });

  it('returns null when the shape is wrong (missing secretSource)', async () => {
    mockPlatform.__secure.set(
      BIOMETRIC_SECRET_KEY,
      JSON.stringify({ secret: '123456' })
    );
    const out = await AccountSecureStorage.getBiometricSecret('Unlock');
    expect(out).toBeNull();
  });
});

describe('getPrivateKey biometric branch reads the ENVELOPE with plain getItem (DOC-137 §3.3, PR6)', () => {
  it('Format-A decrypts with pin=undefined + biometric enabled, and getItemWithAuth is NEVER used on the envelope', async () => {
    const sk = fakeKey(64);
    const accountId = 'acct-bio-formatA';
    seedSecret(accountId, {
      accountId,
      encryptedPrivateKey: makeFormatA(sk),
      authMethod: 'biometric',
    });
    // Biometric is enabled (the classic pin=undefined + biometric reader path).
    mockPlatform.__kv.set(BIOMETRIC_ENABLED_KEY, 'true');

    const out = await AccountSecureStorage.getPrivateKey(accountId);
    expect(hex(out)).toBe(hex(sk));

    // The KEY ENVELOPE was read with PLAIN getItem — the write-time-ACL bug fix.
    expect(mockPlatform.secureStorage.getItem).toHaveBeenCalledWith(
      `voi_account_secret_${accountId}`
    );
    // getItemWithAuth was NEVER called on the envelope (nor at all in this read).
    expect(mockPlatform.secureStorage.getItemWithAuth).not.toHaveBeenCalledWith(
      `voi_account_secret_${accountId}`,
      expect.anything()
    );
    expect(mockPlatform.secureStorage.getItemWithAuth).not.toHaveBeenCalled();
  });
});

describe('clearAll drops the biometric-convenience item', () => {
  it('deletes voi_biometric_secret on a full wipe', async () => {
    await AccountSecureStorage.setBiometricSecret('123456', 'pin', 'x');
    expect(mockPlatform.__secure.has(BIOMETRIC_SECRET_KEY)).toBe(true);

    await AccountSecureStorage.clearAll();

    expect(mockPlatform.secureStorage.deleteItem).toHaveBeenCalledWith(
      BIOMETRIC_SECRET_KEY
    );
    expect(mockPlatform.__secure.has(BIOMETRIC_SECRET_KEY)).toBe(false);
  });
});

describe('changePin resyncs the biometric-convenience item + vault (Codex P2)', () => {
  it('refreshes the convenience item to the NEW secret when biometrics enabled', async () => {
    jest
      .spyOn(AccountSecureStorage, 'verifyPin')
      .mockResolvedValue(true as unknown as boolean);
    mockPlatform.__kv.set(BIOMETRIC_ENABLED_KEY, 'true');
    // Old convenience item wrapped the OLD PIN.
    await AccountSecureStorage.setBiometricSecret('111111', 'pin', 'x');

    await AccountSecureStorage.changePin('111111', '222222');

    // The convenience item now yields the NEW secret — so a later biometric
    // unlock loads the new PIN into the vault (required once PR4 v2 keys are
    // wrapped under the new PIN).
    const out = await AccountSecureStorage.getBiometricSecret('x');
    expect(out).toEqual({ secret: '222222', secretSource: 'pin' });
    // It went back through the write-time auth gate.
    expect(mockPlatform.secureStorage.setItemWithAuth).toHaveBeenCalledWith(
      BIOMETRIC_SECRET_KEY,
      JSON.stringify({ secret: '222222', secretSource: 'pin' }),
      { prompt: 'Update biometric unlock' }
    );
    // Biometrics stays enabled.
    expect(mockPlatform.__kv.get(BIOMETRIC_ENABLED_KEY)).toBe('true');
  });

  it('DISABLES biometrics (clears item + flag) when the refresh write fails — no stale secret', async () => {
    jest
      .spyOn(AccountSecureStorage, 'verifyPin')
      .mockResolvedValue(true as unknown as boolean);
    mockPlatform.__kv.set(BIOMETRIC_ENABLED_KEY, 'true');
    await AccountSecureStorage.setBiometricSecret('111111', 'pin', 'x');

    // The changePin refresh write (the NEXT setItemWithAuth call) fails/cancels.
    mockPlatform.secureStorage.setItemWithAuth.mockImplementationOnce(
      async () => {
        throw new Error('write-time biometric prompt cancelled');
      }
    );

    // changePin itself still succeeds (the refresh never throws upward).
    await expect(
      AccountSecureStorage.changePin('111111', '222222')
    ).resolves.toBeUndefined();

    // No stale OLD-secret item survives, and biometrics is disabled.
    expect(mockPlatform.__secure.has(BIOMETRIC_SECRET_KEY)).toBe(false);
    expect(mockPlatform.__kv.get(BIOMETRIC_ENABLED_KEY)).toBe('false');
    expect(await AccountSecureStorage.getBiometricSecret('x')).toBeNull();
  });

  it('no-ops when there is NO convenience item (item read returns null)', async () => {
    jest
      .spyOn(AccountSecureStorage, 'verifyPin')
      .mockResolvedValue(true as unknown as boolean);
    // Gate is the ITEM, not the flag: with no item present, getBiometricSecret
    // returns null and the refresh is a no-op — nothing stale to handle.
    mockPlatform.secureStorage.setItemWithAuth.mockClear();
    mockPlatform.secureStorage.deleteItem.mockClear();

    await AccountSecureStorage.changePin('111111', '222222');

    expect(mockPlatform.secureStorage.setItemWithAuth).not.toHaveBeenCalled();
    expect(mockPlatform.secureStorage.deleteItem).not.toHaveBeenCalledWith(
      BIOMETRIC_SECRET_KEY
    );
    expect(await AccountSecureStorage.getBiometricSecret('x')).toBeNull();
  });

  it('FAIL-SAFE: item-read failure during changePin clears the item + disables biometrics — no stale secret survives, changePin still resolves', async () => {
    jest
      .spyOn(AccountSecureStorage, 'verifyPin')
      .mockResolvedValue(true as unknown as boolean);
    mockPlatform.__kv.set(BIOMETRIC_ENABLED_KEY, 'true');
    // A stale OLD-secret item is present...
    await AccountSecureStorage.setBiometricSecret('111111', 'pin', 'x');

    // ...but the item read (getItemWithAuth) throws during changePin — the gate
    // cannot be determined. Fail-safe MUST clear it rather than skip.
    mockPlatform.secureStorage.getItemWithAuth.mockImplementationOnce(
      async () => {
        throw new Error('flaky keychain read');
      }
    );

    await expect(
      AccountSecureStorage.changePin('111111', '222222')
    ).resolves.toBeUndefined();

    // No stale OLD-secret item survives even though the read failed.
    expect(mockPlatform.secureStorage.deleteItem).toHaveBeenCalledWith(
      BIOMETRIC_SECRET_KEY
    );
    expect(mockPlatform.__secure.has(BIOMETRIC_SECRET_KEY)).toBe(false);
    expect(mockPlatform.__kv.get(BIOMETRIC_ENABLED_KEY)).toBe('false');
  });

  it('rotates the SessionKeyVault to the new secret when the session is unlocked', async () => {
    jest
      .spyOn(AccountSecureStorage, 'verifyPin')
      .mockResolvedValue(true as unknown as boolean);
    // Simulate a live, unlocked session holding the OLD secret.
    SessionKeyVault.set('111111', 'pin');
    const rotateSpy = jest.spyOn(SessionKeyVault, 'rotate');

    await AccountSecureStorage.changePin('111111', '222222');

    expect(rotateSpy).toHaveBeenCalledWith('222222', 'pin');
    // The live session now holds the new secret WITHOUT re-locking.
    expect(SessionKeyVault.isUnlocked()).toBe(true);
    expect(SessionKeyVault.getSecret()).toBe('222222');
  });

  it('does NOT rotate the vault when the session is locked', async () => {
    jest
      .spyOn(AccountSecureStorage, 'verifyPin')
      .mockResolvedValue(true as unknown as boolean);
    expect(SessionKeyVault.isUnlocked()).toBe(false);
    const rotateSpy = jest.spyOn(SessionKeyVault, 'rotate');

    await AccountSecureStorage.changePin('111111', '222222');

    expect(rotateSpy).not.toHaveBeenCalled();
    expect(SessionKeyVault.isUnlocked()).toBe(false);
  });
});
