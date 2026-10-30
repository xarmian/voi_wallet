// TASK-458 (director ruling, 10-30): an external rekey (made outside the
// wallet) shows on the badge after the next normal refresh, with no persisted
// write. The refresh is the real MultiNetworkBalanceService feed; only the
// chain (getAccountBalance) and storage are mocked.
import React from 'react';
import { act, render } from '@testing-library/react-native';
import AccountListItem from '../AccountListItem';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { MultiNetworkBalanceService } from '@/services/network/multi-network';
import { clearRekeyDisplayStatus } from '@/store/rekeyDisplayStatus';

const mockChain: Record<string, object> = {};
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (network: string) => ({
      getAccountBalance: async (address: string) => ({
        address,
        amount: 1n,
        minBalance: 0n,
        assets: [],
        rekeyInfo: mockChain[network],
      }),
    }),
  },
}));
jest.mock('@/services/token-mapping', () => ({
  __esModule: true,
  default: { getTokenMappings: async () => [] },
}));
// Persistence instruments: none of these may be written by a refresh.
const mockAsyncSet = jest.fn();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { setItem: (...a: unknown[]) => mockAsyncSet(...a) },
}));
const mockPlatformSet = jest.fn();
jest.mock('@/platform', () => ({
  storage: { setItem: (...a: unknown[]) => mockPlatformSet(...a) },
  secureStorage: { setItem: (...a: unknown[]) => mockPlatformSet(...a) },
}));
const mockUpdateMetadata = jest.fn();
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    updateAccountMetadata: (...a: unknown[]) => mockUpdateMetadata(...a),
  },
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { probeSecretPresenceStrict: jest.fn() },
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../AccountAvatar', () => () => null);
let mockStoreAccounts: AccountMetadata[] = [];
jest.mock('@/store/walletStore', () => ({
  useWalletStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ wallet: { accounts: mockStoreAccounts } }),
    { getState: () => ({ wallet: { accounts: mockStoreAccounts } }) }
  ),
  // Chain state for this network has not loaded: the badge must come from
  // the refresh's display status, not the STANDARD record.
  useRekeyState: () => ({ status: 'loading' }),
  useAccountBalance: () => ({ balance: undefined, isLoading: false }),
}));
jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => 'voi-mainnet',
  useCurrentNetworkConfig: () => ({ nativeToken: 'VOI' }),
}));

const standard = {
  id: 'acct',
  address: 'ORIGINAL_ADDRESS',
  type: AccountType.STANDARD,
} as AccountMetadata;
const row = () => (
  <AccountListItem account={standard} isActive={false} onSelect={jest.fn()} />
);
const refresh = () =>
  act(async () => {
    await MultiNetworkBalanceService.getAggregatedBalance(standard.address);
  });

beforeEach(() => {
  clearRekeyDisplayStatus();
  mockStoreAccounts = [standard];
  mockChain['voi-mainnet'] = { isRekeyed: false };
  mockChain['algorand-mainnet'] = { isRekeyed: false };
  mockAsyncSet.mockReset();
  mockPlatformSet.mockReset();
  mockUpdateMetadata.mockReset();
});

it('external rekey, then refresh, then the badge reads Rekeyed, with no persisted write', async () => {
  const view = await render(row());
  await refresh();
  expect(view.queryByText('Rekeyed')).toBeNull();

  // Rekeyed outside the wallet: only the chain changes.
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  expect(view.queryByText('Rekeyed')).toBeNull();
  await refresh();
  expect(view.getByText('Rekeyed')).toBeTruthy();

  expect(standard.type).toBe(AccountType.STANDARD);
  expect(mockUpdateMetadata).not.toHaveBeenCalled();
  expect(mockPlatformSet).not.toHaveBeenCalled();
  expect(mockAsyncSet).not.toHaveBeenCalled();
});

it('a failed refresh keeps the last known badge', async () => {
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  const view = await render(row());
  await refresh();
  expect(view.getByText('Rekeyed')).toBeTruthy();
  mockChain['voi-mainnet'] = { isRekeyed: false, unavailable: true };
  await refresh();
  expect(view.getByText('Rekeyed')).toBeTruthy();
});

it('a rekey on another network does not label this network', async () => {
  mockChain['algorand-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  const view = await render(row());
  await refresh();
  expect(view.queryByText('Rekeyed')).toBeNull();
});
