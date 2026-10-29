let mockStore: Record<string, string> = {};

jest.mock('@/platform', () => ({
  storage: {
    getItem: jest.fn(async (key: string) => mockStore[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStore[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete mockStore[key];
    }),
  },
  secureStorage: {
    getItem: jest.fn(async () => null),
    deleteItem: jest.fn(async () => {}),
  },
}));
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));
jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getResetGeneration: () => 0,
    storeAccountForCreation: jest.fn(async () => 'token'),
    commitPendingCreate: jest.fn(async () => {}),
    deleteAccountIfAttemptMatches: jest.fn(async () => {}),
  },
}));

import { storage, secureStorage } from '@/platform';
import { AccountType, ResetRacedError, Wallet } from '@/types/wallet';
import { MultiAccountWalletService as Service } from '../index';

const WALLET_KEY = 'voi_wallet_metadata';
const readWallet = (): Wallet => JSON.parse(mockStore[WALLET_KEY]);

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
});

afterEach(() => jest.restoreAllMocks());

it('preserves a new account while avatar metadata updates run concurrently (#5)', async () => {
  const first = await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'First',
  });
  const [added] = await Promise.all([
    Service.createStandardAccount({ type: AccountType.STANDARD, label: 'New' }),
    Service.updateAccountMetadata({
      ...first,
      avatarUrl: 'https://example.test/avatar',
    }),
  ]);
  expect(readWallet().accounts.map((account) => account.id)).toEqual([
    first.id,
    added.id,
  ]);
  expect(readWallet().accounts[0].avatarUrl).toBe(
    'https://example.test/avatar'
  );
});

it('preserves both simultaneous additions to an existing wallet (#5)', async () => {
  const first = await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'First',
  });
  const added = await Promise.all(
    ['Second', 'Third'].map((label) =>
      Service.createStandardAccount({ type: AccountType.STANDARD, label })
    )
  );
  expect(readWallet().accounts.map((account) => account.id)).toEqual([
    first.id,
    ...added.map((account) => account.id),
  ]);
});

it.each([
  'primary failure',
  'corrupt JSON',
  'empty blob',
  'invalid accounts',
  'null JSON',
])('refuses to replace an unreadable wallet: %s (#6)', async (failure) => {
  await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'Existing',
  });
  if (failure === 'corrupt JSON') mockStore[WALLET_KEY] = '{broken';
  if (failure === 'empty blob') mockStore[WALLET_KEY] = '';
  if (failure === 'invalid accounts') mockStore[WALLET_KEY] = '{"accounts":{}}';
  if (failure === 'null JSON') mockStore[WALLET_KEY] = 'null';
  const before = mockStore[WALLET_KEY];
  jest.mocked(storage.setItem).mockClear();
  if (failure === 'primary failure') {
    jest
      .mocked(storage.getItem)
      .mockRejectedValueOnce(new Error('read unavailable'));
  }
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await expect(
    Service.createStandardAccount({
      type: AccountType.STANDARD,
      label: 'New',
    }).then(() => undefined)
  ).rejects.toThrow();
  expect(mockStore[WALLET_KEY]).toBe(before);
  expect(storage.setItem).not.toHaveBeenCalled();
});

it('propagates legacy read failure instead of creating an empty wallet (#6)', async () => {
  jest
    .mocked(secureStorage.getItem)
    .mockRejectedValueOnce(new Error('keychain unavailable'));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await expect(
    Service.createStandardAccount({
      type: AccountType.STANDARD,
      label: 'New',
    }).then(() => undefined)
  ).rejects.toThrow();
  expect(storage.setItem).not.toHaveBeenCalled();
});

it('allows fresh creation after a completed metadata wipe', async () => {
  await Service.clearAllWallets();
  const account = await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'Fresh',
  });
  expect(readWallet().accounts.map((entry) => entry.id)).toEqual([account.id]);
});

