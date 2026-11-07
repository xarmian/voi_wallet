/**
 * TASK-421 U4d review: markBackupVerified must merge only the backup fields
 * onto the store's CURRENT record of the same identity. Replacing the whole
 * record with the service's result could regress a conversion or rekey update
 * that reached the store while the write was queued.
 *
 * The heavy service graph is mocked exactly as the sibling walletStore specs do.
 */

const mockMarkBackupVerified = jest.fn();

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getCurrentNetworkId: () => 'voi-mainnet',
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    markBackupVerified: (...args: unknown[]) => mockMarkBackupVerified(...args),
    getCurrentWallet: jest.fn(async () => null),
    getAccount: jest.fn(async () => null),
    updateAccountMetadata: jest.fn(async () => {}),
  },
}));
jest.mock('@/services/wallet/rekeyManager', () => ({
  __esModule: true,
  default: {},
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
    getDeviceId: jest.fn(() => null),
    unsubscribeAccount: jest.fn(async () => true),
  },
  DEFAULT_NOTIFICATION_PREFERENCES: {},
}));

jest.mock('@/services/realtime', () => ({
  realtimeService: {
    addAddress: jest.fn(),
    removeAddress: jest.fn(),
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
import { AccountType } from '@/types/wallet';

const ADDRESS = 'A'.repeat(58);
const OTHER = 'B'.repeat(58);

describe('walletStore.markBackupVerified — merges backup fields only (TASK-421 U4d)', () => {
  beforeEach(() => {
    mockMarkBackupVerified.mockReset();
  });

  it('keeps a conversion the store already holds', async () => {
    // The store already reflects a conversion to STANDARD; the service hands
    // back an older REKEYED view of the same account.
    useWalletStore.setState({
      wallet: {
        accounts: [
          { id: 'acct-1', address: ADDRESS, type: AccountType.STANDARD },
          { id: 'acct-2', address: OTHER, type: AccountType.STANDARD },
        ],
      } as never,
    });
    mockMarkBackupVerified.mockResolvedValue({
      id: 'acct-1',
      address: ADDRESS,
      type: AccountType.REKEYED,
      authAddress: OTHER,
      canSign: true,
      backupVerified: true,
      backupCreatedAt: '2026-10-28T00:00:00.000Z',
    });

    await useWalletStore.getState().markBackupVerified('acct-1', ADDRESS);

    expect(mockMarkBackupVerified).toHaveBeenCalledWith('acct-1', ADDRESS);
    const [first, second] = useWalletStore.getState().wallet!.accounts;
    expect(first).toEqual({
      id: 'acct-1',
      address: ADDRESS,
      type: AccountType.STANDARD,
      backupVerified: true,
      backupCreatedAt: '2026-10-28T00:00:00.000Z',
    });
    expect(second).toEqual({
      id: 'acct-2',
      address: OTHER,
      type: AccountType.STANDARD,
    });
  });

  it.each([
    ['a different address', { address: OTHER, type: AccountType.REKEYED }],
    ['a keyless type', { address: ADDRESS, type: AccountType.WATCH }],
  ])('leaves the store record alone when it now has %s', async (_l, rec) => {
    useWalletStore.setState({
      wallet: { accounts: [{ id: 'acct-1', ...rec }] } as never,
    });
    mockMarkBackupVerified.mockResolvedValue({
      id: 'acct-1',
      address: ADDRESS,
      type: AccountType.REKEYED,
      backupVerified: true,
      backupCreatedAt: '2026-10-28T00:00:00.000Z',
    });

    await useWalletStore.getState().markBackupVerified('acct-1', ADDRESS);

    expect(useWalletStore.getState().wallet!.accounts[0]).toEqual({
      id: 'acct-1',
      ...rec,
    });
  });
});
