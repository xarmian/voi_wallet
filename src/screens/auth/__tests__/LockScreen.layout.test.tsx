jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: undefined }) },
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
/**
 * Layout: the lock screen content scrolls instead of clipping. During a PIN
 * lockout the lockout block and the reset section can be taller than a small
 * screen; with only flex centering the "Reset Application" button ends up
 * below the bottom edge where it can't be reached. The content must sit in a
 * ScrollView whose content container grows to fill (so content that fits
 * stays centered) and keeps taps while the keyboard is up.
 *
 * SECURITY NOTE: no key material; storage is a mocked sink.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';

jest.mock('@/services/wipe', () => ({ wipeAllLocalData: jest.fn() }));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: jest.fn(),
  showWipeIncompleteNotice: jest.fn(),
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: { biometricEnabled: false },
    unlock: jest.fn(),
    unlockWithBiometrics: jest.fn(),
    recheckAuthState: jest.fn(async () => {}),
  }),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    // An active PIN lockout: the lockout block and the reset section both show.
    getPinThrottleState: jest.fn(async () => ({
      lockedUntil: Date.now() + 5 * 60 * 1000,
      attemptsRemaining: 0,
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
// The real useThemedStyles runs, so the content container style is the one
// the screen actually ships.
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/utils/haptics', () => ({ hapticNotify: jest.fn() }));

import LockScreen from '../LockScreen';

type Node = {
  type: unknown;
  props: Record<string, unknown>;
  parent: Node | null;
};

const scrollAncestor = (node: Node): Node | null => {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'RCTScrollView') return n;
  }
  return null;
};

afterEach(() => jest.useRealTimers());

test('during a PIN lockout the Reset Application button sits inside a ScrollView that fills and keeps taps', async () => {
  jest.useFakeTimers();
  const view = await render(<LockScreen />);
  await act(async () => {});

  // The lockout is showing, so this is the tall layout.
  expect(view.getByText(/Try again in/)).toBeTruthy();

  const button = view.getByText('Reset Application') as unknown as Node;
  const scroll = scrollAncestor(button);
  expect(scroll).not.toBeNull();
  const contentStyle = StyleSheet.flatten(
    scroll!.props.contentContainerStyle as never
  ) as Record<string, unknown>;
  expect(contentStyle).toEqual(
    expect.objectContaining({ flexGrow: 1, justifyContent: 'center' })
  );
  expect(scroll!.props.keyboardShouldPersistTaps).toBe('handled');

  // The padlock header is in the same ScrollView, so it can't be pushed up
  // under the status bar either.
  const title = view.getByText('Wallet Locked') as unknown as Node;
  expect(scrollAncestor(title)).toBe(scroll);
});
