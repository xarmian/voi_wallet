const mockSecureValues = new Map<string, string>();
const mockPlainValues = new Map<string, string>();
let mockNonceCounter = 0;
let mockHeldWrite: { key: string; value: string; land: () => void } | undefined;
let mockHoldNext = false;
let mockHoldJournalNext = false;
let mockLandJournal: (() => void) | undefined;
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
      if (key === 'voi_unknown_secure_writes' && mockHoldJournalNext) {
        mockHoldJournalNext = false;
        await new Promise<void>((resolve) => {
          mockLandJournal = () => {
            mockPlainValues.set(key, value);
            resolve();
          };
        });
        return;
      }
      mockPlainValues.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
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
import {
  WriteOutcomeUnknownError,
  WriteUnresolvedError,
  UNKNOWN_WRITES_STORAGE_KEY,
  BOOKKEEPING_KEYS,
  BOOKKEEPING_KEY_PREFIXES,
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
  mockHoldJournalNext = false;
  mockLandJournal = undefined;
  // Tests seed the journal in storage directly; drop the in-memory desired state.
  (
    AccountSecureStorage as unknown as Record<string, unknown>
  ).unknownJournalDesired = undefined;
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

const earlierEntry = (over: Record<string, unknown> = {}) => ({
  [key]: {
    key,
    op: 'set',
    verifier: 'nonce',
    attempt: 'a'.repeat(32),
    sessionId: 'earlier',
    at: 1,
    ...over,
  },
});
const seedEntry = (over: Record<string, unknown> = {}) =>
  mockPlainValues.set(
    UNKNOWN_WRITES_STORAGE_KEY,
    JSON.stringify(earlierEntry(over))
  );

test('boot: an earlier-session nonce entry over a legacy payload is resolved', async () => {
  mockSecureValues.set(key, JSON.stringify(payload));
  seedEntry();
  await expect(AccountSecureStorage.resolveUnknownWrite(key)).resolves.toBe(
    true
  );
  expect(
    Object.keys(await AccountSecureStorage.readUnknownWritesStrict())
  ).toEqual([key]);
});

test('reconcile after JS reload leaves a current-process unknown set unresolved', async () => {
  seedEntry({ sessionId: 'test-process-id' });
  mockSecureValues.set(key, JSON.stringify(payload));
  jest.resetModules();
  const reloaded =
    require('../AccountSecureStorage') as typeof import('../AccountSecureStorage');
  await expect(
    reloaded.AccountSecureStorage.resolveUnknownWrite(key)
  ).resolves.toBe(false);
  expect(
    Object.keys(await reloaded.AccountSecureStorage.readUnknownWritesStrict())
  ).toEqual([key]);
});

test('boot: a payload carrying a different nonce resolves; the matching nonce also resolves', async () => {
  seedEntry();
  mockSecureValues.set(
    key,
    JSON.stringify({ ...payload, writeNonce: 'b'.repeat(32) })
  );
  await expect(AccountSecureStorage.resolveUnknownWrite(key)).resolves.toBe(
    true
  );
  mockSecureValues.set(
    key,
    JSON.stringify({ ...payload, writeNonce: 'a'.repeat(32) })
  );
  await expect(AccountSecureStorage.resolveUnknownWrite(key)).resolves.toBe(
    true
  );
});

test('boot: an absent key and a corrupt value resolve; resolving never removes the entry', async () => {
  seedEntry();
  await expect(AccountSecureStorage.resolveUnknownWrite(key)).resolves.toBe(
    true
  );
  mockSecureValues.set(key, '{corrupt');
  await expect(AccountSecureStorage.resolveUnknownWrite(key)).resolves.toBe(
    true
  );
  expect(
    Object.keys(await AccountSecureStorage.readUnknownWritesStrict())
  ).toEqual([key]);
});

test('boot: a presence-verifier entry resolves on any successful probe', async () => {
  seedEntry({ verifier: 'presence', attempt: '' });
  mockSecureValues.set(key, 'anything');
  await expect(AccountSecureStorage.resolveUnknownWrite(key)).resolves.toBe(
    true
  );
});

test('guard: a later mutation over an earlier-session legacy payload proceeds', async () => {
  seedEntry();
  mockSecureValues.set(key, JSON.stringify(payload));
  await expect(account.saveSecret('one', payload)).resolves.toBeUndefined();
  expect(JSON.parse(mockSecureValues.get(key)!).writeNonce).toBeDefined();
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

test('corrupt UNKNOWN journal does not refuse saveSecret(null), deleteAccount, or clearAll', async () => {
  mockSecureValues.set(key, JSON.stringify(payload));
  mockPlainValues.set(UNKNOWN_WRITES_STORAGE_KEY, '{corrupt');
  await expect(account.saveSecret('one', null)).resolves.toBeUndefined();
  mockSecureValues.set(key, JSON.stringify(payload));
  await expect(
    AccountSecureStorage.deleteAccount('one')
  ).resolves.toBeUndefined();
  await expect(AccountSecureStorage.clearAll()).resolves.toBeUndefined();
  expect(mockPlainValues.has(UNKNOWN_WRITES_STORAGE_KEY)).toBe(false);
});

test('clearAll tombstones a timed-out secret write that lands after the wipe', async () => {
  jest.useFakeTimers();
  try {
    mockPlainValues.set('voi_account_list', JSON.stringify(['one']));
    mockHoldNext = true;
    const first = account.saveSecret('one', payload);
    const assertion = expect(first).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError
    );
    await jest.advanceTimersByTimeAsync(5001);
    await assertion;
    await AccountSecureStorage.clearAll();
    mockHeldWrite!.land();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockSecureValues.has(key)).toBe(false);
    const journal = JSON.parse(
      mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY) ?? '{}'
    );
    expect(journal).not.toHaveProperty(key);
  } finally {
    jest.useRealTimers();
  }
});

