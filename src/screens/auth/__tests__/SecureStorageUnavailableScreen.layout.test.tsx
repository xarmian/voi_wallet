/**
 * Layout: the secure-storage recovery screen content scrolls instead of
 * clipping. Its header, long hint and reset controls can be taller than a
 * small screen; with only flex centering the warning icon is pushed up under
 * the status bar and the reset button below the bottom edge. The content must
 * sit in one ScrollView whose content container grows to fill (so content that
 * fits stays centered) and keeps taps while the RESET keyboard is up.
 *
 * SECURITY NOTE: no secret material; the wipe is a mocked sink.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

import SecureStorageUnavailableScreen from '../SecureStorageUnavailableScreen';

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: { clearAll: jest.fn(async () => {}) },
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { clearAllWallets: jest.fn(async () => {}) },
}));
jest.mock('@/services/wipe', () => ({
  wipeAllLocalData: jest.fn(async () => {}),
  isWipeInFlight: () => false,
}));
// The real useThemedStyles runs, so the content container style is the one
// the screen actually ships.
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

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

test('the warning title and the reset button sit inside one ScrollView that fills, centers and keeps taps', async () => {
  const view = await render(
    <SecureStorageUnavailableScreen onRetry={jest.fn(async () => {})} />
  );

  const button = view.getByLabelText(
    'Reset app and restore from recovery phrase'
  ) as unknown as Node;
  const scroll = scrollAncestor(button);
  expect(scroll).not.toBeNull();

  const title = view.getByText('Secure storage unavailable') as unknown as Node;
  expect(scrollAncestor(title)).toBe(scroll);

  const contentStyle = StyleSheet.flatten(
    scroll!.props.contentContainerStyle as never
  ) as Record<string, unknown>;
  expect(contentStyle).toEqual(
    expect.objectContaining({
      flexGrow: 1,
      justifyContent: 'center',
      alignItems: 'center',
    })
  );
  expect(scroll!.props.keyboardShouldPersistTaps).toBe('handled');
});
