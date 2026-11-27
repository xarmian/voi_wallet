/**
 * TASK-556 — how the 25 words reached MnemonicImportScreen decides whether the
 * imported account counts as backed up.
 *
 * Typed keystroke by keystroke (a suggestion-chip tap counts as typing, and so
 * does a typed space followed by the next word inside one field): the user
 * holds the phrase, so the account imports verified. A change that inserts more
 * than one character at once and leaves the field holding several words (a
 * clipboard paste, or keyboard / password-manager autofill, which arrives
 * through the same onChangeText path) marks the entry pasted: it imports
 * unverified even if words are edited afterwards, until the screen's import
 * state is cleared (leaving the screen, or a successful import).
 *
 * Known limit: any paste that arrives as a single token with no whitespace (one
 * word per field, or a comma-joined phrase that typed spaces then split) is
 * indistinguishable from a keyboard suggestion and counts as typed.
 *
 * The real BIP39 wordlist check runs here (unlike MnemonicImportScreen.test.tsx),
 * so the Import button only works once all 25 fields hold wordlist words. The
 * screen checks the wordlist only, not the phrase checksum.
 *
 * SECURITY NOTE: the phrase is a throwaway account generated at runtime; it is
 * never persisted and the wallet store is mocked.
 */

import React from 'react';
import { Alert, TextInput } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import algosdk from 'algosdk';

jest.mock('@/services/wallet', () => ({}));

const mockImportAccount = jest.fn();
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({ importAccount: mockImportAccount }),
}));

const mockHasPin = jest.fn(async () => true);
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: { hasPin: () => mockHasPin() },
}));

jest.mock('@react-navigation/native', () => ({
  CommonActions: { reset: jest.fn(), navigate: jest.fn() },
  useFocusEffect: () => {},
}));

