/**
 * TASK-224 — the onboarding mnemonic-import hand-off to SecuritySetup.
 *
 * The typed 25-word phrase must never travel as a route param (serializable
 * navigation state). It goes into the in-memory secret holder and only an
 * opaque `mnemonicSecretId` is passed. Every other param is unchanged.
 *
 * SECURITY NOTE: obviously-fake words only, and BIP39 validation is mocked; no
 * real key material is involved.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

const MOCK_FAKE_WORDS = Array(25).fill('fake');
const MOCK_FAKE_MNEMONIC = MOCK_FAKE_WORDS.join(' ');

jest.mock('@/utils/bip39', () => ({
  BIP39Utils: {
    validateMnemonicWords: jest.fn(() => true),
    getMnemonicFromWords: jest.fn(() => MOCK_FAKE_MNEMONIC),
    isValidWord: jest.fn(() => true),
    getWordSuggestions: jest.fn(() => []),
  },
}));

jest.mock('@/services/wallet', () => ({}));

const mockImportAccount = jest.fn();
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({ importAccount: mockImportAccount }),
}));

jest.mock('@react-navigation/native', () => ({
  CommonActions: { reset: jest.fn() },
  useFocusEffect: () => {},
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('@/hooks/useSecureScreen', () => ({ useSecureScreen: () => {} }));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

import MnemonicImportScreen from '../MnemonicImportScreen';
import {
  getAccountSecret,
  clearAllAccountSecrets,
} from '@/utils/accountQRParser';

function makeNavigation() {
  return {
    navigate: jest.fn(),
    goBack: jest.fn(),
    dispatch: jest.fn(),
    getState: jest.fn(() => ({ type: 'stack', routes: [] })),
  };
}

afterEach(() => {
  clearAllAccountSecrets();
  jest.clearAllMocks();
});

describe('MnemonicImportScreen — onboarding hand-off (TASK-224)', () => {
  it('passes an opaque mnemonicSecretId, never the phrase', async () => {
    const navigation = makeNavigation();
    const screen = await render(
      <MnemonicImportScreen
        navigation={navigation as never}
        route={{ params: { isOnboarding: true } } as never}
      />
    );

    await fireEvent.press(screen.getByText('Import'));

    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    const [routeName, params] = navigation.navigate.mock.calls[0];
    expect(routeName).toBe('SecuritySetup');
    expect(params).toEqual({
      mnemonicSecretId: expect.any(String),
      source: 'mnemonic',
      accountLabel: undefined,
    });
    expect(params).not.toHaveProperty('mnemonic');
    expect(JSON.stringify(params)).not.toContain('fake');
    expect(getAccountSecret(params.mnemonicSecretId)).toEqual({
      mnemonic: MOCK_FAKE_MNEMONIC,
    });
    expect(mockImportAccount).not.toHaveBeenCalled();
  });

  it('stores a fresh id on each navigate (re-continue after coming back)', async () => {
    const navigation = makeNavigation();
    const screen = await render(
      <MnemonicImportScreen
        navigation={navigation as never}
        route={{ params: { isOnboarding: true } } as never}
      />
    );

    await fireEvent.press(screen.getByText('Import'));
    await fireEvent.press(screen.getByText('Import'));

    expect(navigation.navigate).toHaveBeenCalledTimes(2);
    const first = navigation.navigate.mock.calls[0][1].mnemonicSecretId;
    const second = navigation.navigate.mock.calls[1][1].mnemonicSecretId;
    expect(first).not.toBe(second);
    expect(getAccountSecret(second)?.mnemonic).toBe(MOCK_FAKE_MNEMONIC);
  });
});
