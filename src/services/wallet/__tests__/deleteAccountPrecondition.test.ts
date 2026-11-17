// TASK-424: MultiAccountWalletService.deleteAccount re-validates what the
// caller checked (address, type, keyless) against its own wallet read before
// it deletes anything, and hands a keyless deletion's custody re-check to the
// secure store, which runs it under the key-mutation mutex.
//
// SECURITY NOTE: no static/committed secret material. Addresses are generated
// fresh in-process by algosdk.

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

jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));

const mockSecureDeleteAccount = jest.fn(
  async (_id: string, _options?: { requireNoSecret?: boolean }) => {}
);

jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    deleteAccount: (id: string, options?: { requireNoSecret?: boolean }) =>
      mockSecureDeleteAccount(id, options),
  },
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import { MultiAccountWalletService } from '../index';
import { AccountDeletionPreconditionError, AccountType } from '@/types/wallet';

const WALLET_KEY = 'voi_wallet_metadata';

let address = '';
let otherAddress = '';

const seedWallet = (type: AccountType): void => {
  const account = algosdk.generateAccount();
  address = account.addr.toString();
  otherAddress = algosdk.generateAccount().addr.toString();
  mockStore[WALLET_KEY] = JSON.stringify({
    id: 'wallet-1',
    version: '1.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    activeAccountId: 'acc-1',
    accounts: [
      {
        id: 'acc-1',
        address,
        publicKey: Buffer.from(account.addr.publicKey).toString('hex'),
        type,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
};

const storedIds = (): string[] =>
  JSON.parse(mockStore[WALLET_KEY]).accounts.map((a: { id: string }) => a.id);

describe('MultiAccountWalletService.deleteAccount — caller expectation (TASK-424)', () => {
  beforeEach(() => {
    mockStore = {};
    mockSecureDeleteAccount.mockReset();
    mockSecureDeleteAccount.mockImplementation(async () => {});
  });

  it.each([
    ['the address differs', () => otherAddress, AccountType.WATCH],
    ['the type differs', () => address, AccountType.STANDARD],
  ])(
    'refuses, touching nothing, when %s',
    async (_case, expectedAddress, expectedType) => {
      seedWallet(AccountType.WATCH);
      await expect(
        MultiAccountWalletService.deleteAccount('acc-1', {
          address: expectedAddress(),
          type: expectedType,
          keyless: true,
        })
      ).rejects.toBeInstanceOf(AccountDeletionPreconditionError);
      expect(mockSecureDeleteAccount).not.toHaveBeenCalled();
      expect(storedIds()).toEqual(['acc-1']);
    }
  );

  it('refuses when the account is no longer in the wallet', async () => {
    seedWallet(AccountType.WATCH);
    await expect(
      MultiAccountWalletService.deleteAccount('acc-gone', {
        address,
        type: AccountType.WATCH,
        keyless: true,
      })
    ).rejects.toBeInstanceOf(AccountDeletionPreconditionError);
    expect(mockSecureDeleteAccount).not.toHaveBeenCalled();
  });

  it('a keyless deletion asks the secure store to re-check custody', async () => {
    seedWallet(AccountType.WATCH);
    await MultiAccountWalletService.deleteAccount('acc-1', {
      address,
      type: AccountType.WATCH,
      keyless: true,
    });
    expect(mockSecureDeleteAccount).toHaveBeenCalledWith('acc-1', {
      requireNoSecret: true,
    });
    expect(storedIds()).toEqual([]);
  });

  it('a key-holding deletion confirmed as such does not require absence', async () => {
    seedWallet(AccountType.STANDARD);
    await MultiAccountWalletService.deleteAccount('acc-1', {
      address,
      type: AccountType.STANDARD,
      keyless: false,
    });
    expect(mockSecureDeleteAccount).toHaveBeenCalledWith('acc-1', {
      requireNoSecret: false,
    });
    expect(storedIds()).toEqual([]);
  });

  it('keeps the wallet entry when the secure store refuses', async () => {
    seedWallet(AccountType.WATCH);
    mockSecureDeleteAccount.mockImplementation(async () => {
      throw new AccountDeletionPreconditionError();
    });
    await expect(
      MultiAccountWalletService.deleteAccount('acc-1', {
        address,
        type: AccountType.WATCH,
        keyless: true,
      })
    ).rejects.toBeInstanceOf(AccountDeletionPreconditionError);
    expect(storedIds()).toEqual(['acc-1']);
  });
});