// The screen reads the tab bar height from bottom-tabs; the real module needs
// the full navigation library, which is mocked above.
jest.mock('@react-navigation/bottom-tabs', () => ({
  BottomTabBarHeightContext: require('react').createContext(undefined),
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
import {
  clearAllAccountSecrets,
  getAccountSecret,
} from '@/utils/accountQRParser';

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

/**
 * Word 1 typed one keystroke per onChangeText, then a space and the first
 * letter of word 2 in the same field ("a", "ac", "act", "act ", "act i"). A
 * strict-prefix word such as "act" does not auto-advance, so this is how such a
 * word is typed. The field splits the two words across fields 1 and 2.
 */
async function typeWordOneThenSpaceInSameField(screen: Screen) {
  let text = '';
  for (const ch of `${WORDS[0]} ${WORDS[1][0]}`) {
    text += ch;
    await fireEvent.changeText(field(screen, 0), text);
  }
  expect(field(screen, 0).props.value).toBe(WORDS[0]);
  expect(field(screen, 1).props.value).toBe(WORDS[1][0]);
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
  mockHasPin.mockReset().mockResolvedValue(true);
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

  it('a typed space then the next word in the same field counts as typing: backupVerified true', async () => {
    const { screen } = await renderScreen(false);

    await typeWordOneThenSpaceInSameField(screen);
    await typeWords(screen, 1, 25);
    await pressImport(screen);

    expect(importedBackupVerified()).toBe(true);
  });

  it('two words inserted at once into an empty field (paste) import with backupVerified false', async () => {
    const { screen } = await renderScreen(false);

    await insertWords(screen, 0, WORDS.slice(0, 2));
    await typeWords(screen, 2, 25);
    await pressImport(screen);

    expect(importedBackupVerified()).toBe(false);
  });

  it('several words appended at once to a typed word import with backupVerified false', async () => {
    const { screen } = await renderScreen(false);

    await typeWords(screen, 0, 1);
    await fireEvent.changeText(
      field(screen, 0),
      `${WORDS[0]} ${WORDS.slice(1).join(' ')}`
    );
    await pressImport(screen);

    expect(importedBackupVerified()).toBe(false);
  });

  it('a replaced selection that yields several words fails closed: backupVerified false', async () => {
    const { screen } = await renderScreen(false);

    // Field 1 holds word 1 plus a stray letter; the stray letter is replaced
    // by " " plus word 2's first letter. The text grows by only one character,
    // but it is not one inserted keystroke, so it counts as a paste. The stray
    // letter must differ from word 2's first letter: if they matched, the
    // change really would be one inserted space (the phrase is random per run).
    const stray = WORDS[1][0] === 'q' ? 'z' : 'q';
    await fireEvent.changeText(field(screen, 0), `${WORDS[0]}${stray}`);
    await fireEvent.changeText(field(screen, 0), `${WORDS[0]} ${WORDS[1][0]}`);
    expect(field(screen, 1).props.value).toBe(WORDS[1][0]);
    await typeWords(screen, 1, 25);
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

  it('a typed space then the next word in the same field hands SecuritySetup phraseTyped true', async () => {
    const { navigation, screen } = await renderScreen(true);

    await typeWordOneThenSpaceInSameField(screen);
    await typeWords(screen, 1, 25);
    await pressImport(screen);

    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).toHaveBeenCalledWith(
      'SecuritySetup',
      expect.objectContaining({ source: 'mnemonic', phraseTyped: true })
    );
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

describe('MnemonicImportScreen — adding to a wallet with no PIN (TASK-522)', () => {
  it('routes a typed phrase to SecuritySetup by secret id and stores nothing', async () => {
    mockHasPin.mockResolvedValue(false);
    const { navigation, screen } = await renderScreen(false);

    await fireEvent.changeText(
      screen.getByPlaceholderText('Imported account name'),
      'Savings'
    );
    await typeWords(screen, 0, 25);
    await pressImport(screen);

    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    const [route, params] = navigation.navigate.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(route).toBe('SecuritySetup');
    expect(params).toEqual({
      source: 'mnemonic',
      addingAccount: true,
      accountLabel: 'Savings',
      phraseTyped: true,
      mnemonicSecretId: expect.any(String),
    });
    expect(JSON.stringify(params)).not.toContain(WORDS[0]);
    expect(getAccountSecret(params.mnemonicSecretId as string)?.mnemonic).toBe(
      MNEMONIC
    );
    expect(mockImportAccount).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
    // The words stay on screen: going back from SecuritySetup loses nothing.
    expect(field(screen, 0).props.value).toBe(WORDS[0]);
  });

  it('a pasted phrase carries phraseTyped false', async () => {
    mockHasPin.mockResolvedValue(false);
    const { navigation, screen } = await renderScreen(false);

    await insertWords(screen, 0, WORDS);
    await pressImport(screen);

    expect(navigation.navigate).toHaveBeenCalledWith(
      'SecuritySetup',
      expect.objectContaining({ addingAccount: true, phraseTyped: false })
    );
    expect(mockImportAccount).not.toHaveBeenCalled();
  });

  it('with a PIN imports directly, as before', async () => {
    const { navigation, screen } = await renderScreen(false);

    await typeWords(screen, 0, 25);
    await pressImport(screen);

    expect(mockHasPin).toHaveBeenCalledTimes(1);
    expect(mockImportAccount).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it('a failed PIN read alerts, routes nowhere and imports nothing', async () => {
    mockHasPin.mockRejectedValue(new Error('keychain unavailable'));
    const { navigation, screen } = await renderScreen(false);

    await typeWords(screen, 0, 25);
    await pressImport(screen);

    expect(Alert.alert).toHaveBeenCalledWith(
      'Import Failed',
      expect.any(String)
    );
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(mockImportAccount).not.toHaveBeenCalled();
  });

  it('onboarding never asks about the PIN', async () => {
    mockHasPin.mockResolvedValue(false);
    const { navigation, screen } = await renderScreen(true);

    await typeWords(screen, 0, 25);
    await pressImport(screen);

    expect(mockHasPin).not.toHaveBeenCalled();
    const params = navigation.navigate.mock.calls[0][1] as object;
    expect(params).not.toHaveProperty('addingAccount');
  });
});

describe('MnemonicImportScreen — focus and neighbours after a typed split (TASK-554)', () => {
  // TextInput's jest mock shares one focus() mock across all instances; the
  // instance each call ran on (mock.contexts) names the field. setSelection is
  // not part of the mock, so it is added here.
  type MockInput = { props: { placeholder?: string } };
  const inputProto = TextInput.prototype as unknown as {
    focus: jest.Mock;
    setSelection?: jest.Mock;
  };
  const focusedFields = () =>
    inputProto.focus.mock.contexts.map(
      (input) => (input as MockInput).props.placeholder
    );

  beforeEach(() => {
    inputProto.setSelection = jest.fn();
  });

  afterEach(() => {
    delete inputProto.setSelection;
  });

  async function typeInto(screen: Screen, index: number, texts: string[]) {
    for (const text of texts) {
      await fireEvent.changeText(field(screen, index), text);
    }
  }

  const values = (screen: Screen) =>
    Array.from({ length: 25 }, (_, i) => field(screen, i).props.value);

  it('focuses the field holding the partial word, with the cursor at its end', async () => {
    const { screen } = await renderScreen(false);

    // "act" is a prefix of longer words, so it does not auto-advance.
    await typeInto(screen, 0, ['a', 'ac', 'act', 'act ', 'act i']);
    expect(field(screen, 0).props.value).toBe('act');
    expect(field(screen, 1).props.value).toBe('i');

    await waitFor(() => expect(focusedFields()).toContain('Word 2'));
    expect(focusedFields()).not.toContain('Word 3');
    const selection = inputProto.setSelection!;
    expect(selection).toHaveBeenCalledWith(1, 1);
    expect(
      (selection.mock.contexts.at(-1) as MockInput).props.placeholder
    ).toBe('Word 2');

    await typeInto(screen, 1, ['ic', 'ice']);
    expect(field(screen, 1).props.value).toBe('ice');
  });

  it('a paste still focuses the next empty field after the pasted words', async () => {
    const { screen } = await renderScreen(false);

    await insertWords(screen, 0, WORDS.slice(0, 3));

    await waitFor(() => expect(focusedFields()).toContain('Word 4'));
    expect(focusedFields()).not.toContain('Word 3');
  });

  it('does not overwrite a non-empty next field: later words move right into the first empty field', async () => {
    const { screen } = await renderScreen(false);
    await fireEvent.changeText(field(screen, 1), WORDS[1]);
    await fireEvent.changeText(field(screen, 2), WORDS[2]);
    // Field 4 stays empty; field 5 holds a word that must not move.
    await fireEvent.changeText(field(screen, 4), WORDS[4]);

    await typeInto(screen, 0, ['a', 'ac', 'act', 'act ', 'act i']);

    expect(values(screen).slice(0, 6)).toEqual([
      'act',
      'i',
      WORDS[1],
      WORDS[2],
      WORDS[4],
      '',
    ]);
    await waitFor(() => expect(focusedFields()).toContain('Word 2'));
  });

  it('with no empty field after it, refuses the split and keeps every word', async () => {
    const { screen } = await renderScreen(false);
    await typeWords(screen, 0, 25);

    await typeInto(screen, 0, [`${WORDS[0]} `, `${WORDS[0]} x`]);

    expect(field(screen, 0).props.value).toBe(`${WORDS[0]} `);
    expect(values(screen).map((w) => w.trim())).toEqual(WORDS);
  });
});
