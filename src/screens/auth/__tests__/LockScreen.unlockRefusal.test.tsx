/**
 * TASK-469: an unlock refused because a wipe is pending is NOT an incorrect PIN.
 * A user with the right PIN mid-Delete-Everything must not be told it is wrong,
 * and the attempt counter must not move.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockUnlock = jest.fn();
const mockConsumeRefusal = jest.fn();
const mockGetThrottle = jest.fn();
const mockHaptic = jest.fn();

jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: { biometricEnabled: false },
    unlock: (...args: unknown[]) => mockUnlock(...args),
    unlockWithBiometrics: jest.fn(),
    recheckAuthState: jest.fn(),
    consumeUnlockRefusal: () => mockConsumeRefusal(),
  }),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    getPinThrottleState: (...args: unknown[]) => mockGetThrottle(...args),
    getCredentialSource: jest.fn(async () => 'pin'),
  },
}));
jest.mock('@/services/wipe', () => ({ wipeWalletData: jest.fn() }));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: jest.fn(),
  showWipeIncompleteNotice: jest.fn(),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ isFocused: () => true }),
}));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => new Proxy({}, { get: () => ({}) }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/utils/haptics', () => ({
  hapticNotify: (...args: unknown[]) => mockHaptic(...args),
}));

import LockScreen from '../LockScreen';

const enterPin = async () => {
  const view = await render(<LockScreen />);
  await act(async () => {});
  for (const digit of ['1', '2', '3', '4', '5', '6']) {
    await act(async () => {
      await fireEvent.press(view.getByText(digit));
    });
  }
  await act(async () => {});
  return view;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetThrottle.mockResolvedValue({
    lockedUntil: null,
    attemptsRemaining: 4,
  });
  mockConsumeRefusal.mockReturnValue(null);
});
afterEach(() => jest.restoreAllMocks());

test('a refused unlock (wipe pending) shows no "Incorrect PIN" and does not touch the throttle or haptics', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockUnlock.mockResolvedValue(false);
  mockConsumeRefusal.mockReturnValue('wipe_pending');
  await enterPin();
  expect(mockUnlock).toHaveBeenCalledTimes(1);
  expect(alert).not.toHaveBeenCalled();
  // The attempt counter is read only once, at mount: never re-read after the refusal.
  expect(mockGetThrottle).toHaveBeenCalledTimes(1);
  expect(mockHaptic).not.toHaveBeenCalledWith('error');
});

test('a genuinely wrong PIN still shows "Incorrect PIN" with the attempts remaining (control)', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockUnlock.mockResolvedValue(false);
  mockConsumeRefusal.mockReturnValue(null);
  await enterPin();
  expect(alert).toHaveBeenCalledWith(
    'Incorrect PIN',
    '4 attempts remaining',
    undefined
  );
  expect(mockGetThrottle).toHaveBeenCalledTimes(2);
  expect(mockHaptic).toHaveBeenCalledWith('error');
});

test('a successful unlock shows nothing', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockUnlock.mockResolvedValue(true);
  await enterPin();
  expect(alert).not.toHaveBeenCalled();
  expect(mockHaptic).toHaveBeenCalledWith('success');
});
