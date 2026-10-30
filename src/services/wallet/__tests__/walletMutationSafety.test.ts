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
  // clearAllMocks keeps implementations: a test that installs a legacy copy
  // must not leak it into the next one.
  jest.mocked(secureStorage.getItem).mockReset().mockResolvedValue(null);
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

// Audit 10-29, Luna P2 on #240: a create/import that stored its secret but
// failed before the wallet metadata committed must not leave the secret
// behind, whatever the failure (not only a raced reset).
it('rolls back the create secret when the wallet write fails for any reason', async () => {
  const { AccountSecureStorage } = require('../../secure/AccountSecureStorage');
  // A present-but-corrupt wallet blob: the strict in-chain read throws.
  mockStore[WALLET_KEY] = '{"accounts":';

  await expect(
    Service.createStandardAccount({ type: AccountType.STANDARD, label: 'X' })
  ).rejects.toThrow();

  expect(AccountSecureStorage.storeAccountForCreation).toHaveBeenCalledTimes(1);
  expect(
    AccountSecureStorage.deleteAccountIfAttemptMatches
  ).toHaveBeenCalledTimes(1);
  expect(AccountSecureStorage.commitPendingCreate).not.toHaveBeenCalled();
});

it('rolls back the import secret when the in-chain write rejects it', async () => {
  const algosdk = require('algosdk');
  const { AccountSecureStorage } = require('../../secure/AccountSecureStorage');
  await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'First',
  });
  jest.clearAllMocks();
  const imported = algosdk.generateAccount();
  // A concurrent add of the same address lands between the duplicate
  // pre-check and the in-chain write, which rejects the duplicate.
  jest
    .mocked(AccountSecureStorage.storeAccountForCreation)
    .mockImplementationOnce(async () => {
      const wallet = readWallet();
      wallet.accounts.push({
        ...wallet.accounts[0],
        id: 'concurrent',
        address: imported.addr.toString(),
      });
      mockStore[WALLET_KEY] = JSON.stringify(wallet);
      return 'token';
    });

  await expect(
    Service.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: algosdk.secretKeyToMnemonic(imported.sk),
      label: 'Imported',
    } as never)
  ).rejects.toThrow();

  expect(
    AccountSecureStorage.deleteAccountIfAttemptMatches
  ).toHaveBeenCalledTimes(1);
  expect(AccountSecureStorage.commitPendingCreate).not.toHaveBeenCalled();
});

it('fails an import closed, before storing a secret, when the legacy read hangs', async () => {
  jest.useFakeTimers();
  try {
    jest
      .mocked(secureStorage.getItem)
      .mockImplementationOnce(() => new Promise(() => {}));
    const {
      AccountSecureStorage,
    } = require('../../secure/AccountSecureStorage');
    const outcome = Service.importStandardAccount({
      type: AccountType.STANDARD,
      mnemonic: require('algosdk').secretKeyToMnemonic(
        require('algosdk').generateAccount().sk
      ),
      label: 'Imported',
    } as never).then(
      () => 'imported',
      (error: Error) => error.message
    );
    await jest.advanceTimersByTimeAsync(5000);

    expect(await outcome).toContain('Wallet storage did not respond');
    expect(AccountSecureStorage.storeAccountForCreation).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

// Luna confirm round on #240 (a): an import with no label derives its default
// label from the same strict, bounded read as the duplicate check, not from
// getAccountCount (getCurrentWallet -> an unbounded legacy keychain read).
it('labels an unlabelled import from the strict read, not getAccountCount', async () => {
  const algosdk = require('algosdk');
  await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'First',
  });
  const getAccountCount = jest.spyOn(Service as any, 'getAccountCount');

  const imported = await Service.importStandardAccount({
    type: AccountType.STANDARD,
    mnemonic: algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk),
  } as never);

  expect(imported.label).toBe('Imported Account 2');
  expect(getAccountCount).not.toHaveBeenCalled();
});

