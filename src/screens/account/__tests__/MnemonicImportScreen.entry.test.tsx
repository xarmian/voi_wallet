/**
 * TASK-556 — how the 25 words reached MnemonicImportScreen decides whether the
 * imported account counts as backed up.
 *
 * Typed word by word (a suggestion-chip tap counts as typing): the user holds
 * the phrase, so the account imports verified. Any insertion of more than one
 * word into a field (a clipboard paste, or keyboard / password-manager autofill,
 * which arrives through the same onChangeText path) marks the entry pasted for
 * good: it imports unverified even if words are edited afterwards. Clearing the
 * words starts a fresh entry.
 *
 * Real BIP39 validation runs here (unlike MnemonicImportScreen.test.tsx), so
 * the Import button only works once all 25 fields hold valid words.
 *
 * SECURITY NOTE: the phrase is a throwaway account generated at runtime; it is
 * never persisted and the wallet store is mocked.
 */

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import algosdk from 'algosdk';

jest.mock('@/services/wallet', () => ({}));

const mockImportAccount = jest.fn();
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({ importAccount: mockImportAccount }),
}));

jest.mock('@react-navigation/native', () => ({
  CommonActions: { reset: jest.fn(), navigate: jest.fn() },
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

// The word grid is a FlatList, which renders only its first rows in a test
// renderer (no layout pass). Render every item so all 25 fields can be typed.
jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactActual = jest.requireActual('react');
  const ActualFlatList = jest.requireActual(
    'react-native/Libraries/Lists/FlatList'
  ).default;
  const FullFlatList = ReactActual.forwardRef(
    (props: { data?: unknown[] }, ref: unknown) =>
      ReactActual.createElement(ActualFlatList, {
        ...props,
        ref,
        initialNumToRender: props.data?.length ?? 10,
      })
  );
  return { __esModule: true, default: FullFlatList };
});

import MnemonicImportScreen from '../MnemonicImportScreen';
import { clearAllAccountSecrets } from '@/utils/accountQRParser';

const MNEMONIC = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
const WORDS = MNEMONIC.split(' ');

type Screen = Awaited<ReturnType<typeof render>>;

function makeNavigation() {
  return {
    navigate: jest.fn(),
    goBack: jest.fn(),
    dispatch: jest.fn(),
    canGoBack: () => true,
    getParent: () => undefined,
    getState: jest.fn(() => ({ type: 'stack', routes: [] })),
  };
}

async function renderScreen(isOnboarding: boolean) {
  const navigation = makeNavigation();
  const screen = await render(
    <MnemonicImportScreen
      navigation={navigation as never}
      route={{ params: isOnboarding ? { isOnboarding } : undefined } as never}
    />
  );
  return { navigation, screen };
}

const field = (screen: Screen, index: number) =>
  screen.getByPlaceholderText(`Word ${index + 1}`);

/** One onChangeText per field, one word each: typing. */
async function typeWords(screen: Screen, from: number, to: number) {
  for (let i = from; i < to; i++) {
    await fireEvent.changeText(field(screen, i), WORDS[i]);
  }
}

/** Several words delivered to one field in one onChangeText: paste/autofill. */
async function insertWords(screen: Screen, at: number, words: string[]) {
  await fireEvent.changeText(field(screen, at), words.join(' '));
}

async function pressImport(screen: Screen) {
  await fireEvent.press(screen.getByText('Import'));
}

function importedBackupVerified(): unknown {
  expect(mockImportAccount).toHaveBeenCalledTimes(1);
  const request = mockImportAccount.mock.calls[0][0];
  expect(request).toEqual(
    expect.objectContaining({ type: 'standard', mnemonic: MNEMONIC })
  );
  return request.backupVerified;
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockImportAccount.mockResolvedValue(undefined);
});

afterEach(() => {
  clearAllAccountSecrets();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('MnemonicImportScreen — add-account entry method (TASK-556)', () => {
  it('a phrase typed word by word imports with backupVerified true', async () => {
    const { navigation, screen } = await renderScreen(false);

    await typeWords(screen, 0, 25);
    await pressImport(screen);

    expect(importedBackupVerified()).toBe(true);
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Success',
      'Account imported successfully!'
    );
  });

  it('a suggestion-chip tap counts as typing: backupVerified true', async () => {
    const { screen } = await renderScreen(false);
    // BIP39 words are unique in their first four letters, so a four-letter
    // prefix of a longer word offers exactly that word as a chip.
    const chipIndex = WORDS.findIndex((w) => w.length > 4);
    expect(chipIndex).toBeGreaterThanOrEqual(0);

    await typeWords(screen, 0, chipIndex);
    await fireEvent(field(screen, chipIndex), 'focus');
    await fireEvent.changeText(
      field(screen, chipIndex),
      WORDS[chipIndex].slice(0, 4)
    );
    await fireEvent.press(screen.getByText(WORDS[chipIndex]));
    await typeWords(screen, chipIndex + 1, 25);
    await pressImport(screen);

    expect(importedBackupVerified()).toBe(true);
  });

  it('the whole phrase pasted into word 1 imports with backupVerified false', async () => {
    const { screen } = await renderScreen(false);

    await insertWords(screen, 0, WORDS);
    await pressImport(screen);

    expect(importedBackupVerified()).toBe(false);
  });

  it('a paste then a typed correction still imports with backupVerified false', async () => {
    const { screen } = await renderScreen(false);

    await insertWords(screen, 0, WORDS);
    await fireEvent.changeText(field(screen, 3), '');
    await fireEvent.changeText(field(screen, 3), WORDS[3]);
    await pressImport(screen);

    expect(importedBackupVerified()).toBe(false);
  });

  it('a multi-word insertion into a later field (paste or autofill) imports with backupVerified false', async () => {
    const { screen } = await renderScreen(false);

    await typeWords(screen, 0, 12);
    // Keyboard or password-manager autofill of the rest lands as one
    // multi-word onChangeText on word 13, exactly like a paste.
    await insertWords(screen, 12, WORDS.slice(12));
    await pressImport(screen);

    expect(importedBackupVerified()).toBe(false);
  });

  it('clearing the words after an import starts a fresh, typed entry', async () => {
    const { screen } = await renderScreen(false);

    await insertWords(screen, 0, WORDS);
    await pressImport(screen);
    expect(mockImportAccount.mock.calls[0][0].backupVerified).toBe(false);

    // The successful import cleared all 25 fields; this entry is typed.
    expect(field(screen, 0).props.value).toBe('');
    await typeWords(screen, 0, 25);
    await pressImport(screen);

    expect(mockImportAccount).toHaveBeenCalledTimes(2);
    expect(mockImportAccount.mock.calls[1][0]).toEqual(
      expect.objectContaining({ mnemonic: MNEMONIC, backupVerified: true })
    );
  });
});

describe('MnemonicImportScreen — onboarding phraseTyped hand-off (TASK-556)', () => {
  it('a typed phrase hands SecuritySetup phraseTyped true', async () => {
    const { navigation, screen } = await renderScreen(true);

    await typeWords(screen, 0, 25);
    await pressImport(screen);

    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith(
      'SecuritySetup',
      expect.objectContaining({ source: 'mnemonic', phraseTyped: true })
    );
    expect(mockImportAccount).not.toHaveBeenCalled();
  });

  it('a pasted phrase hands SecuritySetup phraseTyped false', async () => {
    const { navigation, screen } = await renderScreen(true);

    await insertWords(screen, 0, WORDS);
    await pressImport(screen);

    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith(
      'SecuritySetup',
      expect.objectContaining({ source: 'mnemonic', phraseTyped: false })
    );
  });
});
