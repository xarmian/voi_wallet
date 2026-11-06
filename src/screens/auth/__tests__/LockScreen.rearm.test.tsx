import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
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

const mockLock = jest.fn();
let appStateListeners: Set<(state: AppStateStatus) => void>;
async function changeAppState(state: 'active' | 'inactive' | 'background') {
  await act(async () => {
    AppState.currentState = state;
    [...appStateListeners].forEach((listener) => listener(state));
  });
}
async function biometricOrdering(
  resolveState: 'active' | 'inactive' | 'background'
) {
  let resolve!: () => void;
  let unlocked = false;
  mockBiometric.mockImplementationOnce(async (isCurrent: () => boolean) => {
    await new Promise<void>((done) => {
      resolve = done;
    });
    if (!isCurrent()) {
      mockLock();
      return false;
    }
    unlocked = true;
    return true;
  });
  await render(<LockScreen />);
  await focus(true);
  expect(mockBiometric).toHaveBeenCalledTimes(1);
  await changeAppState(resolveState);
  await act(async () => {
    resolve();
  });
  expect(unlocked).toBe(resolveState !== 'background');
  expect(mockLock).toHaveBeenCalledTimes(resolveState === 'background' ? 1 : 0);
  await changeAppState('active');
  await focus(true);
  expect(mockBiometric).toHaveBeenCalledTimes(1);
  if (resolveState === 'background') {
    await focus(false);
    await focus(true);
    expect(mockBiometric).toHaveBeenCalledTimes(2);
  }
}
beforeEach(() => {
  mockLock.mockClear();
  appStateListeners = new Set();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    });
});
// DEFECT R4
it('faceIdResolvesWhileInactiveStillUnlocks', async () => {
  await biometricOrdering('inactive');
});
// REGRESSION R4
it('faceIdResolvesAfterActiveStillUnlocks', async () => {
  await biometricOrdering('active');
});
// REGRESSION R4
it('faceIdResolvesInBackgroundDiscardsAndStaysLocked', async () => {
  await biometricOrdering('background');
});
// DEFECT R4
it('coldStartInactiveThenActivePromptsOnce', async () => {
  AppState.currentState = 'inactive';
  mockFocused = true;
  await render(<LockScreen />);
  expect(mockBiometric).not.toHaveBeenCalled();
  await changeAppState('active');
  expect(mockBiometric).toHaveBeenCalledTimes(1);
  await changeAppState('inactive');
  await changeAppState('active');
  await focus(true);
  expect(mockBiometric).toHaveBeenCalledTimes(1);
  expect(appStateListeners.size).toBe(0);
});
// REGRESSION R4
it('backgroundedThenBlurredNeverPrompts', async () => {
  AppState.currentState = 'background';
  mockFocused = true;
  const view = await render(<LockScreen />);
  await focus(false);
  await changeAppState('active');
  expect(mockBiometric).not.toHaveBeenCalled();
  await view.unmount();
  expect(appStateListeners.size).toBe(0);
});
// DEFECT R8: a biometric attempt owns the guard while digits are entered.
it('blockedPinAttemptClearsDigits', async () => {
  mockBiometric.mockImplementationOnce(() => new Promise(() => {}));
  mockFocused = true;
  const view = await render(<LockScreen />);
  const enter = async () => {
    for (const digit of ['1', '2', '3', '4', '5', '6'])
      await fireEvent.press(view.getByText(digit));
  };
  await enter();
  const dots: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (Array.isArray(node.props?.style) && node.props.style.length === 2)
      dots.push(node);
    node.children?.forEach(visit);
  };
  visit(view.toJSON());
  expect(dots).toHaveLength(6);
  expect(dots.filter((node) => node.props.style[1] !== null)).toHaveLength(0);
  expect(mockUnlock).not.toHaveBeenCalled();
});
