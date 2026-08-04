/**
 * TASK-192: deleting an account must cancel any in-flight deferred notification
 * subscribe pass.
 *
 * This is the path the service-boot teardown does NOT cover. That pass is
 * launched fire-and-forget at app start over a `wallet.accounts` snapshot and,
 * now that it ends in one batched write, finishes long after the snapshot was
 * taken. Delete an account in that window and the session is still mounted —
 * nothing unmounts, so no teardown fires — yet the pending write still names
 * the deleted address and would re-create its subscription (and with it, push
 * notifications for an account the user just removed).
 *
 * The heavy service graph is mocked exactly as the sibling walletStore specs do;
 * only the deletion path carries behaviour here.
 */

const mockDeleteAccount = jest.fn(async (_id: string) => {});
const mockGetCurrentWallet = jest.fn(async () => ({
  id: 'wallet-1',
  accounts: [] as unknown[],
}));
const mockUnsubscribeAccount = jest.fn(async (_address: string) => true);
const mockGetDeviceId = jest.fn((): string | null => 'device-1');
const mockRemoveAddress = jest.fn();

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getCurrentNetworkId: () => 'voi-mainnet',
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    deleteAccount: (id: string) => mockDeleteAccount(id),
    getCurrentWallet: () => mockGetCurrentWallet(),
    getAccount: jest.fn(async () => null),
    updateAccountMetadata: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/wallet/rekeyManager', () => ({
  __esModule: true,
  default: { updateAccountWithRekeyInfo: jest.fn() },
}));

jest.mock('@/services/envoi', () => ({ __esModule: true, default: {} }));
jest.mock('@/services/mimir', () => ({ MimirApiService: {} }));
jest.mock('@/services/token-mapping', () => ({
  __esModule: true,
  default: {},
  TokenMappingService: {},
}));
jest.mock('@/services/network/multi-network', () => ({
  MultiNetworkBalanceService: { getAggregatedBalance: jest.fn() },
}));

jest.mock('@/services/notifications', () => ({
  notificationService: {
    getDeviceId: () => mockGetDeviceId(),
    unsubscribeAccount: (address: string) => mockUnsubscribeAccount(address),
  },
  DEFAULT_NOTIFICATION_PREFERENCES: {},
}));

jest.mock('@/services/realtime', () => ({
  realtimeService: {
    addAddress: jest.fn(),
    removeAddress: (address: string) => mockRemoveAddress(address),
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => {}),
  },
}));

import { useWalletStore } from '../walletStore';
import {
  isAccountSubscribeTokenCurrent,
  takeAccountSubscribeToken,
} from '@/services/notifications/subscribePass';

const ADDRESS = 'A'.repeat(58);

describe('walletStore.deleteAccount — cancels the deferred subscribe pass (TASK-192)', () => {
  beforeEach(() => {
    mockDeleteAccount.mockImplementation(async () => {});
    mockGetCurrentWallet.mockImplementation(async () => ({
      id: 'wallet-1',
      accounts: [],
    }));
    mockGetDeviceId.mockReturnValue('device-1');
    useWalletStore.setState({
      wallet: {
        accounts: [{ id: 'acct-1', address: ADDRESS }],
      } as never,
      accountStates: {},
    });
  });

  it('invalidates BEFORE the deletion starts, not merely by the time it finishes', async () => {
    // The token a boot-time pass would be holding right now.
    const inFlightToken = takeAccountSubscribeToken();
    expect(isAccountSubscribeTokenCurrent(inFlightToken)).toBe(true);

    // Sample the token's liveness at the instant the deletion begins. Asserting
    // only after `deleteAccount` resolves would also pass for an implementation
    // that invalidated in a `finally` — which would leave the whole deletion
    // window open for the batched write to land.
    let tokenLiveWhenDeletionStarted: boolean | null = null;
    mockDeleteAccount.mockImplementation(async () => {
      tokenLiveWhenDeletionStarted =
        isAccountSubscribeTokenCurrent(inFlightToken);
    });

    await useWalletStore.getState().deleteAccount('acct-1');

    expect(mockDeleteAccount).toHaveBeenCalledWith('acct-1');
    expect(mockUnsubscribeAccount).toHaveBeenCalledWith(ADDRESS);
    // Already stale when the deletion began...
    expect(tokenLiveWhenDeletionStarted).toBe(false);
    // ...and still stale afterwards.
    expect(isAccountSubscribeTokenCurrent(inFlightToken)).toBe(false);
  });

  it('invalidates even when the deletion itself fails', async () => {
    // Invalidation happens BEFORE the delete, so a failure part-way through
    // cannot leave a stale pass armed against a half-removed account.
    mockDeleteAccount.mockImplementation(async () => {
      throw new Error('storage write failed');
    });
    const inFlightToken = takeAccountSubscribeToken();

    await expect(
      useWalletStore.getState().deleteAccount('acct-1')
    ).rejects.toThrow('storage write failed');

    expect(isAccountSubscribeTokenCurrent(inFlightToken)).toBe(false);
  });

  it('does not leave future passes permanently blocked', async () => {
    await useWalletStore.getState().deleteAccount('acct-1');

    // A pass launched after the deletion takes a fresh token and is live.
    const nextToken = takeAccountSubscribeToken();
    expect(isAccountSubscribeTokenCurrent(nextToken)).toBe(true);
  });
});
