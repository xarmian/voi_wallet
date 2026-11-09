/**
 * TASK-435 — Network as a pushed screen: status refreshes on open, a confirmed
 * switch refreshes balances and goes back, a failed switch stays, and leaving
 * is blocked while a switch is in flight.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import NetworkSettingsScreen from '../NetworkSettingsScreen';

type BeforeRemove = (event: { preventDefault: () => void }) => void;
let mockBeforeRemove: BeforeRemove | undefined;
let mockFocused = true;
const mockNavigation = {
  goBack: jest.fn(),
  setOptions: jest.fn(),
  isFocused: () => mockFocused,
  addListener: jest.fn((name: string, listener: BeforeRemove) => {
    if (name === 'beforeRemove') mockBeforeRemove = listener;
    return () => {};
  }),
};
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
}));

let mockIsSwitching = false;
const mockSwitchNetwork = jest.fn();
const mockRefreshNetworkStatus = jest.fn();
jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => 'voi-mainnet',
  useAvailableNetworks: () => ['voi-mainnet', 'algorand-mainnet'],
  useIsNetworkSwitching: () => mockIsSwitching,
  useNetworkStore: Object.assign(
    () => ({
      switchNetwork: mockSwitchNetwork,
      refreshNetworkStatus: mockRefreshNetworkStatus,
    }),
    { getState: () => ({ status: {}, isSwitching: mockIsSwitching }) }
  ),
}));
const mockRefreshAllBalances = jest.fn();
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: object) => unknown) =>
    selector({ refreshAllBalances: mockRefreshAllBalances }),
}));
jest.mock('@/services/network/config', () => ({
  getNetworkConfig: (id: string) => ({
    name: id === 'voi-mainnet' ? 'Voi' : 'Algorand',
    currency: 'X',
    currencyName: 'X',
    color: '#000',
    features: {},
  }),
  getNetworkDisplayName: (id: string) =>
    id === 'voi-mainnet' ? 'Voi' : 'Algorand',
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
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(() => {
  mockBeforeRemove = undefined;
  mockFocused = true;
  mockIsSwitching = false;
  mockNavigation.goBack.mockReset();
  mockNavigation.setOptions.mockReset();
  mockSwitchNetwork.mockReset().mockResolvedValue(undefined);
  mockRefreshNetworkStatus.mockReset().mockResolvedValue(undefined);
  mockRefreshAllBalances.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

const confirmSwitch = async (alert: jest.SpyInstance) => {
  const buttons = alert.mock.calls.at(-1)?.[2];
  const confirm = buttons?.find((b: { text: string }) => b.text === 'Switch');
  expect(confirm).toBeDefined();
  await act(async () => {
    await confirm.onPress();
  });
};

it('refreshes every network status once on open', async () => {
  await render(<NetworkSettingsScreen />);

  expect(mockRefreshNetworkStatus).toHaveBeenCalledTimes(2);
  expect(mockRefreshNetworkStatus).toHaveBeenCalledWith('voi-mainnet');
  expect(mockRefreshNetworkStatus).toHaveBeenCalledWith('algorand-mainnet');
});

it('switches, refreshes balances, then goes back', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const view = await render(<NetworkSettingsScreen />);

  await fireEvent.press(view.getByText('Algorand'));
  await confirmSwitch(alert);

  expect(mockSwitchNetwork).toHaveBeenCalledWith('algorand-mainnet');
  expect(mockRefreshAllBalances).toHaveBeenCalledTimes(1);
  expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
});

it('does not go back when the user already left during the refresh', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockRefreshAllBalances.mockImplementation(async () => {
    mockFocused = false;
  });
  const view = await render(<NetworkSettingsScreen />);

  await fireEvent.press(view.getByText('Algorand'));
  await confirmSwitch(alert);

  expect(mockNavigation.goBack).not.toHaveBeenCalled();
});

it('stays on the screen when the switch fails', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockSwitchNetwork.mockRejectedValue(new Error('node down'));
  const view = await render(<NetworkSettingsScreen />);

  await fireEvent.press(view.getByText('Algorand'));
  await confirmSwitch(alert);

  expect(alert).toHaveBeenLastCalledWith(
    'Network Switch Failed',
    'node down',
    expect.any(Array)
  );
  expect(mockNavigation.goBack).not.toHaveBeenCalled();
});

it('blocks leaving, and the swipe gesture, while a switch is in flight', async () => {
  mockIsSwitching = true;
  await render(<NetworkSettingsScreen />);

  const preventDefault = jest.fn();
  mockBeforeRemove?.({ preventDefault });
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
    gestureEnabled: false,
  });
});

it('lets the user leave when no switch is in flight', async () => {
  await render(<NetworkSettingsScreen />);

  const preventDefault = jest.fn();
  mockBeforeRemove?.({ preventDefault });
  expect(mockBeforeRemove).toBeDefined();
  expect(preventDefault).not.toHaveBeenCalled();
  expect(mockNavigation.setOptions).toHaveBeenLastCalledWith({
    gestureEnabled: true,
  });
});
