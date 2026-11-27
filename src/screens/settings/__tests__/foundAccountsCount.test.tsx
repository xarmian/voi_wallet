/**
 * TASK-478: the Settings row and the Home notice count found keys the same way.
 * One ready address holding two copies, plus one in-wallet copy, is one
 * account on both surfaces.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import SettingsScreen from '../SettingsScreen';
import FoundAccountsNoticeHost from '@/components/account/FoundAccountsNoticeHost';
import { AccountMetadata, AccountType } from '@/types/wallet';
import type { FoundSummary } from '@/services/secure/foundAccounts';
import { actionableOf } from '@/services/secure/foundAccountsCount';

const READY = 'AAAAREADYADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET = 'BBBBWALLETADDRESSBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const mockSummary: FoundSummary = {
  hasPin: true,
  presentCount: 3,
  rows: [
    { kind: 'ready', id: 'r1', ids: ['r1', 'r2'], address: READY },
    {
      kind: 'in-wallet',
      id: 'w1',
      address: WALLET,
      walletLabel: 'Main',
      walletType: AccountType.STANDARD,
      walletHasKey: true,
    },
  ],
  unreadableIds: [],
  unscannedIds: [],
};

const mockActive = {
  id: 'a',
  address: 'ADDR',
  type: AccountType.STANDARD,
  label: 'Alice',
} as AccountMetadata;
const mockNavigation = { navigate: jest.fn(), goBack: jest.fn() };
jest.mock('@/hooks/useFoundAccountsSummary', () => ({
  useFoundAccountsSummary: () => ({
    summary: mockSummary,
    error: false,
    reload: jest.fn(),
  }),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
}));
jest.mock('@/store/walletStore', () => ({
  useActiveAccount: () => mockActive,
  useAccounts: () => [mockActive],
  useWalletSettings: () => ({}),
  useWalletStore: Object.assign(
    (selector: (state: object) => unknown) => selector({}),
    { getState: () => ({ wallet: { accounts: [mockActive] } }) }
  ),
}));
jest.mock('@/store/networkStore', () => ({
  useIsCurrentNetworkHealthy: () => true,
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    probeSecretPresenceStrict: jest.fn(),
    readFoundNoticeSeen: jest.fn(async () => []),
    markFoundNoticeSeen: jest.fn(async () => {}),
  },
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => false,
}));
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated/mock');
  return { ...actual, __esModule: true, default: actual.default ?? actual };
});
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/account/AccountListModal', () => () => null);
jest.mock('@/components/account/AddAccountModal', () => () => null);
jest.mock('@/components/account/RenameAccountModal', () => () => null);
jest.mock('@/components/network/NetworkIndicator', () => () => null);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/GlassCard', () => ({
  GlassCard: ({ children }: { children: React.ReactNode }) => children,
}));

it('an in-wallet copy whose wallet account has no key counts; one with a key does not', () => {
  const onlyCopy: FoundSummary = {
    ...mockSummary,
    presentCount: 2,
    rows: [
      {
        kind: 'in-wallet',
        id: 'w2',
        address: READY,
        walletLabel: 'Watched',
        walletType: AccountType.WATCH,
        walletHasKey: false,
      },
      mockSummary.rows[1],
    ],
  };
  // The watch account's found key is its only usable copy: Settings must
  // still list it, and the notice must announce it.
  expect(actionableOf(onlyCopy)).toEqual({
    count: 1,
    ids: ['w2'],
    address: READY,
  });
});

it('Settings and Home show the same count', async () => {
  const settings = await render(<SettingsScreen />);
  expect(settings.getByText('1 account found on this device')).toBeTruthy();
  settings.unmount();

  const home = await render(<FoundAccountsNoticeHost onReview={jest.fn()} />);
  await home.findByText('1 account found on this device');
});
