const mockSecureValues = new Map<string, string>();
const mockPlainValues = new Map<string, string>();
let mockNonceCounter = 0;
let mockHeldWrite: { key: string; value: string; land: () => void } | undefined;
let mockHoldNext = false;
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
      mockSecureValues.delete(key);
    }),
  },
  storage: {
    getItem: jest.fn(async (key: string) => mockPlainValues.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockPlainValues.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockPlainValues.delete(key);
    }),
  },
  biometrics: {},
  deviceId: {},
}));
import { AccountSecureStorage } from '../AccountSecureStorage';
import {
  WriteOutcomeUnknownError,
  WriteUnresolvedError,
  UNKNOWN_WRITES_STORAGE_KEY,
} from '../boundedWrites';
const account = AccountSecureStorage as unknown as {
  saveSecret(id: string, payload: unknown): Promise<void>;
  saveSecretV2Checked(id: string, payload: unknown): Promise<void>;
  appendBlob(payload: unknown, blob: unknown): unknown;
  runKeyMutationExclusive<T>(task: () => Promise<T>): Promise<T>;
  boundedSecureSet(
    key: string,
    value: string,
    verifier: 'presence'
  ): Promise<void>;
};
const payload = {
  accountId: 'one',
  encryptedPrivateKey: 'cipher',
  authMethod: 'pin',
};
const key = 'voi_account_secret_one';
const nonce = () => JSON.parse(mockSecureValues.get(key)!).writeNonce as string;
beforeEach(() => {
  mockSecureValues.clear();
  mockPlainValues.clear();
  mockNonceCounter = 0;
  mockHoldNext = false;
  mockHeldWrite = undefined;
});

test('every secret payload write remints a 32-hex nonce, including append and reused object', async () => {
  await account.saveSecret('one', payload);
  const first = nonce();
  await account.saveSecret('one', payload);
  const second = nonce();
  const reused = JSON.parse(mockSecureValues.get(key)!);
  await account.saveSecretV2Checked('one', reused);
  const third = nonce();
  await account.saveSecretV2Checked(
    'one',
    account.appendBlob(reused, { mac: 'blob' })
  );
  const fourth = nonce();
  expect(new Set([first, second, third, fourth]).size).toBe(4);
  for (const item of [first, second, third, fourth])
    expect(item).toMatch(/^[0-9a-f]{32}$/);
  expect(payload).not.toHaveProperty('writeNonce');
});

test('UNKNOWN secret is journaled before the mutex releases, and later mutation waits for its nonce', async () => {
  jest.useFakeTimers();
  try {
    mockHoldNext = true;
    const first = account.runKeyMutationExclusive(() =>
      account.saveSecret('one', payload)
    );
    const firstAssertion = expect(first).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError
    );
    await jest.advanceTimersByTimeAsync(5001);
    await firstAssertion;
    const entry = JSON.parse(mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY)!)[
      key
    ];
    expect(entry.verifier).toBe('nonce');
    expect(entry.attempt).toBe(JSON.parse(mockHeldWrite!.value).writeNonce);
    expect(JSON.stringify(entry)).not.toContain('cipher');
    await expect(
      account.runKeyMutationExclusive(() => account.saveSecret('one', payload))
    ).rejects.toBeInstanceOf(WriteUnresolvedError);
    mockHeldWrite!.land();
    await account.runKeyMutationExclusive(() =>
      account.saveSecret('one', payload)
    );
    expect(nonce()).not.toBe(entry.attempt);
  } finally {
    jest.useRealTimers();
  }
});

test('non-payload writes use presence verifier', async () => {
  jest.useFakeTimers();
  try {
    mockHoldNext = true;
    const result = account.boundedSecureSet(
      'voi_wallet_pin',
      'legacy-test',
      'presence'
    );
    const assertion = expect(result).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError
    );
    await jest.advanceTimersByTimeAsync(5001);
    await assertion;
    const entry = JSON.parse(
      mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY)!
    ).voi_wallet_pin;
    expect(entry.verifier).toBe('presence');
    expect(entry).not.toHaveProperty('value');
  } finally {
    jest.useRealTimers();
  }
});

test('boot drops an earlier-session entry over a legacy payload without a nonce', async () => {
  mockSecureValues.set(key, JSON.stringify(payload));
  mockPlainValues.set(
    UNKNOWN_WRITES_STORAGE_KEY,
    JSON.stringify({
      [key]: {
        key,
        op: 'set',
        verifier: 'nonce',
        attempt: 'a'.repeat(32),
        sessionId: 'earlier',
        at: 1,
      },
    })
  );
  await expect(AccountSecureStorage.resolveUnknownWrite(key)).resolves.toBe(
    true
  );
  expect(await AccountSecureStorage.readUnknownWritesStrict()).toEqual({});
  expect(JSON.parse(mockSecureValues.get(key)!)).not.toHaveProperty(
    'writeNonce'
  );
});

test('legacy payload without an UNKNOWN entry remains readable', async () => {
  mockSecureValues.set(key, JSON.stringify(payload));
  await expect(AccountSecureStorage.resolveUnknownWrite(key)).resolves.toBe(
    true
  );
  expect(JSON.parse(mockSecureValues.get(key)!)).not.toHaveProperty(
    'writeNonce'
  );
});

test('corrupt UNKNOWN journal blocks a new mutation', async () => {
  mockPlainValues.set(UNKNOWN_WRITES_STORAGE_KEY, '{corrupt');
  await expect(account.saveSecret('one', payload)).rejects.toBeInstanceOf(
    WriteUnresolvedError
  );
  expect(mockSecureValues.has(key)).toBe(false);
});
