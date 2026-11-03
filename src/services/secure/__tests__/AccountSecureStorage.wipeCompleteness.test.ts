const mockSecureValues = new Map<string, string>();
const mockPlainValues = new Map<string, string>();
let mockNonceCounter = 0;
let mockHeldWrite: { key: string; value: string; land: () => void } | undefined;
let mockHoldNext = false;
let mockDeleteFailure: string | undefined;
let mockHangDeleteKey: string | undefined;
let mockRemoveFailureKey: string | undefined;
let mockHangRemoveKey: string | undefined;

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
            value,
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
      if (mockDeleteFailure === key) throw new Error('delete failed');
      if (mockHangDeleteKey === key) return new Promise<void>(() => {});
      mockSecureValues.delete(key);
    }),
  },
  storage: {
    getItem: jest.fn(async (key: string) => mockPlainValues.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockPlainValues.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      if (mockRemoveFailureKey === key) throw new Error('remove failed');
      if (mockHangRemoveKey === key) return new Promise<void>(() => {});
      mockPlainValues.delete(key);
    }),
    multiRemove: jest.fn(async (keys: string[]) => {
      keys.forEach((key) => mockPlainValues.delete(key));
    }),
  },
  biometrics: {},
  deviceId: {},
}));

import { AccountSecureStorage } from '../AccountSecureStorage';
import { WipeIncompleteError } from '../../../types/wallet';
import {
  UNKNOWN_WRITES_STORAGE_KEY,
  WriteOutcomeUnknownError,
  WriteUnresolvedError,
} from '../boundedWrites';

const service = AccountSecureStorage as unknown as {
  PIN_KEY: string;
  SALT_KEY: string;
  BIOMETRIC_ENABLED_KEY: string;
  BIOMETRIC_SECRET_KEY: string;
  METADATA_LIST_KEY: string;
  PIN_TIMEOUT_KEY: string;
  PIN_THROTTLE_KEY: string;
  STORAGE_KEY_PREFIX: string;
  LEGACY_STORAGE_KEY_PREFIX: string;
  boundedSecureSet(
    key: string,
    value: string,
    verifier: 'presence'
  ): Promise<void>;
  runKeyMutationExclusive<T>(task: () => Promise<T>): Promise<T>;
};
const secret = 'voi_account_secret_one';
const nameKeys = () => [
  service.PIN_KEY,
  service.SALT_KEY,
  service.BIOMETRIC_ENABLED_KEY,
  service.BIOMETRIC_SECRET_KEY,
  service.METADATA_LIST_KEY,
  service.PIN_TIMEOUT_KEY,
  service.PIN_THROTTLE_KEY,
];
// The biometric secret and the PIN throttle live only in secure storage.
const plainKeys = () => [
  service.PIN_KEY,
  service.SALT_KEY,
  service.BIOMETRIC_ENABLED_KEY,
  service.METADATA_LIST_KEY,
  service.PIN_TIMEOUT_KEY,
];

