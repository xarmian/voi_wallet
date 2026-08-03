// TASK-192: the deferred notification subscribe pass must be cancelled by ANY
// account deletion, not just the one that goes through walletStore.
//
// The store-level guard alone has a hole: AccountImportPreviewScreen's
// watch→standard upgrade calls MultiAccountWalletService.deleteAccount
// directly, bypassing walletStore entirely. A boot-time subscribe pass in
// flight at that moment holds a snapshot in which the address is still a WATCH
// account, and its single batched write would land afterwards. Invalidating at
// the service — the chokepoint every deletion path funnels through — closes it.
//
// SECURITY NOTE: no static/committed secret material. The account address here
// is generated fresh in-process by algosdk.

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

// Heavy/native side of the dependency graph; deleteAccount itself only touches
// storage + the secure-storage delete mocked below.
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));

const mockSecureDeleteAccount = jest.fn(async (_id: string) => {});

jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    deleteAccount: (id: string) => mockSecureDeleteAccount(id),
  },
}));

import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import { MultiAccountWalletService } from '../index';
import {
  isAccountSubscribeTokenCurrent,
  takeAccountSubscribeToken,
} from '@/services/notifications/subscribePass';

const WALLET_KEY = 'voi_wallet_metadata';

const seedWallet = (): void => {
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
        type: 'watch',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
};

describe('MultiAccountWalletService.deleteAccount — cancels the deferred subscribe pass (TASK-192)', () => {
  beforeEach(() => {
    mockStore = {};
    mockSecureDeleteAccount.mockImplementation(async () => {});
    seedWallet();
  });

  it('invalidates an in-flight subscribe token before it touches storage, even when called outside walletStore', async () => {
    const inFlightToken = takeAccountSubscribeToken();
    expect(isAccountSubscribeTokenCurrent(inFlightToken)).toBe(true);

    // Sample liveness at the moment the secure delete runs. Asserting only
    // after the call resolves would also pass for an implementation that
    // invalidated last (or in a `finally`), leaving the deletion window open
    // for the batched write to land.
    let tokenLiveDuringDeletion: boolean | null = null;
    mockSecureDeleteAccount.mockImplementation(async () => {
      tokenLiveDuringDeletion = isAccountSubscribeTokenCurrent(inFlightToken);
    });

    // Exactly what AccountImportPreviewScreen's watch→standard upgrade does.
    await MultiAccountWalletService.deleteAccount('acc-1');

    expect(tokenLiveDuringDeletion).toBe(false);
    expect(isAccountSubscribeTokenCurrent(inFlightToken)).toBe(false);
  });

  it('invalidates before the deletion can fail part-way through', async () => {
    mockSecureDeleteAccount.mockImplementation(async () => {
      throw new Error('secure delete failed');
    });
    const inFlightToken = takeAccountSubscribeToken();

    await expect(
      MultiAccountWalletService.deleteAccount('acc-1')
    ).rejects.toThrow('secure delete failed');

    expect(isAccountSubscribeTokenCurrent(inFlightToken)).toBe(false);
  });
});
