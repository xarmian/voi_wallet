// TASK-455 P7 — ChangePinScreen treats "no credential" as first-time setup and
// skips the current-PIN step. A credential read that FAILS must never land
// there: that would let a PIN be set without the current one.

import React from 'react';
import { Alert } from 'react-native';
import { render } from '@testing-library/react-native';
import ChangePinScreen from '../ChangePinScreen';
import { AccountSecureStorage } from '@/services/secure';

const mockGoBack = jest.fn();
// Stable across renders, like the real hook (the load effect depends on it).
const mockNavigation = { goBack: mockGoBack };
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    PASSPHRASE_MIN_LENGTH: 12,
    getCredentialSource: jest.fn(),
    setupPin: jest.fn(),
    changePin: jest.fn(),
  },
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ recheckAuthState: jest.fn() }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return { SafeAreaView: View };
});
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/common/UniversalHeader', () => () => null);
jest.mock('@/components/common/KeyboardAwareScrollView', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => (
      <View>{children}</View>
    ),
  };
});
jest.mock('@/components/common/PassphraseStrengthMeter', () => ({
  PassphraseStrengthMeter: () => null,
}));

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('a failed credential read asks for nothing new: no first-time setup, an alert that leaves', async () => {
  jest
    .mocked(AccountSecureStorage.getCredentialSource)
    .mockRejectedValueOnce(new Error('keychain unavailable'));

  const view = await render(<ChangePinScreen />);
  await flush();

  expect(view.queryByText('Create PIN')).toBeNull();
  expect(Alert.alert).toHaveBeenCalledWith(
    'Unable to Read Security Settings',
    expect.any(String),
    [expect.objectContaining({ text: 'OK' })]
  );
  const [{ onPress }] = jest.mocked(Alert.alert).mock.calls[0][2] as {
    onPress: () => void;
  }[];
  onPress();
  expect(mockGoBack).toHaveBeenCalled();
});

it('genuine absence is still first-time setup', async () => {
  jest
    .mocked(AccountSecureStorage.getCredentialSource)
    .mockResolvedValueOnce(null);

  const view = await render(<ChangePinScreen />);
  await flush();

  expect(view.getByText('Create PIN')).toBeTruthy();
  expect(Alert.alert).not.toHaveBeenCalled();
});

it('a stored PIN asks for the current one first', async () => {
  jest
    .mocked(AccountSecureStorage.getCredentialSource)
    .mockResolvedValueOnce('pin');

  const view = await render(<ChangePinScreen />);
  await flush();

  expect(view.getByText('Enter Current PIN')).toBeTruthy();
});
