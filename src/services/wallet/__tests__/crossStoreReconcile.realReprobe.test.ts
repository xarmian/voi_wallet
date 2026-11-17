const mockSecure = new Map<string, string>();
const mockKv = new Map<string, string>();
let mockProbeReads = 0;
let mockPresence: (count: number) => string | null = () => null;
let mockOrder: string[] = [];
// When set, the removal-record write waits on it (simulates a slow storage
// write that outlives the locked action's bound).
let mockRecordWriteGate: Promise<void> | null = null;
const mockBlobRead = jest.fn();
const mockPrune = jest.fn();

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    crypto: {
      getRandomBytes: async (n: number) =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string) =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: jest.fn(async (key: string) => {
        if (key === 'voi_account_secret_a')
          return mockPresence(++mockProbeReads);
        return mockSecure.get(key) ?? null;
      }),
      setItem: jest.fn(async (key: string, value: string) => {
        mockSecure.set(key, value);
      }),
      deleteItem: jest.fn(async (key: string) => {
        mockSecure.delete(key);
      }),
    },
    storage: {
      getItem: jest.fn(async (key: string) => mockKv.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        if (key === 'voi_reconcile_unexplained_removals' && mockRecordWriteGate)
          await mockRecordWriteGate;
        mockOrder.push('storage');
        mockKv.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        mockKv.delete(key);
      }),
      multiRemove: jest.fn(async (keys: string[]) => {
        keys.forEach((key) => mockKv.delete(key));
      }),
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: { getDeviceId: async () => 'test-device' },
  };
});

jest.mock('../index', () => ({
  MultiAccountWalletService: {
    getBlobAccountIdsStrict: (...args: unknown[]) => mockBlobRead(...args),
    pruneStandardAccounts: (...args: unknown[]) => mockPrune(...args),
  },
}));

// Load the real storage primitive without evaluating unrelated secure-service
// exports that import the native-backed wallet store through the barrel.
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: require('@/services/secure/AccountSecureStorage')
    .AccountSecureStorage,
}));

import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { reconcileCrossStoreHalfState } from '../crossStoreReconcile';

const pendingKey = 'voi_pending_account_creates';

beforeEach(() => {
  mockSecure.clear();
  mockKv.clear();
  mockProbeReads = 0;
  mockPresence = () => null;
  mockOrder = [];
  mockRecordWriteGate = null;
  mockPrune.mockReset();
  mockBlobRead.mockReset();
  jest.restoreAllMocks();
  mockBlobRead.mockResolvedValue({
    standardIds: ['a'],
    allIds: ['a'],
    standardAccounts: [{ id: 'a', address: 'address-a', label: 'A' }],
  } as never);
  mockPrune.mockImplementation(async () => {
    mockOrder.push('prune');
    return true;
  });
  mockKv.set(pendingKey, JSON.stringify({ a: 'token' }));
});

it('keeps a secret that appears between Phase 1 and the locked re-probe', async () => {
  mockPresence = (count) =>
    count === 1 ? null : JSON.stringify({ live: true });
  const result = await reconcileCrossStoreHalfState();
  expect(mockPrune).not.toHaveBeenCalled();
  expect(result.phantomAccountsSkippedLive).toContain('a');
  await expect(AccountSecureStorage.readUnexplainedRemovals()).resolves.toEqual(
    []
  );
  expect(JSON.parse(mockKv.get(pendingKey)!)).toEqual({ a: 'token' });
});

it('records confirmed absence before pruning and reports the prune', async () => {
  mockPresence = () => null;
  const result = await reconcileCrossStoreHalfState();
  expect(mockPrune).toHaveBeenCalledTimes(1);
  expect(result.phantomAccountsPruned).toEqual(['a']);
});

it('fails closed when the locked re-probe throws without throwing from reconcile', async () => {
  mockPresence = (count) => {
    if (count > 1) throw new Error('re-probe failed');
    return null;
  };
  const result = await reconcileCrossStoreHalfState();
  expect(mockPrune).not.toHaveBeenCalled();
  expect(result.phantomAccountsPruned).toEqual([]);
  await expect(AccountSecureStorage.readUnexplainedRemovals()).resolves.toEqual(
    []
  );
});

