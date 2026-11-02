jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    readAccountListStrict: jest.fn(),
    readPendingCreatesStrict: jest.fn(),
    readUnknownWritesStrict: jest.fn(),
    resolveUnknownWrite: jest.fn(),
    probeSecretPresenceStrict: jest.fn(),
    deleteAccount: jest.fn(),
    dropPendingCreateEntries: jest.fn(),
  },
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
