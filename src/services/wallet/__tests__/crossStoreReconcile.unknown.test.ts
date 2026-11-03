let mockRecoveryMarked = false;
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    readAccountListStrict: jest.fn(),
    readPendingCreatesStrict: jest.fn(),
    recordUnexplainedRemovals: jest.fn(async () => {}),
    recordUnexplainedRemovalsLocked: jest.fn(async () => {}),
    runWithConfirmedAbsentSecrets: jest.fn(
      async (
        ids: string[],
        action: (
          ids: string[],
          signal: { aborted: boolean }
        ) => Promise<boolean>
      ) => ({
        confirmedAbsent: ids,
        liveIds: [],
        acted: ids.length ? await action(ids, { aborted: false }) : false,
      })
    ),
    readUnknownWritesStrict: jest.fn(),
    resolveUnknownWrite: jest.fn(),
    dropUnknownWrite: jest.fn(),
    resetUnknownWrites: jest.fn(async () => {}),
    probeSecretPresenceStrict: jest.fn(),
    deleteAccount: jest.fn(),
    dropPendingCreateEntries: jest.fn(),
    readQuarantinedIdsSalvaged: jest.fn(async () => []),
    addQuarantinedIds: jest.fn(async () => {}),
    readReconcileRecoveryMarker: jest.fn(async () => mockRecoveryMarked),
    setReconcileRecoveryMarker: jest.fn(async () => {
      mockRecoveryMarked = true;
    }),
    clearReconcileRecoveryMarker: jest.fn(async () => {
      mockRecoveryMarked = false;
    }),
  },
}));
jest.mock('@/services/secure/boundedWrites', () => ({
  ...jest.requireActual('@/services/secure/boundedWrites'),
  hasDowngradedMarkers: jest.fn(() => false),
}));
jest.mock('../index', () => ({
  MultiAccountWalletService: {
    getBlobAccountIdsStrict: jest.fn(),
    pruneStandardAccounts: jest.fn(),
  },
}));
import { AccountSecureStorage } from '@/services/secure';
import { MultiAccountWalletService } from '../index';
import { reconcileCrossStoreHalfState } from '../crossStoreReconcile';
import {
  UnknownJournalCorruptError,
  hasDowngradedMarkers,
} from '@/services/secure/boundedWrites';
const downgraded = hasDowngradedMarkers as unknown as jest.Mock;
const secure = AccountSecureStorage as unknown as Record<string, jest.Mock>;
const wallet = MultiAccountWalletService as unknown as Record<
  string,
  jest.Mock
