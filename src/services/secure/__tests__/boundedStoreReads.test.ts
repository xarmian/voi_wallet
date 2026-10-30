// TASK-449 — the keychain reads an account store makes are bounded and fail
// closed. Creation and restore (storeAccountForCreation /
// storeAccountMetadataForCreation) reach three keychain reads:
//
//   R1  the PIN presence read (storeAccountLocked, formerly hasPin(), which
//       swallowed a failure to "no PIN");
//   R2  the legacy account-list fallback in getAllAccountIds (reached whenever
//       the primary list is absent, e.g. the first account on a fresh install);
//   R3  the device-id read behind encryptPrivateKey's key derivation.
//
// Each test wedges one read with a never-settling promise. Against the unbounded
// code each store stays pending forever; bounded, it rejects at the deadline and
// never records the failure as "no PIN".
//
// SECURITY NOTE: key material is throwaway random bytes; nothing real is used or
// logged. secureStorage / AsyncStorage are in-memory Map sinks.

const mockSecure = new Map<string, string>();
const mockKv = new Map<string, string>();
// Keys whose secure read never settles (or settles only when released).
const mockWedged = new Map<string, (value: string | null) => void>();
const mockFailing = new Set<string>();
let mockDeviceIdWedged = false;

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
      getItem: jest.fn((k: string) => {
        if (mockFailing.has(k)) {
          return Promise.reject(new Error('keychain unavailable'));
        }
        if (mockWedged.has(k)) {
          return new Promise<string | null>((resolve) => {
            mockWedged.set(k, resolve);
          });
        }
        return Promise.resolve(mockSecure.has(k) ? mockSecure.get(k)! : null);
      }),
      setItem: jest.fn(async (k: string, v: string) => {
        mockSecure.set(k, v);
      }),
      deleteItem: jest.fn(async (k: string) => {
        mockSecure.delete(k);
      }),
    },
    storage: {
      getItem: jest.fn(async (k: string) =>
        mockKv.has(k) ? mockKv.get(k)! : null
      ),
      setItem: jest.fn(async (k: string, v: string) => {
        mockKv.set(k, v);
      }),
      removeItem: jest.fn(async (k: string) => {
        mockKv.delete(k);
      }),
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: {
      getDeviceId: () =>
        mockDeviceIdWedged
          ? new Promise<string>(() => {})
          : Promise.resolve('task449-test-device'),
    },
  };
});

import { AccountSecureStorage } from '../AccountSecureStorage';
import {
  AccountType,
  AccountStorageError,
  StandardAccountMetadata,
  WatchAccountMetadata,
} from '@/types/wallet';

const PIN_KEY = 'voi_wallet_pin';
const LIST_KEY = 'voi_account_list';
const SECRET_PREFIX = 'voi_account_secret_';
const METADATA_PREFIX = 'voi_account_metadata_';
const TIMEOUT_MS = 5000;

const nodeCrypto = require('crypto');

function standardAccount(id: string): StandardAccountMetadata {
  return {
    id,
    address: `ADDR_${id}`,
    publicKey: 'aa'.repeat(32),
    type: AccountType.STANDARD,
    label: id,
    color: '#123456',
    isHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    mnemonic: '',
    hasBackup: true,
    backupVerified: false,
  } as StandardAccountMetadata;
}

function watchAccount(id: string): WatchAccountMetadata {
  return {
    id,
    address: `ADDR_${id}`,
    publicKey: '',
    type: AccountType.WATCH,
    label: id,
    color: '#123456',
    isHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  } as WatchAccountMetadata;
}

const freshSk = (): Uint8Array => Uint8Array.from(nodeCrypto.randomBytes(64));
const storedAuthMethod = (id: string): string | undefined => {
  const raw = mockKv.get(`${METADATA_PREFIX}${id}`);
  return raw
    ? (JSON.parse(raw) as { authMethod: string }).authMethod
    : undefined;
};

