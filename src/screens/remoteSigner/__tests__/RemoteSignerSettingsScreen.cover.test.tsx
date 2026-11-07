import React from 'react';
import { Alert } from 'react-native';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import { resetCoverForTests, setCovered } from '@/utils/lockCover';

let mockModalVisible: boolean | undefined;
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  const descriptors = Object.getOwnPropertyDescriptors(native);
  descriptors.Modal = {
    configurable: true,
    enumerable: true,
    value: (props: React.ComponentProps<typeof native.Modal>) => {
      mockModalVisible = props.visible;
      return require('react').createElement(native.Modal, props);
    },
  };
  return Object.defineProperties({}, descriptors);
});

const mockInitializeSignerConfig = jest.fn<Promise<void>, [string]>();
const mockSetAppMode = jest.fn<Promise<void>, [string]>();
const mockRemoteSignerState = {
  initialize: jest.fn(),
  setAppMode: mockSetAppMode,
  initializeSignerConfig: mockInitializeSignerConfig,
  updateSignerDeviceName: jest.fn(),
};
jest.mock('@/store/remoteSignerStore', () => ({
  useRemoteSignerStore: (
    selector: (state: typeof mockRemoteSignerState) => unknown
  ) => selector(mockRemoteSignerState),
  useRemoteSignerInitialized: () => true,
  useAppMode: () => 'wallet',
  useSignerConfig: () => null,
  usePairedSignersArray: () => [],
}));
const mockAccounts: never[] = [];
const mockWalletState = { refresh: jest.fn() };
jest.mock('@/store/walletStore', () => ({
  useAccounts: () => mockAccounts,
  useWalletStore: (selector: (state: typeof mockWalletState) => unknown) =>
    selector(mockWalletState),
}));
jest.mock('@/hooks/useOwnKeyAccounts', () => ({
  useOwnKeyAccounts: () => mockAccounts,
}));
jest.mock('@/services/wallet/ownKeyCustody', () => ({
  filterTransferableAccounts: jest.fn(),
}));
jest.mock('expo-updates', () => ({ reloadAsync: jest.fn() }));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/hooks/useThemedStyles', () => ({ useThemedStyles: () => ({}) }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/account/AccountListModal', () => () => null);
jest.mock('@/components/remoteSigner/TransferToAirgapFlow', () => ({
  TransferToAirgapFlow: () => null,
}));

import RemoteSignerSettingsScreen from '../RemoteSignerSettingsScreen';

beforeEach(() => {
  resetCoverForTests();
  mockModalVisible = undefined;
  mockInitializeSignerConfig.mockResolvedValue(undefined);
  mockSetAppMode.mockResolvedValue(undefined);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(async () => {
  await cleanup();
  resetCoverForTests();
  jest.restoreAllMocks();
});

async function openSetup() {
  const view = await render(<RemoteSignerSettingsScreen />);
  expect(mockModalVisible).toBe(false);
  await fireEvent.press(view.getByText('Signer Mode'));
  expect(view.getByText('Set Up Signer Mode')).toBeTruthy();
  await fireEvent.changeText(
    view.getByPlaceholderText('e.g., My Secure Phone'),
    'Test signer'
  );
  return view;
}

it('DEFECT: hides the setup Modal while covered and restores it uncovered', async () => {
  const view = await openSetup();
  expect(mockModalVisible).toBe(true);
  await act(async () => setCovered(true));
  expect(mockModalVisible).toBe(false);
  await act(async () => setCovered(false));
  expect(mockModalVisible).toBe(true);
  expect(view.getByPlaceholderText('e.g., My Secure Phone').props.value).toBe(
    'Test signer'
  );
});

it('DEFECT: Set Up is absent covered and initializes exactly once uncovered', async () => {
  const view = await openSetup();
  await act(async () => setCovered(true));
  expect(view.queryByText('Set Up')).toBeNull();
  expect(mockInitializeSignerConfig).not.toHaveBeenCalled();
  expect(mockSetAppMode).not.toHaveBeenCalled();
  await act(async () => setCovered(false));
  await fireEvent.press(view.getByText('Set Up'));
  expect(mockInitializeSignerConfig).toHaveBeenCalledTimes(1);
  expect(mockInitializeSignerConfig).toHaveBeenCalledWith('Test signer');
  expect(mockSetAppMode).toHaveBeenCalledTimes(1);
  expect(mockSetAppMode).toHaveBeenCalledWith('signer');
  expect(mockModalVisible).toBe(false);
});

it('REGRESSION: pending setup survives cover transitions and finishes exactly once', async () => {
  let finishSetup!: () => void;
  const pendingSetup = new Promise<void>((resolve) => {
    finishSetup = resolve;
  });
  mockInitializeSignerConfig.mockReturnValueOnce(pendingSetup);
  const view = await openSetup();
  // fireEvent awaits the async handler, so drive the cover concurrently while
  // still awaiting the press through completion.
  await Promise.all([
    (async () => {
      await fireEvent.press(view.getByText('Set Up'));
    })(),
    (async () => {
      // Let fireEvent finish its act scope before starting another one.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(mockInitializeSignerConfig).toHaveBeenCalledTimes(1);
      expect(mockSetAppMode).not.toHaveBeenCalled();
      await act(async () => setCovered(true));
      await act(async () => setCovered(false));
      expect(mockModalVisible).toBe(true);
      expect(mockSetAppMode).not.toHaveBeenCalled();
      await act(async () => setCovered(true));
      await act(async () => {
        finishSetup();
        await pendingSetup;
      });
    })(),
  ]);
  expect(mockSetAppMode).toHaveBeenCalledTimes(1);
  expect(mockSetAppMode).toHaveBeenCalledWith('signer');
  await act(async () => setCovered(false));
  expect(mockModalVisible).toBe(false);
  expect(view.queryByText('Set Up Signer Mode')).toBeNull();
  expect(mockInitializeSignerConfig).toHaveBeenCalledTimes(1);
  expect(mockSetAppMode).toHaveBeenCalledTimes(1);
});
