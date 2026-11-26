/**
 * TASK-469: wipeWalletData records the request first, clears it last, only when
 * everything is complete, and every partial state it can leave is finished by a
 * retry (the boot calls the same function when the marker is found).
 */
const mockSecureValues = new Map<string, string>();
const mockPlainValues = new Map<string, string>();
const mockEvents: string[] = [];
let mockHoldNext = false;
let mockHeldWrite: { key: string; land: () => void } | undefined;
let mockMarkerSetFailure = false;
let mockMarkerRemoveFailure = false;
let mockMarkerRemoveHang = false;
let mockHeldMarkerRemove: (() => void) | undefined;
let mockLegacyDeleteFailure = false;
let mockWalletsFailure = false;
let mockWalletsHang = false;
let mockBlobStillThere = false;
let mockBlobVerifyFailure = false;
let mockNonceCounter = 0;

jest.mock('@/platform', () => ({
  crypto: {
    getRandomBytes: async (n: number) =>
      Uint8Array.from({ length: n }, () => ++mockNonceCounter % 256),
    sha256: async () => 'test',
    randomUUID: () => 'test-id',
  },
  secureStorage: {
    getItem: jest.fn(async (key: string) => mockSecureValues.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      if (mockHoldNext) {
        mockHoldNext = false;
        return new Promise<void>((resolve) => {
          mockHeldWrite = {
            key,
            land: () => {
              mockSecureValues.set(key, value);
              resolve();
            },
          };
        });
      }
      mockSecureValues.set(key, value);
      return Promise.resolve();
    }),
    deleteItem: jest.fn(async (key: string) => {
      if (key === 'voi_wallet_metadata' && mockLegacyDeleteFailure)
        throw new Error('legacy delete failed');
      mockEvents.push(`secure-delete:${key}`);
      mockSecureValues.delete(key);
    }),
  },
  storage: {
    getItem: jest.fn(async (key: string) => mockPlainValues.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      if (key === 'voi_wipe_intent' && mockMarkerSetFailure)
        throw new Error('marker write failed');
      mockEvents.push(`set:${key}`);
      mockPlainValues.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      if (key === 'voi_wipe_intent' && mockMarkerRemoveFailure)
        throw new Error('marker remove failed');
      if (key === 'voi_wipe_intent' && mockMarkerRemoveHang)
        return new Promise<void>((resolve) => {
          mockHeldMarkerRemove = () => {
            mockPlainValues.delete(key);
            resolve();
          };
        });
      mockEvents.push(`remove:${key}`);
      mockPlainValues.delete(key);
    }),
    multiRemove: jest.fn(async (keys: string[]) => {
      keys.forEach((key) => mockPlainValues.delete(key));
    }),
  },
  biometrics: {},
  deviceId: {},
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    clearAllWallets: jest.fn(async () => {
      mockEvents.push('wallet-blob');
      if (mockWalletsHang) return new Promise<void>(() => {});
      if (mockWalletsFailure) throw new Error('wallet clear failed');
      mockPlainValues.delete('voi_wallet_metadata');
    }),
    hasWalletWithAccountsStrict: jest.fn(async () => {
      if (mockBlobVerifyFailure) throw new Error('verify read failed');
      return mockBlobStillThere;
    }),
  },
}));

import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { WipeIncompleteError } from '@/types/wallet';
import { UNKNOWN_WRITES_STORAGE_KEY } from '@/services/secure/boundedWrites';
import {
  wipeWalletData,
  isWipeInFlight,
  WALLET_BLOB_NAME,
  LEGACY_WALLET_BLOB_NAME,
  LEGACY_WALLET_SECURE_KEY,
  BLOB_STEP_TIMEOUT_MS,
} from '../index';

const MARKER = 'voi_wipe_intent';
const service = AccountSecureStorage as unknown as {
  PIN_KEY: string;
  SALT_KEY: string;
  METADATA_LIST_KEY: string;
  boundedSecureSet(
    key: string,
    value: string,
    verifier: 'presence'
  ): Promise<void>;
};
const secretKey = (id: string) => `voi_account_secret_${id}`;

