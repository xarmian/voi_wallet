jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    readAccountListStrict: jest.fn(),
    readPendingCreatesStrict: jest.fn(),
    readUnknownWritesStrict: jest.fn(),
    resolveUnknownWrite: jest.fn(),
    dropUnknownWrite: jest.fn(),
    resetUnknownWrites: jest.fn(async () => {}),
    probeSecretPresenceStrict: jest.fn(),
    deleteAccount: jest.fn(),
    dropPendingCreateEntries: jest.fn(),
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
  });
  secure.deleteAccount.mockResolvedValue(undefined);
  secure.dropPendingCreateEntries.mockResolvedValue(undefined);
  wallet.pruneStandardAccounts.mockResolvedValue(undefined);
}
beforeEach(() => jest.clearAllMocks());
test('corrupt unknown journal aborts without destructive calls, resets, then next boot runs', async () => {
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
  await expect(reconcileCrossStoreHalfState()).resolves.toMatchObject({
    ran: true,
  });
  expect(wallet.pruneStandardAccounts).toHaveBeenCalledWith(['phantom']);
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
    'voi_account_secret_gone'
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
    });
    secure.readAccountListStrict.mockResolvedValue(['phantom']);
    const result = await reconcileCrossStoreHalfState();
    expect(result.reportOnly).toBe(true);
    expect(secure.deleteAccount).not.toHaveBeenCalled();
    expect(wallet.pruneStandardAccounts).not.toHaveBeenCalled();
  });
  test('without a marker the orphan policy is unchanged (the orphan secret is deleted, the phantom pruned)', async () => {
    downgraded.mockReturnValue(false);
    staleListScenario();
    wallet.getBlobAccountIdsStrict.mockResolvedValue({
      standardIds: ['phantom'],
      allIds: ['phantom'],
    });
    secure.readAccountListStrict.mockResolvedValue(['phantom']);
    await reconcileCrossStoreHalfState();
    expect(secure.deleteAccount).toHaveBeenCalledWith('acct');
    expect(wallet.pruneStandardAccounts).toHaveBeenCalledWith(['phantom']);
  });
});
