// Cross-boot regression coverage: the fake stores deliberately retain their
// state across reconcile calls, as they do across app launches.
let mockBlob = new Set<string>();
let mockListed = new Set<string>();
let mockSecrets = new Set<string>();
let mockPending: Record<string, string> = {};
let mockQuarantined = new Set<string>();
let mockRecoveryMarked = false;
let mockDeleted: string[] = [];
let mockRemovalRecords: string[] = [];
let mockProbeCount = 0;
let mockMutationOrder: string[] = [];
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    readAccountListStrict: jest.fn(async () => [...mockListed]),
    readPendingCreatesStrict: jest.fn(async () => ({ ...mockPending })),
    recordUnexplainedRemovals: jest.fn(async () => {}),
    recordUnexplainedRemovalsLocked: jest.fn(
      async (records: { id: string }[]) => {
        mockMutationOrder.push('record');
        mockRemovalRecords.push(...records.map(({ id }) => id));
      }
    ),
    clearUnexplainedRemoval: jest.fn(async (id: string) => {
      mockRemovalRecords = mockRemovalRecords.filter(
        (recordId) => recordId !== id
      );
    }),
    runWithConfirmedAbsentSecrets: jest.fn(
      async (
        ids: string[],
        action: (
          absent: string[],
          signal: { aborted: boolean }
        ) => Promise<boolean>
      ) => {
        const states = await Promise.all(
          ids.map(async (id) => [id, await mockProbe(id)] as const)
        );
        const liveIds = states
          .filter(([, present]) => present)
          .map(([id]) => id);
        const confirmedAbsent = states
          .filter(([, present]) => !present)
          .map(([id]) => id);
        const acted = confirmedAbsent.length
          ? await action(confirmedAbsent, { aborted: false })
          : false;
        return { confirmedAbsent, liveIds, acted };
      }
    ),
    readUnknownWritesStrict: jest.fn(async () => ({})),
    resolveUnknownWrite: jest.fn(async () => true),
    dropUnknownWrite: jest.fn(async () => {}),
    probeSecretPresenceStrict: jest.fn(async (id: string) => {
      mockProbeCount++;
      const absent = !mockSecrets.has(id);
      if (mockProbeCount === 1 && id === 'live') mockSecrets.add(id);
      return !absent;
    }),
    deleteAccount: jest.fn(async (id: string) => {
      mockDeleted.push(id);
      mockSecrets.delete(id);
    }),
    dropPendingCreateEntries: jest.fn(async (ids: string[]) => {
      ids.forEach((id) => delete mockPending[id]);
    }),
    readQuarantinedIdsSalvaged: jest.fn(async () => [...mockQuarantined]),
    addQuarantinedIds: jest.fn(async (ids: string[]) => {
      ids.forEach((id) => mockQuarantined.add(id));
    }),
    readReconcileRecoveryMarker: jest.fn(async () => mockRecoveryMarked),
    setReconcileRecoveryMarker: jest.fn(async () => {
      mockRecoveryMarked = true;
    }),
    clearReconcileRecoveryMarker: jest.fn(async () => {
      mockRecoveryMarked = false;
    }),
  },
}));
jest.mock('../index', () => ({
  MultiAccountWalletService: {
    getBlobAccountIdsStrict: jest.fn(async () => ({
      standardIds: [...mockBlob],
      allIds: [...mockBlob],
      standardAccounts: [...mockBlob].map((id) => ({
        id,
        address: `addr-${id}`,
        label: id,
      })),
    })),
    pruneStandardAccounts: jest.fn(async (ids: string[]) => {
      mockMutationOrder.push('prune');
      ids.forEach((id) => mockBlob.delete(id));
      return true;
    }),
  },
}));
import { AccountSecureStorage } from '@/services/secure';
import { reconcileCrossStoreHalfState } from '../crossStoreReconcile';

const mockProbe = async (id: string) => mockSecrets.has(id);

beforeEach(() => {
  mockBlob = new Set();
  mockListed = new Set();
  mockSecrets = new Set();
  mockPending = {};
  mockQuarantined = new Set();
  mockRecoveryMarked = false;
  mockDeleted = [];
  mockRemovalRecords = [];
  mockProbeCount = 0;
  mockMutationOrder = [];
  jest.clearAllMocks();
});

test('secret appearing after Phase 1 is kept visible and has no removal record', async () => {
  mockBlob.add('live');
  mockListed.add('live');
  mockPending.live = 'token';

  const first = await reconcileCrossStoreHalfState();
  expect(first.phantomAccountsPruned).toEqual([]);
  expect(first.phantomAccountsSkippedLive).toEqual(['live']);
  expect(mockBlob.has('live')).toBe(true);
  expect(mockRemovalRecords).toEqual([]);
  expect(mockPending.live).toBe('token');

  const second = await reconcileCrossStoreHalfState();
  expect(second.phantomAccountsPruned).toEqual([]);
  expect(second.orphanSecretsQuarantined).toEqual([]);
  expect(mockQuarantined.has('live')).toBe(false);
  expect(mockDeleted).toEqual([]);
});

test('unprovenanced orphan quarantine remains registered on later boots', async () => {
  mockListed.add('orphan');
  mockSecrets.add('orphan');
  const first = await reconcileCrossStoreHalfState();
  expect(first.orphanSecretsQuarantined).toEqual(['orphan']);
  mockPending.orphan = 'create-token';
  const second = await reconcileCrossStoreHalfState();
  expect(second.orphanSecretsQuarantined).toEqual(['orphan']);
  expect(mockQuarantined.has('orphan')).toBe(true);
  expect(mockPending.orphan).toBe('create-token');
  expect(mockDeleted).toEqual([]);
});

test('confirmed phantom is recorded before pruning, while a locked re-probe failure is best effort', async () => {
  mockBlob.add('phantom');
  mockListed.add('phantom');
  const pruned = await reconcileCrossStoreHalfState();
  expect(pruned.phantomAccountsPruned).toEqual(['phantom']);
  expect(mockRemovalRecords).toEqual(['phantom']);
  expect(mockMutationOrder).toEqual(['record', 'prune']);

  mockBlob.add('retry');
  mockListed.add('retry');
  (
    AccountSecureStorage.runWithConfirmedAbsentSecrets as jest.Mock
  ).mockRejectedValueOnce(new Error('probe failed'));
  const retry = await reconcileCrossStoreHalfState();
  expect(retry.phantomAccountsPruned).toEqual([]);
  expect(mockBlob.has('retry')).toBe(true);
});

test('a live skipped candidate receives no removal record when another phantom is pruned', async () => {
  mockBlob.add('live');
  mockBlob.add('phantom');
  mockListed.add('live');
  mockListed.add('phantom');
  mockPending.live = 'keep-token';
  const result = await reconcileCrossStoreHalfState();
  expect(result.phantomAccountsSkippedLive).toEqual(['live']);
  expect(result.phantomAccountsPruned).toEqual(['phantom']);
  expect(mockRemovalRecords).toEqual(['phantom']);
  expect(mockBlob.has('live')).toBe(true);
  expect(mockPending.live).toBe('keep-token');
});