const seedWallet = (ids: string[]) => {
  mockPlainValues.set(service.METADATA_LIST_KEY, JSON.stringify(ids));
  mockPlainValues.set('voi_wallet_metadata', '{"accounts":[]}');
  mockPlainValues.set(service.PIN_KEY, 'pin');
  mockSecureValues.set(service.PIN_KEY, 'pin');
  mockSecureValues.set(service.SALT_KEY, 'salt');
  for (const id of ids) mockSecureValues.set(secretKey(id), `secret-${id}`);
};
const expectEverythingGone = (ids: string[]) => {
  expect(mockPlainValues.has(MARKER)).toBe(false);
  expect(mockPlainValues.has('voi_wallet_metadata')).toBe(false);
  expect(mockSecureValues.has(service.PIN_KEY)).toBe(false);
  expect(mockSecureValues.has(service.SALT_KEY)).toBe(false);
  for (const id of ids) expect(mockSecureValues.has(secretKey(id))).toBe(false);
};

afterEach(async () => {
  mockHeldWrite?.land();
  mockHeldWrite = undefined;
  // A deliberately hung marker clear must land after its test, or its unsettled
  // record would refuse every later request write in this file.
  mockHeldMarkerRemove?.();
  mockHeldMarkerRemove = undefined;
  for (let i = 0; i < 5; i++) await Promise.resolve();
});
beforeEach(() => {
  mockSecureValues.clear();
  mockPlainValues.clear();
  mockEvents.length = 0;
  mockHoldNext = false;
  mockMarkerSetFailure = false;
  mockMarkerRemoveFailure = false;
  mockMarkerRemoveHang = false;
  mockLegacyDeleteFailure = false;
  mockWalletsFailure = false;
  mockWalletsHang = false;
  mockBlobStillThere = false;
  mockBlobVerifyFailure = false;
  mockNonceCounter = 0;
  (
    AccountSecureStorage as unknown as Record<string, unknown>
  ).unknownJournalDesired = undefined;
  (
    global as typeof globalThis & { __voiProcessSessionId?: string }
  ).__voiProcessSessionId = 'test-process-id';
});

describe('marker lifecycle', () => {
  test('the request is recorded before the first delete and cleared last, after the wallet blob', async () => {
    seedWallet(['one']);
    await wipeWalletData();
    expect(mockEvents[0]).toBe(`set:${MARKER}`);
    expect(mockEvents[mockEvents.length - 1]).toBe(`remove:${MARKER}`);
    expect(mockEvents.indexOf('wallet-blob')).toBeLessThan(
      mockEvents.lastIndexOf(`remove:${MARKER}`)
    );
    const firstDelete = mockEvents.findIndex(
      (e) => e.startsWith('secure-delete:') || e.startsWith('remove:')
    );
    expect(firstDelete).toBeGreaterThan(0);
    expectEverythingGone(['one']);
  });

  test('if the request cannot be recorded the wipe does not start: nothing is deleted', async () => {
    seedWallet(['one']);
    mockMarkerSetFailure = true;
    await expect(wipeWalletData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: [MARKER],
    });
    expect(mockEvents.filter((e) => e.startsWith('secure-delete'))).toEqual([]);
    expect(mockSecureValues.get(secretKey('one'))).toBe('secret-one');
    expect(mockEvents).not.toContain('wallet-blob');
  });

  test('an incomplete secure wipe leaves the request in place and does not touch the wallet blob', async () => {
    seedWallet(['one']);
    (
      require('@/platform').secureStorage.deleteItem as jest.Mock
    ).mockImplementationOnce(async () => {
      throw new Error('delete failed');
    });
    await expect(wipeWalletData()).rejects.toBeInstanceOf(WipeIncompleteError);
    expect(mockPlainValues.get(MARKER)).toBe('1');
    expect(mockEvents).not.toContain('wallet-blob');
  });

  test('a failed wallet-blob clear is incomplete, named, and keeps the request', async () => {
    seedWallet(['one']);
    mockWalletsFailure = true;
    await expect(wipeWalletData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: [WALLET_BLOB_NAME],
    });
    expect(mockPlainValues.get(MARKER)).toBe('1');
  });

  test('a failure to clear the request reports incomplete (a stale marker must not wipe a later wallet)', async () => {
    seedWallet(['one']);
    mockMarkerRemoveFailure = true;
    await expect(wipeWalletData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: [MARKER],
    });
    expect(mockPlainValues.get(MARKER)).toBe('1');
    expect(mockSecureValues.has(secretKey('one'))).toBe(false);
  });

  test('readWipeIntentStrict reports the marker and fails on a read error', async () => {
    await expect(AccountSecureStorage.readWipeIntentStrict()).resolves.toBe(
      false
    );
    mockPlainValues.set(MARKER, '1');
    await expect(AccountSecureStorage.readWipeIntentStrict()).resolves.toBe(
      true
    );
    mockPlainValues.set(MARKER, 'garbage');
    await expect(AccountSecureStorage.readWipeIntentStrict()).resolves.toBe(
      true
    );
    (require('@/platform').storage.getItem as jest.Mock).mockImplementationOnce(
      async () => {
        throw new Error('read failed');
      }
    );
    await expect(AccountSecureStorage.readWipeIntentStrict()).rejects.toThrow();
  });
});