// A test that deliberately hangs a native write must not leave an unsettled
// record behind for the next one (the wipe now reports those): let it land.
afterEach(async () => {
  mockHeldWrite?.land();
  mockHeldWrite = undefined;
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

beforeEach(() => {
  mockSecureValues.clear();
  mockPlainValues.clear();
  mockNonceCounter = 0;
  mockHoldNext = false;
  mockHeldWrite = undefined;
  mockDeleteFailure = undefined;
  mockHangDeleteKey = undefined;
  mockRemoveFailureKey = undefined;
  mockHangRemoveKey = undefined;
  (
    AccountSecureStorage as unknown as Record<string, unknown>
  ).unknownJournalDesired = undefined;
  (
    global as typeof globalThis & { __voiProcessSessionId?: string }
  ).__voiProcessSessionId = 'test-process-id';
});

test('complete wipe removes settings from both stores', async () => {
  for (const key of plainKeys()) {
    mockPlainValues.set(
      key,
      key === service.METADATA_LIST_KEY ? '[]' : 'plain'
    );
  }
  for (const key of nameKeys()) mockSecureValues.set(key, 'secure');
  await expect(AccountSecureStorage.clearAll()).resolves.toBeUndefined();
  const leftPlain = plainKeys().filter((key) => mockPlainValues.has(key));
  const leftSecure = nameKeys().filter((key) => mockSecureValues.has(key));
  expect({ leftPlain, leftSecure }).toEqual({ leftPlain: [], leftSecure: [] });
});

it.each([
  'voi_wallet_pin',
  'voi_wallet_salt',
  'voi_biometric_enabled',
  'voi_biometric_secret',
  'voi_account_list',
  'voi_pin_timeout_setting',
  'voi_pin_throttle',
])('reports a failed secure deletion of %s and continues', async (key) => {
  const secretValue = 'sensitive-secret-value';
  // The account list is read from general storage first; a plain empty list
  // keeps the legacy secure-list fallback (a different path) out of this test.
  mockPlainValues.set(service.METADATA_LIST_KEY, '[]');
  for (const item of nameKeys()) mockSecureValues.set(item, secretValue);
  mockDeleteFailure = key;
  let thrown: WipeIncompleteError | undefined;
  try {
    await AccountSecureStorage.clearAll();
  } catch (error) {
    thrown = error as WipeIncompleteError;
  }
  expect(thrown).toBeInstanceOf(WipeIncompleteError);
  expect(thrown?.keys).toContain(key);
  expect(JSON.stringify(thrown)).not.toContain(secretValue);
  expect(thrown?.message).not.toContain(secretValue);
  for (const item of nameKeys())
    if (item !== key) expect(mockSecureValues.has(item)).toBe(false);
});

test('a same-session journal entry makes wipe incomplete and remains a delete entry', async () => {
  mockPlainValues.set(
    UNKNOWN_WRITES_STORAGE_KEY,
    JSON.stringify({
      [secret]: {
        key: secret,
        op: 'set',
        verifier: 'presence',
        attempt: 'a'.repeat(32),
        sessionId: 'test-process-id',
        at: 1,
      },
    })
  );
  let thrown: WipeIncompleteError | undefined;
  try {
    await AccountSecureStorage.clearAll();
  } catch (error) {
    thrown = error as WipeIncompleteError;
  }
  expect(thrown).toBeInstanceOf(WipeIncompleteError);
  expect(thrown?.keys).toContain(secret);
  expect(
    JSON.parse(mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY)!)[secret].op
  ).toBe('delete');
});

test('a prior-session journal entry does not block wipe', async () => {
  mockPlainValues.set(
    UNKNOWN_WRITES_STORAGE_KEY,
    JSON.stringify({
      [secret]: {
        key: secret,
        op: 'set',
        verifier: 'presence',
        attempt: 'a'.repeat(32),
        sessionId: 'earlier-process',
        at: 1,
      },
    })
  );
  await expect(AccountSecureStorage.clearAll()).resolves.toBeUndefined();
  expect(
    JSON.parse(mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY) ?? '{}')
  ).not.toHaveProperty(secret);
});

test('setup style set is allowed after a complete wipe', async () => {
  await AccountSecureStorage.clearAll();
  await service.boundedSecureSet('voi_wallet_pin', 'x', 'presence');
  expect(mockSecureValues.get('voi_wallet_pin')).toBe('x');
});

test('a hung account delete is bounded, reported by name, and releases the key mutex', async () => {
  jest.useFakeTimers();
  try {
    mockPlainValues.set(service.METADATA_LIST_KEY, JSON.stringify(['one']));
    mockSecureValues.set(secret, 'secure');
    mockHangDeleteKey = `${service.LEGACY_STORAGE_KEY_PREFIX}one`;
    const wipe = AccountSecureStorage.clearAll();
    const outcome = wipe.then(
      () => undefined,
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(5001);
    const thrown = (await outcome) as WipeIncompleteError;
    expect(thrown).toBeInstanceOf(WipeIncompleteError);
    expect(thrown.keys).toContain(secret);
    // The mutex is free: a later key mutation runs instead of queueing forever.
    await expect(service.runKeyMutationExclusive(async () => 1)).resolves.toBe(
      1
    );
  } finally {
    jest.useRealTimers();
  }
});

test('an unsettled pending SET leaves the wipe incomplete, keeps the refusal, and the tombstone deletes the late landing', async () => {
  jest.useFakeTimers();
  try {
    mockHoldNext = true;
    const hung = service.boundedSecureSet(
      service.PIN_KEY,
      'old-pin',
      'presence'
    );
    const hungOutcome = expect(hung).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError
    );
    await jest.advanceTimersByTimeAsync(5001);
    await hungOutcome;

    await expect(AccountSecureStorage.clearAll()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining([service.PIN_KEY]),
    });
    // setupPin's refusal is unchanged: a new PIN must not be written while the
    // old SET can still land.
    await expect(
      service.boundedSecureSet(service.PIN_KEY, 'new-pin', 'presence')
    ).rejects.toBeInstanceOf(WriteUnresolvedError);

    mockHeldWrite!.land();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSecureValues.has(service.PIN_KEY)).toBe(false);
  } finally {
    jest.useRealTimers();
  }
});

