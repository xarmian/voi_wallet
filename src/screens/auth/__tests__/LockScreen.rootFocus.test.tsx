jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: undefined }) },
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
import React from 'react';
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from '@react-navigation/native';
import { AppState, type AppStateStatus } from 'react-native';
import { act, render, fireEvent } from '@testing-library/react-native';

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

import { RootLockFocusProvider } from '@/contexts/LockFocusContext';
import { AccountSecureStorage } from '@/services/secure';
let appStateListeners: Set<(state: AppStateStatus) => void>;
async function changeAppState(state: AppStateStatus) {
  await act(async () => {
    AppState.currentState = state;
    [...appStateListeners].forEach((listener) => listener(state));
  });
}
const tree = () => (
  <RootLockFocusProvider>
    <LockScreen />
  </RootLockFocusProvider>
);
beforeEach(() => {
  jest.clearAllMocks();
  mockBiometric.mockReset().mockResolvedValue(false);
  mockUnlock.mockReset();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  appStateListeners = new Set();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    });
});
afterEach(() => jest.restoreAllMocks());
it('DEFECT rootRearmsBiometricOncePerFocus', async () => {
  const view = await render(tree());
  expect(mockBiometric).toHaveBeenCalledTimes(1);
  await view.rerender(tree());
  expect(mockBiometric).toHaveBeenCalledTimes(1);
  await changeAppState('background');
  await changeAppState('active');
  expect(mockBiometric).toHaveBeenCalledTimes(2);
  await changeAppState('inactive');
  await changeAppState('active');
  expect(mockBiometric).toHaveBeenCalledTimes(2);
});
function pendingPrompt() {
  let complete!: (success: boolean) => void;
  mockBiometric.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
  );
  return (success: boolean) => complete(success);
}
it('DEFECT rootStaleCompletionIgnored', async () => {
  const complete = pendingPrompt();
  await render(tree());
  const isCurrent = mockBiometric.mock.calls[0][0] as () => boolean;
  expect(isCurrent()).toBe(true);
  await changeAppState('background');
  expect(isCurrent()).toBe(false);
  await changeAppState('active');
  expect(isCurrent()).toBe(false);
  await act(async () => complete(true));
  expect(mockHaptic).not.toHaveBeenCalled();
});
it('REGRESSION rootPromptThroughInactiveStillCompletes', async () => {
  const complete = pendingPrompt();
  await render(tree());
  const isCurrent = mockBiometric.mock.calls[0][0] as () => boolean;
  expect(isCurrent()).toBe(true);
  await changeAppState('inactive');
  expect(isCurrent()).toBe(true);
  await changeAppState('active');
  expect(isCurrent()).toBe(true);
  await act(async () => complete(true));
  expect(mockHaptic).toHaveBeenCalledTimes(1);
  expect(mockHaptic).toHaveBeenCalledWith('success');
});
it('DEFECT rootPinResultAfterBackgroundClearsEntryAndIgnoresOtherEffects', async () => {
  mockBiometric.mockResolvedValue(false);
  let complete!: (success: boolean) => void;
  mockUnlock.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        complete = resolve;
      })
  );
  const view = await render(tree());
  for (const digit of ['1', '2', '3', '4', '5', '6'])
    await fireEvent.press(view.getByText(digit));
  expect(mockUnlock).toHaveBeenCalledTimes(1);
  const dots = () => {
    const filled: unknown[] = [];
    const visit = (node: unknown) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      const element = node as {
        props?: { style?: unknown };
        children?: unknown[];
      };
      const style = element.props?.style;
      if (Array.isArray(style) && style.length === 2 && style[1] !== null)
        filled.push(node);
      element.children?.forEach(visit);
    };
    visit(view.toJSON());
    return filled;
  };
  expect(dots()).toHaveLength(6);
  await changeAppState('background');
  expect(mockUnlock.mock.calls[0][1]()).toBe(false);
  await act(async () => complete(false));
  expect(dots()).toHaveLength(0);
  expect(AccountSecureStorage.getPinThrottleState).toHaveBeenCalledTimes(1);
  expect(mockHaptic).not.toHaveBeenCalled();
});

it('REGRESSION navigation focus loss invalidates completion before blur delivery', async () => {
  let focused = true;
  const navigation = { isFocused: () => focused, addListener: () => () => {} };
  const complete = pendingPrompt();
  await render(
    <NavigationContext.Provider
      value={navigation as unknown as NavigationProp<ParamListBase>}
    >
      <LockScreen />
    </NavigationContext.Provider>
  );
  const isCurrent = mockBiometric.mock.calls[0][0] as () => boolean;
  expect(isCurrent()).toBe(true);
  focused = false;
  expect(isCurrent()).toBe(false);
  await act(async () => complete(true));
  expect(mockHaptic).not.toHaveBeenCalled();
});
