/**
 * TASK-435 — the Number Format, Current Network and Theme rows push stack
 * screens like every other Settings row, instead of opening slide-up modals.
 * Fails against the pre-change SettingsScreen, where these presses only flip
 * modal-visibility state and never navigate.
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import SettingsScreen from '../SettingsScreen';
import { AccountMetadata, AccountType } from '@/types/wallet';

const mockActive = {
  id: 'a',
  address: 'ADDR',
  type: AccountType.STANDARD,
  label: 'Alice',
} as AccountMetadata;
const mockNavigate = jest.fn();
const mockNavigation = { navigate: mockNavigate, goBack: jest.fn() };
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
  AccountSecureStorage: { probeSecretPresenceStrict: jest.fn() },
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// Lets the pre-change screen's modals mount too, so the negative control
// fails on the navigate assertion rather than on a missing provider.
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
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

beforeEach(() => mockNavigate.mockReset());

it.each([
  ['Number Format', 'NumberFormatSettings'],
  ['Current Network', 'NetworkSettings'],
  ['Theme', 'ThemeSettings'],
])('the %s row pushes %s', async (label, route) => {
  const view = await render(<SettingsScreen />);

  await fireEvent.press(view.getByText(label));

  expect(mockNavigate).toHaveBeenCalledTimes(1);
  expect(mockNavigate).toHaveBeenCalledWith(route);
});