test('restart and try again completes: a cold start drops the in-memory record and the earlier-session entry', async () => {
  jest.useFakeTimers();
  try {
    mockHoldNext = true;
    const hung = service.boundedSecureSet(
      service.PIN_KEY,
      'old-pin',
      'presence'
    );
    const hungOutcome = expect(hung).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError
    );
    await jest.advanceTimersByTimeAsync(5001);
    await hungOutcome;
    await expect(AccountSecureStorage.clearAll()).rejects.toBeInstanceOf(
      WipeIncompleteError
    );
    expect(
      JSON.parse(mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY) ?? '{}')
    ).toHaveProperty(service.PIN_KEY);
  } finally {
    jest.useRealTimers();
  }

  // Cold start: a new native process session and a fresh JS runtime (the
  // in-memory pending records and tombstones are gone). Storage persists.
  (
    global as typeof globalThis & { __voiProcessSessionId?: string }
  ).__voiProcessSessionId = 'restarted';
  jest.resetModules();
  const fresh = require('../AccountSecureStorage')
    .AccountSecureStorage as typeof AccountSecureStorage;
  (fresh as unknown as Record<string, unknown>).unknownJournalDesired =
    undefined;

  await expect(fresh.clearAll()).resolves.toBeUndefined();
  expect(
    JSON.parse(mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY) ?? '{}')
  ).not.toHaveProperty(service.PIN_KEY);
  expect(mockSecureValues.has(service.PIN_KEY)).toBe(false);
  // And the new wallet can set its PIN.
  const freshService = fresh as unknown as typeof service;
  await freshService.boundedSecureSet(service.PIN_KEY, 'new-pin', 'presence');
  expect(mockSecureValues.get(service.PIN_KEY)).toBe('new-pin');
});

test('a failed general-storage removal is reported even though the secure delete succeeded', async () => {
  mockPlainValues.set(service.METADATA_LIST_KEY, '[]');
  mockPlainValues.set(service.PIN_KEY, 'plain-pin');
  mockSecureValues.set(service.PIN_KEY, 'secure-pin');
  mockRemoveFailureKey = service.PIN_KEY;
  await expect(AccountSecureStorage.clearAll()).rejects.toMatchObject({
    name: 'WipeIncompleteError',
    keys: expect.arrayContaining([service.PIN_KEY]),
  });
  // The wipe still went on: the secure copy is gone.
  expect(mockSecureValues.has(service.PIN_KEY)).toBe(false);
});

test('a hung account-metadata removal is bounded, reported by name, and releases the key mutex', async () => {
  jest.useFakeTimers();
  try {
    mockPlainValues.set(service.METADATA_LIST_KEY, JSON.stringify(['one']));
    mockHangRemoveKey = `voi_account_metadata_one`;
    const outcome = AccountSecureStorage.clearAll().then(
      () => undefined,
      (error: unknown) => error
    );
    await jest.advanceTimersByTimeAsync(5001);
    const thrown = (await outcome) as WipeIncompleteError;
    expect(thrown).toBeInstanceOf(WipeIncompleteError);
    expect(thrown.keys).toContain(secret);
    await expect(service.runKeyMutationExclusive(async () => 1)).resolves.toBe(
      1
    );
  } finally {
    jest.useRealTimers();
  }
});

test('an unsettled pending SET is reported by the pending-record check even when no journal entry exists', async () => {
  jest.useFakeTimers();
  try {
    mockHoldNext = true;
    const hung = service.boundedSecureSet(
      service.PIN_KEY,
      'old-pin',
      'presence'
    );
    const hungOutcome = expect(hung).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError
    );
    await jest.advanceTimersByTimeAsync(5001);
    await hungOutcome;
    // Remove the durable entry so ONLY the in-memory record can flag it.
    await AccountSecureStorage.dropUnknownWrite(service.PIN_KEY);
    expect(
      JSON.parse(mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY) ?? '{}')
    ).not.toHaveProperty(service.PIN_KEY);

    await expect(AccountSecureStorage.clearAll()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining([service.PIN_KEY]),
    });
    mockHeldWrite!.land();
    await jest.advanceTimersByTimeAsync(1);
  } finally {
    jest.useRealTimers();
  }
});