it('bounds the locked prune action and releases the mutex after five seconds', async () => {
  jest.useFakeTimers();
  try {
    mockPresence = () => null;
    mockPrune.mockImplementation(() => new Promise<boolean>(() => {}));
    const reconcile = reconcileCrossStoreHalfState();
    const noThrow = expect(reconcile).resolves.toMatchObject({
      ran: true,
      phantomAccountsPruned: [],
    });
    await jest.advanceTimersByTimeAsync(5000);
    await noThrow;
    await AccountSecureStorage.addQuarantinedIds(['writer-after-timeout']);
    expect(JSON.parse(mockKv.get('voi_reconcile_quarantined_ids')!)).toContain(
      'writer-after-timeout'
    );
  } finally {
    jest.useRealTimers();
  }
});

it('holds the mutex past timeout after prune commit, then reports the prune', async () => {
  jest.useFakeTimers();
  try {
    mockPresence = () => null;
    let finish!: (value: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mockPrune.mockImplementation((_ids, options) => {
      (options as { onCommit: () => void }).onCommit();
      entered();
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    const reconcile = reconcileCrossStoreHalfState();
    await started;
    const writer = AccountSecureStorage.addQuarantinedIds(['after-commit']);
    const settled = jest.fn();
    reconcile.then(settled);
    await jest.advanceTimersByTimeAsync(5000);
    expect(settled).not.toHaveBeenCalled();
    expect(mockKv.has('voi_reconcile_quarantined_ids')).toBe(false);
    finish(true);
    await expect(reconcile).resolves.toMatchObject({
      phantomAccountsPruned: ['a'],
    });
    await expect(
      AccountSecureStorage.readUnexplainedRemovals()
    ).resolves.toHaveLength(1);
    await writer;
  } finally {
    jest.useRealTimers();
  }
});

it('retains the removal record when the committed prune throws', async () => {
  jest.useFakeTimers();
  try {
    mockPresence = () => null;
    const failure = new Error('wallet write failed');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mockPrune.mockImplementation((_ids, options) => {
      (options as { onCommit: () => void }).onCommit();
      entered();
      return Promise.reject(failure);
    });
    const reconcile = reconcileCrossStoreHalfState();
    await started;
    await jest.advanceTimersByTimeAsync(0);
    await expect(reconcile).resolves.toMatchObject({
      phantomAccountsPruned: [],
    });
    await expect(
      AccountSecureStorage.readUnexplainedRemovals()
    ).resolves.toEqual([{ id: 'a', address: 'address-a', label: 'A' }]);
  } finally {
    jest.useRealTimers();
  }
});

it('clears the removal record a delayed write stores after the bound fired, and does not prune', async () => {
  jest.useFakeTimers();
  try {
    mockPresence = () => null;
    // The removal-record write is stuck past the 5 s bound, so the bound fires
    // while the action is still BEFORE its prune call. The mutex is released,
    // a create/import may now land, and only then does the action resume.
    let releaseWrite!: () => void;
    mockRecordWriteGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const reconcile = reconcileCrossStoreHalfState();
    const noThrow = expect(reconcile).resolves.toMatchObject({
      ran: true,
      phantomAccountsPruned: [],
    });
    await jest.advanceTimersByTimeAsync(5000);
    await noThrow;
    expect(mockPrune).not.toHaveBeenCalled();
    // A secret write for the same id lands in the window after the mutex release.
    mockPresence = () => JSON.stringify({ live: true });
    // The abandoned action now resumes; it must NOT prune.
    releaseWrite();
    await jest.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(mockPrune).not.toHaveBeenCalled();
    expect(mockOrder).not.toContain('prune');
    await expect(
      AccountSecureStorage.readUnexplainedRemovals()
    ).resolves.toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

it('clears a removal record when pruning returns false', async () => {
  mockPresence = () => null;
  mockPrune.mockResolvedValueOnce(false);
  await reconcileCrossStoreHalfState();
  await expect(AccountSecureStorage.readUnexplainedRemovals()).resolves.toEqual(
    []
  );
  expect(mockPrune).toHaveBeenCalledTimes(1);
});

it('clears a removal record when pruning throws and reconcile swallows the error', async () => {
  mockPresence = () => null;
  mockPrune.mockRejectedValueOnce(new Error('prune failed'));
  await expect(reconcileCrossStoreHalfState()).resolves.toMatchObject({
    phantomAccountsPruned: [],
  });
  await expect(AccountSecureStorage.readUnexplainedRemovals()).resolves.toEqual(
    []
  );
});

it('keeps removal records after successful prune, with record before prune', async () => {
  mockPresence = () => null;
  await reconcileCrossStoreHalfState();
  expect(mockOrder).toEqual(['storage', 'prune']);
  await expect(AccountSecureStorage.readUnexplainedRemovals()).resolves.toEqual(
    [{ id: 'a', address: 'address-a', label: 'A' }]
  );
});