test('a late journal write cannot restore an entry removed by a later mutation', async () => {
  jest.useFakeTimers();
  try {
    const lateKey = 'voi_account_secret_late';
    await AccountSecureStorage.resetUnknownWrites();
    mockHoldNext = true;
    mockHoldJournalNext = true;
    const first = account.saveSecret('late', { ...payload, accountId: 'late' });
    const assertion = expect(first).rejects.toBeInstanceOf(
      WriteOutcomeUnknownError
    );
    await jest.advanceTimersByTimeAsync(10002);
    await assertion;
    await AccountSecureStorage.dropUnknownWrite(lateKey);
    mockLandJournal!();
    await jest.advanceTimersByTimeAsync(1);
    expect(
      JSON.parse(mockPlainValues.get(UNKNOWN_WRITES_STORAGE_KEY)!)
    ).not.toHaveProperty(lateKey);
  } finally {
    jest.useRealTimers();
  }
});

test('bookkeeping key literals in boundedWrites match AccountSecureStorage (drift guard)', () => {
  const asPrivate = AccountSecureStorage as unknown as Record<string, string>;
  expect(BOOKKEEPING_KEYS).toContain(asPrivate.METADATA_LIST_KEY);
  expect(BOOKKEEPING_KEYS).toContain(asPrivate.PENDING_CREATES_KEY);
  expect(BOOKKEEPING_KEY_PREFIXES).toContain(asPrivate.METADATA_KEY);
  // PIN, salt and every secret key must NOT be bookkeeping keys.
  for (const secretish of [
    asPrivate.PIN_KEY,
    asPrivate.SALT_KEY,
    `${asPrivate.STORAGE_KEY_PREFIX}x`,
  ]) {
    expect(BOOKKEEPING_KEYS).not.toContain(secretish);
    expect(
      BOOKKEEPING_KEY_PREFIXES.some((prefix) => secretish.startsWith(prefix))
    ).toBe(false);
  }
});

test('clearAll keeps an inherited same-process SET entry as a delete entry (ruling A)', async () => {
  mockPlainValues.set(
    UNKNOWN_WRITES_STORAGE_KEY,
    JSON.stringify({
      [key]: {
        key,
        op: 'set',
        verifier: 'nonce',
        attempt: 'a'.repeat(32),
        sessionId: 'test-process-id',
        at: 1,
      },
      voi_account_list: {
        key: 'voi_account_list',
        op: 'set',
        verifier: 'presence',
        attempt: '',
        sessionId: 'earlier-process',
        at: 1,
      },
    })
  );
  await AccountSecureStorage.clearAll();
  const left = await AccountSecureStorage.readUnknownWritesStrict();
  expect(Object.keys(left)).toEqual([key]);
  expect(left[key].op).toBe('delete');
  await expect(account.saveSecret('one', payload)).rejects.toBeInstanceOf(
    WriteUnresolvedError
  );
});