// Luna confirm round on #240 (b): once the wallet blob is written the add has
// committed. A failure clearing the wipe tombstone afterwards must not fail
// the create (whose catch would delete the secret of a persisted account).
it('keeps the secret of an account whose metadata landed when the tombstone clear fails', async () => {
  const { AccountSecureStorage } = require('../../secure/AccountSecureStorage');
  const removeItem = jest.mocked(storage.removeItem);
  const original = removeItem.getMockImplementation();
  removeItem.mockImplementation(async (key: string) => {
    if (key === 'voi_wallet_wiped') throw new Error('disk busy');
    delete mockStore[key];
  });
  try {
    const created = await Service.createStandardAccount({
      type: AccountType.STANDARD,
      label: 'Landed',
    });

    expect(readWallet().accounts.map((account) => account.id)).toEqual([
      created.id,
    ]);
    expect(
      AccountSecureStorage.deleteAccountIfAttemptMatches
    ).not.toHaveBeenCalled();
    expect(AccountSecureStorage.commitPendingCreate).toHaveBeenCalledTimes(1);
  } finally {
    removeItem.mockImplementation(original!);
  }
});

// TASK-443: getCurrentWallet's legacy migration read is bounded too, so every
// caller that reaches it (default labels, the watch/remote-signer/rekeyed
// duplicate checks) settles instead of hanging on a stuck keychain, and the
// write that follows still fails closed in the chain.
describe('getCurrentWallet legacy read is bounded (TASK-443)', () => {
  const algosdk = require('algosdk');
  const address = () => algosdk.generateAccount().addr.toString();
  // Each path crosses its bounded reads in sequence: createStandardAccount two
  // (getAccountCount, then the write chain), the other imports three (the
  // duplicate/auth lookup, the default-label count, then the write chain).
  const TWO_DEADLINES_MS = 10_000;
  const THREE_DEADLINES_MS = 15_000;

  const settle = (pending: Promise<unknown>) =>
    pending.then(
      () => 'resolved',
      (error: Error) => `rejected: ${error.message}`
    );

  beforeEach(() => {
    jest.useFakeTimers();
    jest
      .mocked(secureStorage.getItem)
      .mockImplementation(() => new Promise(() => {}));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('getCurrentWallet reads as null at the deadline and migrates nothing', async () => {
    const outcome = Service.getCurrentWallet();
    await jest.advanceTimersByTimeAsync(5000);
    expect(await outcome).toBeNull();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('createStandardAccount (default label via getAccountCount) settles and fails closed', async () => {
    const outcome = settle(
      Service.createStandardAccount({ type: AccountType.STANDARD })
    );
    await jest.advanceTimersByTimeAsync(TWO_DEADLINES_MS);
    expect(await outcome).toContain('Wallet storage did not respond');
    expect(mockStore[WALLET_KEY]).toBeUndefined();
  });

  it('addWatchAccount (duplicate check) settles and fails closed', async () => {
    const outcome = settle(
      Service.addWatchAccount({ type: AccountType.WATCH, address: address() })
    );
    await jest.advanceTimersByTimeAsync(THREE_DEADLINES_MS);
    expect(await outcome).toContain('Wallet storage did not respond');
    expect(mockStore[WALLET_KEY]).toBeUndefined();
  });

  it('addRemoteSignerAccount (duplicate check) settles and fails closed', async () => {
    const account = algosdk.generateAccount();
    const outcome = settle(
      Service.addRemoteSignerAccount({
        type: AccountType.REMOTE_SIGNER,
        address: account.addr.toString(),
        publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
        signerDeviceId: 'device-1',
      } as never)
    );
    await jest.advanceTimersByTimeAsync(THREE_DEADLINES_MS);
    expect(await outcome).toContain('Wallet storage did not respond');
    expect(mockStore[WALLET_KEY]).toBeUndefined();
  });

  it('detectRekeyedAccount (auth-address lookup) settles and fails closed', async () => {
    jest
      .spyOn(Service as any, 'verifyRekeyRelationship')
      .mockResolvedValue(true);
    const outcome = settle(
      Service.detectRekeyedAccount({
        type: AccountType.REKEYED,
        originalAddress: address(),
        authAddress: address(),
      })
    );
    await jest.advanceTimersByTimeAsync(THREE_DEADLINES_MS);
    expect(await outcome).toContain('Wallet storage did not respond');
    expect(mockStore[WALLET_KEY]).toBeUndefined();
  });
});