describe('the wallet-blob step is bounded and verified', () => {
  test('a blob that still reads back present is incomplete, and the request stays', async () => {
    seedWallet(['one']);
    mockBlobStillThere = true;
    await expect(wipeWalletData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: [WALLET_BLOB_NAME],
    });
    expect(mockPlainValues.get(MARKER)).toBe('1');
  });

  test('a verification read that fails is incomplete, never "gone"', async () => {
    seedWallet(['one']);
    mockBlobVerifyFailure = true;
    await expect(wipeWalletData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: [WALLET_BLOB_NAME],
    });
    expect(mockPlainValues.get(MARKER)).toBe('1');
  });

  test('a hung blob clear is bounded and reported', async () => {
    jest.useFakeTimers();
    try {
      seedWallet(['one']);
      mockWalletsHang = true;
      const outcome = wipeWalletData().then(
        () => undefined,
        (error: unknown) => error
      );
      await jest.advanceTimersByTimeAsync(BLOB_STEP_TIMEOUT_MS + 1);
      expect(await outcome).toMatchObject({
        name: 'WipeIncompleteError',
        keys: [WALLET_BLOB_NAME],
      });
      expect(mockPlainValues.get(MARKER)).toBe('1');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the legacy wallet copy and the marker write', () => {
  test('the legacy secure-store copy is deleted and confirmed before the request is cleared', async () => {
    seedWallet(['one']);
    mockSecureValues.set(LEGACY_WALLET_SECURE_KEY, '{"accounts":["a"]}');
    await wipeWalletData();
    expect(mockSecureValues.has(LEGACY_WALLET_SECURE_KEY)).toBe(false);
    expect(
      mockEvents.indexOf(`secure-delete:${LEGACY_WALLET_SECURE_KEY}`)
    ).toBeLessThan(mockEvents.lastIndexOf(`remove:${MARKER}`));
  });

  test('a legacy copy that cannot be deleted leaves the wipe incomplete, named', async () => {
    seedWallet(['one']);
    mockSecureValues.set(LEGACY_WALLET_SECURE_KEY, '{"accounts":["a"]}');
    mockLegacyDeleteFailure = true;
    await expect(wipeWalletData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: [LEGACY_WALLET_BLOB_NAME],
    });
    expect(mockPlainValues.get(MARKER)).toBe('1');
  });

  test('a retry in the same session cannot write the request while an earlier clear of it can still land', async () => {
    jest.useFakeTimers();
    try {
      seedWallet(['one']);
      mockMarkerRemoveHang = true;
      const first = wipeWalletData().then(
        () => undefined,
        (error: unknown) => error
      );
      await jest.advanceTimersByTimeAsync(5001);
      expect(await first).toMatchObject({
        name: 'WipeIncompleteError',
        keys: [MARKER],
      });

      // A second Delete Everything this session must not START while the earlier
      // clear of the request can still land: that late delete would erase the new
      // request mid-wipe, and a wipe that then failed would have no marker to be
      // finished at boot. It is refused up front, so nothing is deleted.
      mockMarkerRemoveHang = false;
      seedWallet(['two']);
      await expect(wipeWalletData()).rejects.toMatchObject({
        name: 'WipeIncompleteError',
        keys: [MARKER],
      });
      expect(mockSecureValues.get(secretKey('two'))).toBe('secret-two');
      expect(mockSecureValues.get(service.PIN_KEY)).toBe('pin');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('one wipe at a time', () => {
  test('a call made while a wipe runs joins it: one request written, one wallet clear', async () => {
    seedWallet(['one']);
    const first = wipeWalletData();
    expect(isWipeInFlight()).toBe(true);
    const second = wipeWalletData();
    await Promise.all([first, second]);
    expect(mockEvents.filter((e) => e === `set:${MARKER}`)).toHaveLength(1);
    expect(mockEvents.filter((e) => e === 'wallet-blob')).toHaveLength(1);
    expect(isWipeInFlight()).toBe(false);
  });

  test('both callers see the same failure, and a later call starts a fresh wipe', async () => {
    seedWallet(['one']);
    mockWalletsFailure = true;
    const first = wipeWalletData();
    const second = wipeWalletData();
    await expect(first).rejects.toBeInstanceOf(WipeIncompleteError);
    await expect(second).rejects.toBeInstanceOf(WipeIncompleteError);
    expect(isWipeInFlight()).toBe(false);
    mockWalletsFailure = false;
    await wipeWalletData();
    expectEverythingGone(['one']);
  });
});

describe('a retry finishes the wipe from every partial state', () => {
  test('some accounts deleted, PIN and wallet blob still present', async () => {
    seedWallet(['one', 'two']);
    mockSecureValues.delete(secretKey('one'));
    mockPlainValues.set(MARKER, '1');
    await wipeWalletData();
    expectEverythingGone(['one', 'two']);
  });

  test('accounts and PIN gone, wallet blob with phantom accounts still present', async () => {
    mockPlainValues.set('voi_wallet_metadata', '{"accounts":["phantom"]}');
    mockPlainValues.set(MARKER, '1');
    await wipeWalletData();
    expectEverythingGone([]);
  });

  test('only the PIN and salt left over', async () => {
    mockSecureValues.set(service.PIN_KEY, 'pin');
    mockSecureValues.set(service.SALT_KEY, 'salt');
    mockPlainValues.set(MARKER, '1');
    await wipeWalletData();
    expectEverythingGone([]);
  });

  test('killed right after the request was recorded (nothing else changed)', async () => {
    seedWallet(['one']);
    mockPlainValues.set(MARKER, '1');
    await wipeWalletData();
    expectEverythingGone(['one']);
  });

  test('an incomplete wipe (a hung PIN write) completes after a restart', async () => {
    jest.useFakeTimers();
    try {
      seedWallet(['one']);
      mockHoldNext = true;
      const hung = service.boundedSecureSet(
        service.PIN_KEY,
        'old-pin',
        'presence'
      );
      const settled = hung.then(
        () => undefined,
        () => undefined
      );
      await jest.advanceTimersByTimeAsync(5001);
      await settled;
      await expect(wipeWalletData()).rejects.toBeInstanceOf(
        WipeIncompleteError
      );
      expect(mockPlainValues.get(MARKER)).toBe('1');
    } finally {
      jest.useRealTimers();
    }

    // Cold start: new native session, fresh JS runtime, storage persists.
    (
      global as typeof globalThis & { __voiProcessSessionId?: string }
    ).__voiProcessSessionId = 'restarted';
    jest.resetModules();
    const fresh = require('../index') as typeof import('../index');
    const freshStorage = require('@/services/secure/AccountSecureStorage')
      .AccountSecureStorage as typeof AccountSecureStorage;
    (freshStorage as unknown as Record<string, unknown>).unknownJournalDesired =
      undefined;
    expect(await freshStorage.readWipeIntentStrict()).toBe(true);
    await fresh.wipeWalletData();
    expectEverythingGone(['one']);
    expect(
      JSON.parse(mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY) ?? '{}')
    ).not.toHaveProperty(service.PIN_KEY);
  });
});
