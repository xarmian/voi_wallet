// TASK-423: a backup can carry two records with distinct ids but one address.
// Restore keeps one record per address, chosen before anything is written:
// key-bearing first, then Ledger/remote signer over watch, then backup order.
//
// SECURITY NOTE: every mnemonic below is generated fresh in-process by algosdk.
// Nothing is committed.

let mockStore: Record<string, string> = {};

jest.mock('@/platform', () => ({
  storage: {
    getItem: jest.fn(async (k: string) =>
      Object.prototype.hasOwnProperty.call(mockStore, k) ? mockStore[k] : null
    ),
    setItem: jest.fn(async (k: string, v: string) => {
      mockStore[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete mockStore[k];
    }),
  },
  secureStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    deleteItem: jest.fn(async () => {}),
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));

const mockPersistRestoredWallet = jest.fn(async () => {});
const mockGetCurrentWallet = jest.fn();

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: (...args: unknown[]) => mockGetCurrentWallet(...args),
    persistRestoredWallet: (...args: unknown[]) =>
      mockPersistRestoredWallet(...(args as [])),
  },
}));

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getResetGeneration: () => 0,
    clearAll: jest.fn(),
    probeSecretPresenceStrict: jest.fn(async () => false),
    storeAccountMetadataForCreation: jest.fn(),
    storeAccountForCreation: jest.fn(async () => 'token'),
    commitPendingCreate: jest.fn(async () => {}),
    deleteAccountIfAttemptMatches: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getMnemonic: jest.fn(async () => mockMnemonicForCollect),
  },
}));

jest.mock('@/services/secure/pinSetupPending', () => ({
  markPinSetupPending: jest.fn(async () => {}),
}));

let mockMnemonicForCollect = '';

import algosdk from 'algosdk';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { Buffer } from 'buffer';
import { AccountType } from '@/types/wallet';
import { dedupeAccountsByAddress, restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

function freshAccount() {
  const account = algosdk.generateAccount();
  return {
    address: account.addr.toString(),
    publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
  };
}

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
});

const record = (
  overrides: Partial<BackupAccountData> & Pick<BackupAccountData, 'id'>
): BackupAccountData =>
  ({
    address: '',
    publicKey: '',
    type: AccountType.WATCH,
    createdAt: '2026-01-01T00:00:00.000Z',
    isHidden: false,
    ...overrides,
  }) as BackupAccountData;

const restoredWallet = () =>
  (
    mockPersistRestoredWallet.mock.calls[0] as unknown as [
      { accounts: { id: string; address: string; type: AccountType }[] },
    ]
  )[0];

describe('restore dedupes records that share an address (TASK-423)', () => {
  it('keeps the key-bearing record and its secret when the keyless one comes first', async () => {
    const fresh = freshAccount();
    const watch = record({
      id: 'watch-first',
      address: fresh.address,
      publicKey: fresh.publicKey,
      label: 'Watch copy',
    });
    const standard = record({
      id: 'standard-second',
      address: fresh.address,
      publicKey: fresh.publicKey,
      type: AccountType.STANDARD,
      mnemonic: fresh.mnemonic,
    });

    const counts = await restoreAccounts([watch, standard]);

    expect(counts.duplicatesDropped).toBe(1);
    expect(counts.total).toBe(1);
    expect(counts.standard).toBe(1);
    expect(counts.watch).toBe(0);
    expect(restoredWallet().accounts).toEqual([
      expect.objectContaining({
        id: 'standard-second',
        address: fresh.address,
        type: AccountType.STANDARD,
      }),
    ]);
    // The kept record's key was written, under its own id; nothing was
    // written for the dropped watch record.
    const storeKey = AccountSecureStorage.storeAccountForCreation as jest.Mock;
    expect(storeKey).toHaveBeenCalledTimes(1);
    expect(storeKey.mock.calls[0][0]).toMatchObject({ id: 'standard-second' });
    expect(
      AccountSecureStorage.storeAccountMetadataForCreation
    ).not.toHaveBeenCalled();
  });

  it('groups a STANDARD record by the address its mnemonic derives', () => {
    const fresh = freshAccount();
    const { accounts, dropped } = dedupeAccountsByAddress([
      record({ id: 'w', address: fresh.address }),
      record({
        id: 's',
        address: 'STALE_PAYLOAD_ADDRESS',
        type: AccountType.STANDARD,
        mnemonic: fresh.mnemonic,
      }),
    ]);
    expect(dropped).toBe(1);
    expect(accounts.map((a) => a.id)).toEqual(['s']);
  });

  it('keeps a retained-key REKEYED record over a keyless one', () => {
    const fresh = freshAccount();
    const { accounts } = dedupeAccountsByAddress([
      record({
        id: 'r-keyless',
        address: fresh.address,
        type: AccountType.REKEYED,
      }),
      record({
        id: 'r-key',
        address: fresh.address,
        type: AccountType.REKEYED,
        mnemonic: fresh.mnemonic,
      }),
    ]);
    expect(accounts.map((a) => a.id)).toEqual(['r-key']);
  });

  it('keeps Ledger over watch, and backup order among equals', () => {
    const a = freshAccount().address;
    const b = freshAccount().address;
    const { accounts, dropped } = dedupeAccountsByAddress([
      record({ id: 'a-watch', address: a }),
      record({ id: 'a-ledger', address: a, type: AccountType.LEDGER }),
      record({ id: 'b-watch-1', address: b }),
      record({ id: 'b-watch-2', address: b }),
    ]);
    expect(dropped).toBe(2);
    expect(accounts.map((x) => x.id)).toEqual(['a-ledger', 'b-watch-1']);
  });

  it('a STANDARD record without a mnemonic never displaces a watch record', () => {
    const fresh = freshAccount();
    const { accounts, dropped } = dedupeAccountsByAddress([
      record({
        id: 's-empty',
        address: fresh.address,
        type: AccountType.STANDARD,
      }),
      record({ id: 'w', address: fresh.address }),
    ]);
    expect(dropped).toBe(0);
    expect(accounts.map((x) => x.id)).toEqual(['s-empty', 'w']);
  });

  it('leaves a backup without duplicates unchanged', () => {
    const input = [
      record({ id: 'x', address: freshAccount().address }),
      record({ id: 'y', address: freshAccount().address }),
    ];
    expect(dedupeAccountsByAddress(input)).toEqual({
      accounts: input,
      dropped: 0,
    });
  });
});
