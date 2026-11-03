const mockSecure = new Map<string, string>();
const mockKv = new Map<string, string>();
let mockProbeReads = 0;
let mockPresence: (count: number) => string | null = () => null;
let mockOrder: string[] = [];
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
  expect(mockOrder).toEqual(['storage', 'prune']);
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