>;
function setup({
  blob = [],
  list = [],
  secrets = [],
  unknown = {},
  resolved = true,
}: {
  blob?: string[];
  list?: string[];
  secrets?: string[];
  unknown?: Record<string, unknown>;
  resolved?: boolean;
}) {
  secure.readAccountListStrict.mockResolvedValue(list);
  secure.readPendingCreatesStrict.mockResolvedValue({});
  secure.readUnknownWritesStrict.mockResolvedValue(unknown);
  secure.resolveUnknownWrite.mockResolvedValue(resolved);
  secure.probeSecretPresenceStrict.mockImplementation(async (id: string) =>
    secrets.includes(id)
  );
  wallet.getBlobAccountIdsStrict.mockResolvedValue({
    standardIds: blob,
    allIds: blob,
    standardAccounts: blob.map((id) => ({
      id,
      address: `addr-${id}`,
      label: id,
    })),
  });
  secure.deleteAccount.mockResolvedValue(undefined);
  secure.dropPendingCreateEntries.mockResolvedValue(undefined);
  wallet.pruneStandardAccounts.mockResolvedValue(true);
}
beforeEach(() => {
  jest.clearAllMocks();
  mockRecoveryMarked = false;
});
test('corrupt journal marker survives a process restart and makes the next pass report-only', async () => {
  setup({ blob: ['phantom'], list: ['phantom'] });
  secure.readUnknownWritesStrict.mockRejectedValueOnce(
    new UnknownJournalCorruptError('corrupt')
  );
  await expect(reconcileCrossStoreHalfState()).resolves.toMatchObject({
    ran: false,
  });
  expect(wallet.pruneStandardAccounts).not.toHaveBeenCalled();
  expect(secure.deleteAccount).not.toHaveBeenCalled();
  expect(secure.dropPendingCreateEntries).not.toHaveBeenCalled();
  expect(secure.resetUnknownWrites).toHaveBeenCalledTimes(1);
  expect(secure.setReconcileRecoveryMarker).toHaveBeenCalledTimes(1);

  // Reload the coordinator to model a process restart. The fake storage-backed
  // marker remains set while all module state and mocks are recreated.
  jest.resetModules();
  const freshSecure = require('@/services/secure').AccountSecureStorage;
  const freshWallet = require('../index').MultiAccountWalletService;
  const freshReconcile = require('../crossStoreReconcile')
    .reconcileCrossStoreHalfState as typeof reconcileCrossStoreHalfState;
  freshSecure.readAccountListStrict.mockResolvedValue(['phantom']);
  freshSecure.readPendingCreatesStrict.mockResolvedValue({});
  freshSecure.readQuarantinedIdsSalvaged.mockResolvedValue([]);
  freshSecure.readUnknownWritesStrict.mockResolvedValue({});
  freshSecure.resolveUnknownWrite.mockResolvedValue(true);
  freshSecure.probeSecretPresenceStrict.mockResolvedValue(false);
  freshSecure.deleteAccount.mockResolvedValue(undefined);
  freshSecure.dropPendingCreateEntries.mockResolvedValue(undefined);
  freshSecure.resetUnknownWrites.mockResolvedValue(undefined);
  freshWallet.getBlobAccountIdsStrict.mockResolvedValue({
    standardIds: ['phantom'],
    allIds: ['phantom'],
    standardAccounts: [
      { id: 'phantom', address: 'addr-phantom', label: 'phantom' },
    ],
  });
  freshWallet.pruneStandardAccounts.mockResolvedValue(true);
  await expect(freshReconcile()).resolves.toMatchObject({
    ran: true,
    reportOnly: true,
  });
  expect(freshWallet.pruneStandardAccounts).not.toHaveBeenCalled();
  expect(freshSecure.deleteAccount).not.toHaveBeenCalled();
  expect(freshSecure.clearReconcileRecoveryMarker).toHaveBeenCalledTimes(1);
  await expect(freshReconcile()).resolves.toMatchObject({
    ran: true,
  });
  expect(freshWallet.pruneStandardAccounts).toHaveBeenCalledWith(
    ['phantom'],
    expect.objectContaining({ shouldAbort: expect.any(Function) })
  );
});
test('orphan secret with no list entry and no journal is not invented as a candidate', async () => {
  setup({ secrets: ['orphan'] });
  await reconcileCrossStoreHalfState();
  expect(secure.deleteAccount).not.toHaveBeenCalled();
});
test('list entry with absent secret is recovery state and is left untouched', async () => {
  setup({ list: ['recover'] });
  await reconcileCrossStoreHalfState();
  expect(secure.deleteAccount).not.toHaveBeenCalled();
  expect(wallet.pruneStandardAccounts).not.toHaveBeenCalled();
});
test.each([true, false])(
  'resolved UNKNOWN secret entry, present=%s, is dropped and normal policy applies',
  async (present) => {
    const id = 'account';
    setup({
      blob: [id],
      list: [id],
      secrets: present ? [id] : [],
      unknown: {
        [`voi_account_secret_${id}`]: {
          key: `voi_account_secret_${id}`,
          op: 'set',
          verifier: 'nonce',
          attempt: 'a',
          sessionId: 'old',
          at: 1,
        },
      },
    });
    await reconcileCrossStoreHalfState();
    expect(secure.resolveUnknownWrite).toHaveBeenCalledWith(
      `voi_account_secret_${id}`
    );
    expect(wallet.pruneStandardAccounts).toHaveBeenCalledTimes(present ? 0 : 1);
  }
);
test('unresolvable UNKNOWN id is skipped without prune or orphan deletion', async () => {
  setup({
    blob: ['account'],
    list: ['account'],
    unknown: {
      voi_account_secret_account: {
        key: 'voi_account_secret_account',
        op: 'set',
        verifier: 'nonce',
        attempt: 'a',
        sessionId: 'old',
        at: 1,
      },
    },
    resolved: false,
  });
  await reconcileCrossStoreHalfState();
  expect(wallet.pruneStandardAccounts).not.toHaveBeenCalled();
  expect(secure.deleteAccount).not.toHaveBeenCalled();
});
const entryFor = (key: string) => ({
  key,
  op: 'set',
  verifier: 'nonce',
  attempt: 'a',
  sessionId: 'old',
  at: 1,
});
test('resolved entries are dropped only after the whole pass; an unresolvable non-account key aborts before any journal change', async () => {
  setup({
    unknown: {
      voi_account_secret_one: entryFor('voi_account_secret_one'),
      voi_account_list: entryFor('voi_account_list'),
    },
  });
  secure.resolveUnknownWrite.mockImplementation(
    async (key: string) => key === 'voi_account_secret_one'
  );
  await expect(reconcileCrossStoreHalfState()).rejects.toThrow();
  expect(secure.dropUnknownWrite).not.toHaveBeenCalled();
  expect(secure.deleteAccount).not.toHaveBeenCalled();
});
test('resolved entries are dropped after the destructive phase, never before', async () => {
  setup({
    blob: ['gone'],
    list: ['gone'],
    unknown: { voi_account_secret_other: entryFor('voi_account_secret_other') },
  });
  const order: string[] = [];
  wallet.pruneStandardAccounts.mockImplementation(async () => {
    order.push('prune');
  });
  secure.dropUnknownWrite.mockImplementation(async () => {
    order.push('drop');
  });
  await reconcileCrossStoreHalfState();
  expect(order).toEqual(['prune', 'drop']);
});
test('a delete entry whose secret is still present makes the id an orphan candidate (the secret is not silently abandoned)', async () => {
  setup({
    secrets: ['gone'],
    unknown: {
      voi_account_secret_gone: {
        key: 'voi_account_secret_gone',
        op: 'delete',
        verifier: 'presence',
        attempt: '',
        sessionId: 'old',
        at: 1,
      },
    },
  });
  await reconcileCrossStoreHalfState();
  expect(secure.deleteAccount).toHaveBeenCalledWith('gone');
  expect(secure.dropUnknownWrite).toHaveBeenCalledWith(
    'voi_account_secret_gone',
    expect.objectContaining({ op: 'delete', sessionId: 'old' })
  );
});
test('a METADATA delete entry never makes the id an orphan candidate (a separate secret is not deleted)', async () => {
  setup({
    secrets: ['gone'],
    unknown: {
      voi_account_metadata_gone: {
        key: 'voi_account_metadata_gone',
        op: 'delete',
        verifier: 'presence',
        attempt: '',
        sessionId: 'old',
        at: 1,
      },
    },
  });
  await reconcileCrossStoreHalfState();
  expect(secure.deleteAccount).not.toHaveBeenCalled();
});
describe('ruling B: a downgraded bookkeeping marker makes every reconcile non-destructive', () => {
  afterEach(() => downgraded.mockReturnValue(false));
  const staleListScenario = () => {
    // The list/metadata write that would have recorded the account was stale or
    // late: a live secret has a pending-create journal entry and no blob owner.
    setup({ secrets: ['acct'] });
    secure.readPendingCreatesStrict.mockResolvedValue({ acct: 't1' });
  };
  test('with a marker, a stale late list write causes NO delete and NO prune', async () => {
    downgraded.mockReturnValue(true);
    staleListScenario();
    wallet.getBlobAccountIdsStrict.mockResolvedValue({
      standardIds: ['phantom'],
      allIds: ['phantom'],
      standardAccounts: [
        { id: 'phantom', address: 'addr-phantom', label: 'phantom' },
      ],
    });
    secure.readAccountListStrict.mockResolvedValue(['phantom']);
    const result = await reconcileCrossStoreHalfState();
    expect(result.reportOnly).toBe(true);
    expect(secure.deleteAccount).not.toHaveBeenCalled();
    expect(wallet.pruneStandardAccounts).not.toHaveBeenCalled();
  });
  test('without a marker only a proven delete can delete an orphan, while the phantom is pruned', async () => {
    downgraded.mockReturnValue(false);
    staleListScenario();
    wallet.getBlobAccountIdsStrict.mockResolvedValue({
      standardIds: ['phantom'],
      allIds: ['phantom'],
      standardAccounts: [
        { id: 'phantom', address: 'addr-phantom', label: 'phantom' },
      ],
    });
    secure.readAccountListStrict.mockResolvedValue(['phantom']);
    const result = await reconcileCrossStoreHalfState();
    expect(secure.deleteAccount).not.toHaveBeenCalled();
    expect(result.orphanSecretsQuarantined).toEqual(['acct']);
    expect(wallet.pruneStandardAccounts).toHaveBeenCalledWith(
      ['phantom'],
      expect.objectContaining({ shouldAbort: expect.any(Function) })
    );
  });
});
