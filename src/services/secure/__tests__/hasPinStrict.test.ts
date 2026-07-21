// Unit tests for TASK-213: AccountSecureStorage.hasPinStrict().
//
// The STRICT, boot-only PIN-presence probe AuthContext uses to fail CLOSED. It
// MUST distinguish a genuine secure-storage read/decrypt FAILURE (throw /
// propagate) from a genuine ABSENCE (resolve false), and must be a pure read —
// no legacy-migration WRITE, no cache mutation, and it must NEVER coerce a read
// failure to `false` the way the error-swallowing hasPin() does.
//
// SECURITY NOTE: no real PIN/secret material is used; values are opaque markers.

const mockSecure = new Map<string, string>();
const mockKv = new Map<string, string>();
const mockSecureGetItem = jest.fn(async (k: string) =>
  mockSecure.has(k) ? mockSecure.get(k)! : null
);
const mockSecureSetItem = jest.fn(async (k: string, v: string) => {
  mockSecure.set(k, v);
});
const mockKvGetItem = jest.fn(async (k: string) =>
  mockKv.has(k) ? mockKv.get(k)! : null
);
const mockKvRemoveItem = jest.fn(async (k: string) => {
  mockKv.delete(k);
});

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: (k: string) => mockSecureGetItem(k),
      setItem: (k: string, v: string) => mockSecureSetItem(k, v),
      deleteItem: jest.fn(async () => {}),
      getItemWithAuth: (k: string) => mockSecureGetItem(k),
    },
    storage: {
      getItem: (k: string) => mockKvGetItem(k),
      setItem: jest.fn(async () => {}),
      removeItem: (k: string) => mockKvRemoveItem(k),
      multiRemove: jest.fn(async () => {}),
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: { getDeviceId: async () => 'has-pin-strict-test-device' },
  };
});

import { AccountSecureStorage } from '../AccountSecureStorage';

const PIN_KEY = 'voi_wallet_pin';

beforeEach(() => {
  mockSecure.clear();
  mockKv.clear();
  jest.clearAllMocks();
});

describe('hasPinStrict — absence vs failure (TASK-213)', () => {
  it('resolves FALSE for genuine absence (no credential in either location)', async () => {
    await expect(AccountSecureStorage.hasPinStrict()).resolves.toBe(false);
  });

  it('resolves TRUE when a credential is present in secure storage', async () => {
    mockSecure.set(PIN_KEY, JSON.stringify({ hash: 'h', iterations: 100000 }));
    await expect(AccountSecureStorage.hasPinStrict()).resolves.toBe(true);
  });

  it('resolves TRUE when the credential is only in the legacy AsyncStorage location', async () => {
    mockKv.set(PIN_KEY, JSON.stringify({ hash: 'h', iterations: 100000 }));
    await expect(AccountSecureStorage.hasPinStrict()).resolves.toBe(true);
  });

  it('THROWS (fails closed) when the secure-store read FAILS — never coerced to false', async () => {
    mockSecureGetItem.mockImplementationOnce(async () => {
      throw new Error('keychain/keystore unavailable');
    });
    await expect(AccountSecureStorage.hasPinStrict()).rejects.toThrow(
      'keychain/keystore unavailable'
    );
  });

  it('THROWS when the legacy AsyncStorage read FAILS (secure store empty)', async () => {
    mockKvGetItem.mockImplementationOnce(async () => {
      throw new Error('AsyncStorage read failed');
    });
    await expect(AccountSecureStorage.hasPinStrict()).rejects.toThrow(
      'AsyncStorage read failed'
    );
  });

  it('is a PURE read — performs no migration write and no cache mutation', async () => {
    mockKv.set(PIN_KEY, JSON.stringify({ hash: 'h', iterations: 100000 }));
    await AccountSecureStorage.hasPinStrict();
    // Unlike getStoredPinData(), the strict probe must NOT migrate the legacy
    // value into secure storage or delete it.
    expect(mockSecureSetItem).not.toHaveBeenCalled();
    expect(mockKvRemoveItem).not.toHaveBeenCalled();
  });

  it('contrast: the error-swallowing hasPin() still resolves FALSE on the same read failure', async () => {
    // Guards the contract split: hasPin()'s other callers must keep getting a
    // falsy resolve on failure; only hasPinStrict() surfaces the throw.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSecureGetItem.mockImplementation(async () => {
      throw new Error('keychain unavailable');
    });
    // Legacy AsyncStorage read also fails, so getStoredPinData cannot fall back.
    mockKvGetItem.mockImplementation(async () => {
      throw new Error('AsyncStorage unavailable');
    });
    await expect(AccountSecureStorage.hasPin()).resolves.toBe(false);
    warnSpy.mockRestore();
  });
});