it('applies only an avatar patch, retaining newer account fields', async () => {
  const first = await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'First',
  });
  await Service.updateAccountLabel(first.id, 'Renamed');
  await Service.updateAccountMetadata({
    id: first.id,
    avatarUrl: 'https://example.test/avatar',
  });
  expect(readWallet().accounts[0]).toMatchObject({
    label: 'Renamed',
    avatarUrl: 'https://example.test/avatar',
  });
});

it.each(['label', 'active', 'read repair'])(
  'preserves a new account racing a %s write (#5)',
  async (operation) => {
    const first = await Service.createStandardAccount({
      type: AccountType.STANDARD,
      label: 'First',
    });
    if (operation === 'read repair') {
      const wallet = readWallet();
      delete (wallet.accounts[0] as Partial<typeof first>).backupVerified;
      mockStore[WALLET_KEY] = JSON.stringify(wallet);
    }
    const [added] = await Promise.all([
      Service.createStandardAccount({
        type: AccountType.STANDARD,
        label: 'New',
      }),
      operation === 'label'
        ? Service.updateAccountLabel(first.id, 'Renamed')
        : operation === 'active'
          ? Service.setActiveAccount(first.id)
          : Service.getCurrentWallet(),
    ]);
    expect(readWallet().accounts.map((account) => account.id)).toEqual([
      first.id,
      added.id,
    ]);
  }
);

it('preserves a new account while reconciliation prunes the old account (#5)', async () => {
  const first = await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'First',
  });
  const [added, pruned] = await Promise.allSettled([
    Service.createStandardAccount({ type: AccountType.STANDARD, label: 'New' }),
    Service.pruneStandardAccounts([first.id]),
  ]);
  expect(pruned.status).toBe('fulfilled');
  if (added.status === 'fulfilled') {
    expect(readWallet().accounts.map((account) => account.id)).toEqual([
      added.value.id,
    ]);
  } else {
    // Pruning may wipe an empty wallet first; the add must explicitly abort.
    expect(added.reason).toBeInstanceOf(ResetRacedError);
    expect(mockStore[WALLET_KEY]).toBeUndefined();
  }
});

// Review follow-up (TASK-440): a mutation on the write chain must not wait
// on the legacy keychain without bound, and must never mutate (and so
// sanitize away the secrets of) an unmigrated legacy wallet copy.
it('bounds the legacy keychain read a mutation makes on the write chain', async () => {
  jest.useFakeTimers();
  try {
    jest
      .mocked(secureStorage.getItem)
      .mockImplementationOnce(() => new Promise(() => {}));
    const pending = Service.createStandardAccount({
      type: AccountType.STANDARD,
      label: 'First',
    });
    const outcome = pending.then(
      () => 'created',
      (error: Error) => error.message
    );
    await jest.advanceTimersByTimeAsync(5000);

    expect(await outcome).toContain(
      'Wallet storage did not respond; try again'
    );
    expect(mockStore[WALLET_KEY]).toBeUndefined();

    // The chain is free again: the next write goes through.
    await Service.createStandardAccount({
      type: AccountType.STANDARD,
      label: 'Next',
    });
    expect(readWallet().accounts).toHaveLength(1);
  } finally {
    jest.useRealTimers();
  }
});

it('never mutates an unmigrated legacy wallet copy', async () => {
  const legacy = JSON.stringify({
    id: 'legacy',
    version: '1.0',
    createdAt: '2025-01-01T00:00:00.000Z',
    accounts: [
      {
        id: 'old',
        address: 'OLD',
        type: AccountType.STANDARD,
        mnemonic: 'only copy of the phrase',
      },
    ],
    activeAccountId: 'old',
    settings: {},
  });
  jest.mocked(secureStorage.getItem).mockResolvedValue(legacy);

  await expect(
    Service.updateAccountMetadata({ id: 'old', label: 'Renamed' } as never)
  ).rejects.toThrow('Wallet data has not been migrated yet');
  expect(mockStore[WALLET_KEY]).toBeUndefined();
  expect(storage.setItem).not.toHaveBeenCalledWith(
    WALLET_KEY,
    expect.anything()
  );
});
