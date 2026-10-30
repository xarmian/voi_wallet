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
let mockHold: Promise<void> | undefined;
let mockIssued = 0;
const mockStamp = (info: object) => {
  const { issueRekeyObservation, stampRekeyInfo } = jest.requireActual(
    '@/services/network/rekeyObservation'
  );
  return stampRekeyInfo(info, issueRekeyObservation());
};
let mockRekeyState: object = { status: 'loading' };
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (network: string) => ({
      getAccountBalance: async (address: string) => {
        // Captured and stamped at issue, as NetworkService.getAccountRekeyInfo
        // does; a held response lands later with its original stamp.
        const rekeyInfo = mockStamp({ ...mockChain[network] });
        mockIssued++;
        if (mockHold) await mockHold;
        return { address, amount: 1n, minBalance: 0n, assets: [], rekeyInfo };
      },
    }),
  },
}));
let mockMappingHold: Promise<void> | undefined;
jest.mock('@/services/token-mapping', () => ({
  __esModule: true,
  default: {
    getTokenMappings: async () => {
      if (mockMappingHold) await mockMappingHold;
      return [];
    },
  },
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
  useRekeyState: () => mockRekeyState,
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
// Custody is unconfirmed until chain state loads, so the label never implies
// a key (Codex pass B #2).
const CHECKING = 'Rekeyed (Checking)';

beforeEach(() => {
  clearRekeyDisplayStatus();
  mockStoreAccounts = [standard];
  mockChain['voi-mainnet'] = { isRekeyed: false };
  mockChain['algorand-mainnet'] = { isRekeyed: false };
  mockAsyncSet.mockReset();
  mockRekeyState = { status: 'loading' };
  mockHold = undefined;
  mockIssued = 0;
  mockMappingHold = undefined;
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
  expect(view.getByText(CHECKING)).toBeTruthy();
  expect(view.queryByText('Rekeyed')).toBeNull();

  expect(standard.type).toBe(AccountType.STANDARD);
  expect(mockUpdateMetadata).not.toHaveBeenCalled();
  expect(mockPlatformSet).not.toHaveBeenCalled();
  expect(mockAsyncSet).not.toHaveBeenCalled();
});

it('a failed refresh keeps the last known badge', async () => {
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  const view = await render(row());
  await refresh();
  expect(view.getByText(CHECKING)).toBeTruthy();
  mockChain['voi-mainnet'] = { isRekeyed: false, unavailable: true };
  await refresh();
  expect(view.getByText(CHECKING)).toBeTruthy();
});

it('a rekey on another network does not label this network', async () => {
  mockChain['algorand-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  const view = await render(row());
  await refresh();
  expect(view.queryByText('Rekeyed')).toBeNull();
  expect(view.queryByText(CHECKING)).toBeNull();
});

// Codex pass B #1: a loaded self snapshot must not mask a newer refresh.
it('a newer refresh overrides a loaded self snapshot, custody neutral', async () => {
  mockRekeyState = { status: 'loaded', isRekeyed: false, canSign: true };
  const view = await render(row());
  await refresh();
  expect(view.queryByText(CHECKING)).toBeNull();
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  await refresh();
  expect(view.getByText(CHECKING)).toBeTruthy();
});

it('an agreeing loaded snapshot keeps its confirmed custody label', async () => {
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  mockRekeyState = {
    status: 'loaded',
    isRekeyed: true,
    authAddress: 'OUTSIDE',
    canSign: false,
  };
  const view = await render(row());
  await refresh();
  expect(view.getByText('Rekeyed (No Key)')).toBeTruthy();
});

// Codex pass C #3/#4 (ported from its harness, with reads stamped at issue).
it('an older refresh landing late never overwrites a newer rekey', async () => {
  let release!: () => void;
  mockHold = new Promise<void>((resolve) => (release = resolve));
  const older = MultiNetworkBalanceService.getAggregatedBalance(
    standard.address
  );
  mockHold = undefined;
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  await refresh();
  const view = await render(row());
  expect(view.getByText(CHECKING)).toBeTruthy();
  await act(async () => {
    release();
    await older;
  });
  expect(view.getByText(CHECKING)).toBeTruthy();
});

it('a refresh issued before a wipe/reset never repopulates the cleared status', async () => {
  const { invalidateRekeyStatus } =
    await import('@/services/wallet/rekeyStatusInvalidation');
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  let release!: () => void;
  mockHold = new Promise<void>((resolve) => (release = resolve));
  const inFlight = MultiNetworkBalanceService.getAggregatedBalance(
    standard.address
  );
  // The reads must be ISSUED (stamped) before the reset for this case.
  while (mockIssued < 2) await act(async () => {});
  await act(async () => invalidateRekeyStatus());
  await act(async () => {
    release();
    await inFlight;
  });
  const view = await render(row());
  expect(view.queryByText(CHECKING)).toBeNull();
});

// A read issued AFTER the reset is a genuine post-reset chain observation, so
// it is recorded (Codex pass C #4 reduces to this once reads are stamped at
// issue).
it('a read issued after a reset is a fresh observation and is recorded', async () => {
  const { invalidateRekeyStatus } =
    await import('@/services/wallet/rekeyStatusInvalidation');
  await act(async () => invalidateRekeyStatus());
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  await refresh();
  const view = await render(row());
  expect(view.getByText(CHECKING)).toBeTruthy();
});

// Codex pass D #2: a refresh begun before a wipe/reset, still waiting on token
// mappings, issues its reads after the reset; the operation fence still drops
// them.
it('a refresh begun before a reset never writes, even if it reads after it', async () => {
  const { invalidateRekeyStatus } =
    await import('@/services/wallet/rekeyStatusInvalidation');
  mockChain['voi-mainnet'] = { isRekeyed: true, authAddress: 'OUTSIDE' };
  let release!: () => void;
  mockMappingHold = new Promise<void>((resolve) => (release = resolve));
  const stale = MultiNetworkBalanceService.getAggregatedBalance(
    standard.address
  );
  await act(async () => invalidateRekeyStatus());
  expect(mockIssued).toBe(0);
  await act(async () => {
    release();
    await stale;
  });
  expect(mockIssued).toBe(2);
  const view = await render(row());
  expect(view.queryByText(CHECKING)).toBeNull();
});
