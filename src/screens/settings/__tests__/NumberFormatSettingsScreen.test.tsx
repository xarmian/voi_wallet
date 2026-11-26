/**
 * TASK-435 — Number Format as a pushed screen: a saved choice goes back, a
 * failed save stays with an alert, and a double tap saves once.
 */

import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import NumberFormatSettingsScreen from '../NumberFormatSettingsScreen';

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));
const mockUpdate = jest.fn();
jest.mock('@/store/walletStore', () => ({
  useWalletSettings: () => ({ numberLocale: null }),
  useWalletStore: (selector: (state: object) => unknown) =>
    selector({ updateWalletSettings: mockUpdate }),
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
  mockGoBack.mockReset();
  mockUpdate.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it('saves the choice, then goes back', async () => {
  const view = await render(<NumberFormatSettingsScreen />);

  await act(async () => {
    fireEvent.press(view.getByText('German (Germany)'));
  });

  expect(mockUpdate).toHaveBeenCalledWith({ numberLocale: 'de-DE' });
  expect(mockGoBack).toHaveBeenCalledTimes(1);
});

it('stays on the screen with an alert when the save fails', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockUpdate.mockRejectedValue(new Error('disk full'));
  const view = await render(<NumberFormatSettingsScreen />);

  await act(async () => {
    fireEvent.press(view.getByText('German (Germany)'));
  });

  expect(alert).toHaveBeenCalledWith('Error', 'disk full');
  expect(mockGoBack).not.toHaveBeenCalled();
});

it('ignores a second tap while the first save is in flight', async () => {
  let resolve!: () => void;
  mockUpdate.mockReturnValue(
    new Promise<void>((r) => {
      resolve = r;
    })
  );
  const view = await render(<NumberFormatSettingsScreen />);

  await act(async () => {
    fireEvent.press(view.getByText('German (Germany)'));
    fireEvent.press(view.getByText('French (France)'));
  });
  await act(async () => resolve());

  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(mockUpdate).toHaveBeenCalledWith({ numberLocale: 'de-DE' });
  expect(mockGoBack).toHaveBeenCalledTimes(1);
});
