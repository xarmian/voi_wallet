// TASK-425 U2: converting an account to a remote signer requires positive
// evidence that this device holds the account's own key. A REKEYED record that
// kept its key converts; one that didn't, and a WATCH, are refused before any
// key is deleted.
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
const mockIsRekeyed = jest.fn(async (_networkId: string) => false);
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId: string) => ({
      getAccountRekeyInfo: async () => ({
        isRekeyed: await mockIsRekeyed(networkId),
      }),
    }),
  },
}));

const mockSecureDeleteAccount = jest.fn(async (_id: string) => {});
const mockProbe = jest.fn(async (_id: string) => true);

jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    deleteAccount: (id: string) => mockSecureDeleteAccount(id),
    probeSecretPresenceStrict: (id: string) => mockProbe(id),
  },
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import { MultiAccountWalletService } from '../index';
import { AccountType } from '@/types/wallet';

const WALLET_KEY = 'voi_wallet_metadata';

const seedWallet = (type: AccountType): void => {
  const account = algosdk.generateAccount();
  mockStore[WALLET_KEY] = JSON.stringify({
    id: 'wallet-1',
    version: '1.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    activeAccountId: 'acc-1',
    accounts: [
      {
        id: 'acc-1',
        address: account.addr.toString(),
        publicKey: Buffer.from(account.addr.publicKey).toString('hex'),
        type,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
};

const storedType = (): string =>
  JSON.parse(mockStore[WALLET_KEY]).accounts[0].type;

describe('MultiAccountWalletService.convertStandardToRemoteSigner — own-key custody (TASK-425)', () => {
  beforeEach(() => {
    mockStore = {};
    mockSecureDeleteAccount.mockReset();
    mockProbe.mockReset();
    mockProbe.mockImplementation(async () => true);
    mockIsRekeyed.mockReset();
    mockIsRekeyed.mockImplementation(async () => false);
  });

  it.each([AccountType.STANDARD, AccountType.REKEYED])(
    'converts a %s account whose key is present',
    async (type) => {
      seedWallet(type);
      const converted =
        await MultiAccountWalletService.convertStandardToRemoteSigner(
          'acc-1',
          'device-1'
        );
      expect(converted.type).toBe(AccountType.REMOTE_SIGNER);
      expect(mockSecureDeleteAccount).toHaveBeenCalledWith('acc-1');
      expect(storedType()).toBe(AccountType.REMOTE_SIGNER);
    }
  );

  it.each([
    ['a REKEYED account without its key', AccountType.REKEYED, false],
    ['a WATCH account', AccountType.WATCH, true],
  ])('refuses %s, deleting nothing', async (_case, type, probe) => {
    seedWallet(type);
    mockProbe.mockImplementation(async () => probe);
    await expect(
      MultiAccountWalletService.convertStandardToRemoteSigner(
        'acc-1',
        'device-1'
      )
    ).rejects.toThrow(/Only an account whose key is on this device/);
    expect(mockSecureDeleteAccount).not.toHaveBeenCalled();
    expect(storedType()).toBe(type);
  });

  it('refuses a REKEYED account still rekeyed on chain, deleting nothing', async () => {
    seedWallet(AccountType.REKEYED);
    mockIsRekeyed.mockImplementation(async (n) => n === 'algorand-mainnet');
    await expect(
      MultiAccountWalletService.convertStandardToRemoteSigner(
        'acc-1',
        'device-1'
      )
    ).rejects.toThrow(/Only an account whose key is on this device/);
    expect(mockSecureDeleteAccount).not.toHaveBeenCalled();
    expect(storedType()).toBe(AccountType.REKEYED);
  });

  it('refuses when the custody probe errors', async () => {
    seedWallet(AccountType.REKEYED);
    mockProbe.mockImplementation(async () => {
      throw new Error('keychain timeout');
    });
    await expect(
      MultiAccountWalletService.convertStandardToRemoteSigner(
        'acc-1',
        'device-1'
      )
    ).rejects.toThrow(/Only an account whose key is on this device/);
    expect(mockSecureDeleteAccount).not.toHaveBeenCalled();
  });
});
