import React from 'react';
import { AppState } from 'react-native';
import { act, render, fireEvent } from '@testing-library/react-native';

let mockFocused = false;
const mockFocusListeners = new Set<() => void>();
const mockBlurListeners = new Set<() => void>();
const mockNavigation = {
  isFocused: () => mockFocused,
  addListener: (event: string, listener: () => void) => {
    const listeners =
      event === 'focus' ? mockFocusListeners : mockBlurListeners;
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
const mockUnlock = jest.fn();
const mockBiometric = jest.fn();
const mockHaptic = jest.fn();
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: { biometricEnabled: true },
    unlock: mockUnlock,
    unlockWithBiometrics: mockBiometric,
    recheckAuthState: jest.fn(),
    consumeUnlockRefusal: jest.fn(),
  }),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    getPinThrottleState: jest.fn(async () => ({
      lockedUntil: null,
      attemptsRemaining: 5,
    })),
    getCredentialSource: jest.fn(async () => 'pin'),
  },
}));
jest.mock('@/services/wipe', () => ({ wipeWalletData: jest.fn() }));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: jest.fn(),
  showWipeIncompleteNotice: jest.fn(),
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
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

async function focus(value: boolean) {
  await act(async () => {
    mockFocused = value;
    (value ? mockFocusListeners : mockBlurListeners).forEach((listener) =>
      listener()
    );
  });
}
beforeEach(() => {
  mockFocused = false;
  mockFocusListeners.clear();
  mockBlurListeners.clear();
  mockBiometric.mockReset().mockResolvedValue(false);
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
    writable: true,
  });
});
afterEach(() => {
  jest.restoreAllMocks();
});

it('rearmsBiometricOncePerFocusAndNotOnInactive', async () => {
  const view = await render(<LockScreen />);
  expect(mockBiometric).not.toHaveBeenCalled(); // WC has focus.
  await focus(true);
  expect(mockBiometric).toHaveBeenCalledTimes(1);
  await view.rerender(<LockScreen />);
  await act(async () => {});
  expect(mockBiometric).toHaveBeenCalledTimes(1); // Cancel does not retry.
  await focus(false);
  await focus(true);
  expect(mockBiometric).toHaveBeenCalledTimes(2);
  await focus(false);
  AppState.currentState = 'inactive';
  await focus(true);
  expect(mockBiometric).toHaveBeenCalledTimes(2);
  AppState.currentState = 'active';
  await focus(false);
  let complete!: (success: boolean) => void;
  mockBiometric.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  await focus(true);
  expect(mockBiometric).toHaveBeenCalledTimes(3);
  const isCurrent = mockBiometric.mock.calls[2][0];
  expect(isCurrent()).toBe(true);
  await focus(false);
  await focus(true);
  expect(mockBiometric).toHaveBeenCalledTimes(3); // In-flight prompt owns authentication.
  expect(isCurrent()).toBe(false); // A later focus cannot revive an old completion.
  await act(async () => {
    complete(true);
  });
  expect(mockHaptic).not.toHaveBeenCalled();
});
it('pinAuthenticationInFlightBlocksBiometricPrompt', async () => {
  mockUnlock.mockImplementationOnce(() => new Promise(() => {}));
  const view = await render(<LockScreen />);
  for (const digit of ['1', '2', '3', '4', '5', '6'])
    await fireEvent.press(view.getByText(digit));
  expect(mockUnlock).toHaveBeenCalledTimes(1);
  await focus(true);
  expect(mockBiometric).not.toHaveBeenCalled();
});