/** Run `op` and advance fake time past the deadline; resolve to its outcome. */
async function settleAfterDeadline<T>(
  op: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const outcome = op.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
  return outcome;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSecure.clear();
  mockKv.clear();
  mockWedged.clear();
  mockFailing.clear();
  mockDeviceIdWedged = false;
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TASK-449 R1: the PIN presence read on store', () => {
  it('a wedged PIN read fails the creation instead of hanging; nothing is stored', async () => {
    mockWedged.set(PIN_KEY, () => {});
    const gen = AccountSecureStorage.getResetGeneration();

    const outcome = await settleAfterDeadline(
      AccountSecureStorage.storeAccountForCreation(
        standardAccount('a1'),
        freshSk(),
        gen
      )
    );

    expect(outcome.ok).toBe(false);
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(AccountStorageError);
    expect((error as Error).message).toMatch(/PIN presence read timed out/);
    expect(mockSecure.has(`${SECRET_PREFIX}a1`)).toBe(false);
    expect(mockKv.has(`${METADATA_PREFIX}a1`)).toBe(false);
  });

  it('a failing PIN read fails the store; it is never written as "no PIN"', async () => {
    mockFailing.add(PIN_KEY);

    const outcome = await settleAfterDeadline(
      AccountSecureStorage.storeAccountMetadataForCreation(
        watchAccount('w1'),
        AccountSecureStorage.getResetGeneration()
      )
    );

    expect(outcome.ok).toBe(false);
    expect(storedAuthMethod('w1')).toBeUndefined();
  });

  it('a wedged PIN read fails a restore-path metadata store too', async () => {
    mockWedged.set(PIN_KEY, () => {});

    const outcome = await settleAfterDeadline(
      AccountSecureStorage.storeAccountMetadataForCreation(
        watchAccount('w2'),
        AccountSecureStorage.getResetGeneration()
      )
    );

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: Error }).error.message).toMatch(
      /PIN presence read timed out/
    );
  });

  it('genuine absence still stores as biometric; a stored PIN stores as pin', async () => {
    const gen = AccountSecureStorage.getResetGeneration();
    await AccountSecureStorage.storeAccountMetadataForCreation(
      watchAccount('w3'),
      gen
    );
    expect(storedAuthMethod('w3')).toBe('biometric');

    mockSecure.set(
      PIN_KEY,
      JSON.stringify({ hash: 'ab'.repeat(32), iterations: 8000 })
    );
    await AccountSecureStorage.storeAccountMetadataForCreation(
      watchAccount('w4'),
      gen
    );
    expect(storedAuthMethod('w4')).toBe('pin');
  });

  it('hasPin() keeps its swallowing contract for its other callers', async () => {
    mockFailing.add(PIN_KEY);
    await expect(AccountSecureStorage.hasPin()).resolves.toBe(false);
  });
});

describe('TASK-449 R2: the legacy account-list fallback', () => {
  it('a wedged legacy list read fails the store, and a late value is never migrated', async () => {
    mockWedged.set(LIST_KEY, () => {});

    const outcome = await settleAfterDeadline(
      AccountSecureStorage.storeAccountMetadataForCreation(
        watchAccount('w5'),
        AccountSecureStorage.getResetGeneration()
      )
    );

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: Error }).error.message).toMatch(
      /Legacy account list read timed out/
    );

    // The abandoned read settles late: nothing may act on it.
    const release = mockWedged.get(LIST_KEY)!;
    release(JSON.stringify(['legacy-id']));
    await jest.advanceTimersByTimeAsync(0);
    expect(mockKv.has(LIST_KEY)).toBe(false);
  });

  it('getAllAccountIds rejects on a wedged legacy read instead of hanging', async () => {
    mockWedged.set(LIST_KEY, () => {});
    const outcome = await settleAfterDeadline(
      AccountSecureStorage.getAllAccountIds()
    );
    expect(outcome.ok).toBe(false);
  });
});

describe('TASK-449 R3: the device-id read behind key encryption', () => {
  it('a wedged device-id read fails the creation; no secret is written', async () => {
    mockDeviceIdWedged = true;

    const outcome = await settleAfterDeadline(
      AccountSecureStorage.storeAccountForCreation(
        standardAccount('a2'),
        freshSk(),
        AccountSecureStorage.getResetGeneration()
      )
    );

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: Error }).error.message).toMatch(
      /Device id read timed out/
    );
    expect(mockSecure.has(`${SECRET_PREFIX}a2`)).toBe(false);
  });
});
