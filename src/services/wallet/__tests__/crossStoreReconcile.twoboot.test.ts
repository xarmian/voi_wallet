// Cross-boot regression coverage: the fake stores deliberately retain their
// state across reconcile calls, as they do across app launches.
let mockBlob = new Set<string>();
let mockListed = new Set<string>();
let mockSecrets = new Set<string>();
let mockPending: Record<string, string> = {};
let mockQuarantined = new Set<string>();
let mockRecoveryMarked = false;
let mockDeleted: string[] = [];
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    readAccountListStrict: jest.fn(async () => [...mockListed]),
    readPendingCreatesStrict: jest.fn(async () => ({ ...mockPending })),
    recordUnexplainedRemovals: jest.fn(async () => {}),
    readUnknownWritesStrict: jest.fn(async () => ({})),
    resolveUnknownWrite: jest.fn(async () => true),
    dropUnknownWrite: jest.fn(async () => {}),
    probeSecretPresenceStrict: jest.fn(async (id: string) =>
      mockSecrets.has(id)
    ),
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
      ids.forEach((id) => mockBlob.delete(id));
    }),
  },
}));
import { AccountSecureStorage } from '@/services/secure';
import { reconcileCrossStoreHalfState } from '../crossStoreReconcile';

beforeEach(() => {
  mockBlob = new Set();
  mockListed = new Set();
  mockSecrets = new Set();
  mockPending = {};
  mockQuarantined = new Set();
  mockRecoveryMarked = false;
  mockDeleted = [];
  jest.clearAllMocks();
});

test('false-absent phantom prune cannot delete its live secret on the next boot', async () => {
  mockBlob.add('live');
  mockListed.add('live');
  mockSecrets.add('live');
  (AccountSecureStorage.probeSecretPresenceStrict as jest.Mock)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);

  const first = await reconcileCrossStoreHalfState();
  expect(first.phantomAccountsPruned).toEqual(['live']);
  expect(mockBlob.has('live')).toBe(false);
  expect(mockPending.live).toBeUndefined();

  const second = await reconcileCrossStoreHalfState();
  expect(second.orphanSecretsQuarantined).toEqual(['live']);
  expect(mockQuarantined.has('live')).toBe(true);
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
