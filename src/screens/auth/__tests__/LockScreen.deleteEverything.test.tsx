/**
 * TASK-469: Delete Everything on the lock screen.
 *  - It resolves "Everything is deleted" ONLY after the wipe reports complete.
 *  - An incomplete wipe (any error) shows the plain "didn't finish" message, the
 *    user stays on the screen, nothing is re-routed, and no "deleted" notice shows.
 *
 * SECURITY NOTE: no key material; the wipe is a mocked sink.
 */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockRecheck = jest.fn(async () => {});
const mockWipe = jest.fn();
const mockShowComplete = jest.fn();
const mockShowIncomplete = jest.fn();
const mockEvents: string[] = [];

jest.mock('@/services/wipe', () => ({
  wipeWalletData: (...args: unknown[]) => mockWipe(...args),
}));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: () => {
    mockEvents.push('complete-notice');
    mockShowComplete();
  },
  showWipeIncompleteNotice: () => {
    mockEvents.push('incomplete-notice');
    mockShowIncomplete();
  },
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: { biometricEnabled: false },
    unlock: jest.fn(),
    unlockWithBiometrics: jest.fn(),
    recheckAuthState: () => {
      mockEvents.push('recheck');
      return mockRecheck();
    },
  }),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    getPinThrottleState: jest.fn(async () => ({
      lockedUntil: null,
      attemptsRemaining: 2,
    })),
    getCredentialSource: jest.fn(async () => 'pin'),
    verifyPin: jest.fn(async () => false),
  },
}));
jest.mock('@react-navigation/native', () => ({
  NavigationContext: require('react').createContext({
    isFocused: () => true,
    addListener: () => () => {},
  }),
  useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }),
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
jest.mock('@/utils/haptics', () => ({ hapticNotify: jest.fn() }));

import LockScreen from '../LockScreen';
import { WipeIncompleteError } from '@/types/wallet';

// Auto-confirm the two confirmation alerts (Reset, then Delete Everything).
const autoConfirm = () =>
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
    const destructive = buttons?.find((b) => b.style === 'destructive');
    destructive?.onPress?.();
  });

const pressDeleteEverything = async () => {
  const view = await render(<LockScreen />);
  await act(async () => {});
  await act(async () => {
    await fireEvent.press(view.getByText('Reset Application'));
  });
  await act(async () => {});
  return view;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockWipe.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

test('a complete wipe re-checks auth, then shows "Everything is deleted" once', async () => {
  autoConfirm();
  await pressDeleteEverything();
  expect(mockWipe).toHaveBeenCalledTimes(1);
  expect(mockEvents).toEqual(['recheck', 'complete-notice']);
  expect(mockShowIncomplete).not.toHaveBeenCalled();
});

test.each([
  ['a WipeIncompleteError', new WipeIncompleteError(['voi_wallet_pin'])],
  ['an unexpected error', new Error('boom')],
])(
  'an incomplete wipe (%s) shows the "didn\'t finish" message and never "deleted", re-routes nothing',
  async (_name, error) => {
    autoConfirm();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWipe.mockRejectedValue(error);
    const view = await pressDeleteEverything();
    expect(mockShowIncomplete).toHaveBeenCalledTimes(1);
    expect(mockShowComplete).not.toHaveBeenCalled();
    expect(mockRecheck).not.toHaveBeenCalled();
    expect(mockEvents).toEqual(['incomplete-notice']);
    // The user stays on the lock screen.
    expect(view.getByText('Reset Application')).toBeTruthy();
  }
);

test('the user can run Delete Everything again after an incomplete wipe', async () => {
  autoConfirm();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockWipe.mockRejectedValueOnce(new WipeIncompleteError(['k']));
  const view = await pressDeleteEverything();
  expect(mockShowIncomplete).toHaveBeenCalledTimes(1);
  await act(async () => {
    await fireEvent.press(view.getByText('Reset Application'));
  });
  await act(async () => {});
  expect(mockWipe).toHaveBeenCalledTimes(2);
  expect(mockShowComplete).toHaveBeenCalledTimes(1);
});
