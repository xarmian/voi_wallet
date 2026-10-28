/**
 * TASK-224 — SecuritySetupScreen consumes the recovery phrase from the
 * in-memory secret holder via an opaque `mnemonicSecretId` route param.
 *
 * Contracts pinned here:
 * - the phrase is read from the holder at import time and the entry is
 *   cleared on success; on an import failure it is kept so a same-screen retry
 *   works (without a second first-secret setup), and released on unmount;
 * - back is blocked while a submit is in flight, and a double-tap submits once;
 * - unmounting without submitting (back / swipe / hardware back) clears it;
 * - a missing entry (e.g. TASK-213 cold boot: params rehydrate, memory does
 *   not) shows an error and never calls importStandardAccount, and never sets a
 *   PIN first.
 *
 * SECURITY NOTE: obviously-fake phrase only; wallet/secure services are mocked.
 */

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

const mockImportStandardAccount = jest.fn();
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    importStandardAccount: (...args: unknown[]) =>
      mockImportStandardAccount(...args),
    addWatchAccount: jest.fn(),
  },
}));

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    PASSPHRASE_MIN_LENGTH: 12,
    setBiometricEnabled: jest.fn(async () => {}),
    setBiometricSecret: jest.fn(async () => {}),
  },
}));

const mockAuthSetupPin = jest.fn();
// Latest Complete-Setup handler, so a test can fire two taps in ONE tick.
const mockCompleteOnPress: { current: null | (() => unknown) } = {
  current: null,
};
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ setupPin: mockAuthSetupPin }),
}));

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

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

jest.mock('@/components/common/NFTBackground', () => {
  const { View } = require('react-native');
  return { NFTBackground: ({ children }: never) => <View>{children}</View> };
});

jest.mock('@/components/common/KeyboardAwareScrollView', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: ({ children }: never) => <View>{children}</View>,
  };
});

jest.mock('@/components/common/UniversalHeader', () => {
  const { Text, TouchableOpacity } = require('react-native');
  return {
    __esModule: true,
    default: ({
      showBackButton,
      onBackPress,
    }: {
      showBackButton?: boolean;
      onBackPress: () => void;
    }) =>
      showBackButton ? (
        <TouchableOpacity testID="header-back" onPress={onBackPress}>
          <Text>back</Text>
        </TouchableOpacity>
      ) : null,
  };
});

jest.mock('@/components/common/GlassCard', () => {
  const { View } = require('react-native');
  return { GlassCard: ({ children }: never) => <View>{children}</View> };
});

jest.mock('@/components/common/PassphraseStrengthMeter', () => ({
  PassphraseStrengthMeter: () => null,
}));

jest.mock('@/components/common/GlassInput', () => {
  const { TextInput } = require('react-native');
  return {
    GlassInput: ({
      placeholder,
      value,
      onChangeText,
    }: {
      placeholder: string;
      value: string;
      onChangeText: (t: string) => void;
    }) => (
      <TextInput
        placeholder={placeholder}
        value={value}
        onChangeText={onChangeText}
      />
    ),
  };
});

jest.mock('@/components/common/GlassButton', () => {
  const { Text, TouchableOpacity } = require('react-native');
  return {
    GlassButton: ({
      label,
      onPress,
    }: {
      label: string;
      onPress: () => void;
    }) => {
      mockCompleteOnPress.current = onPress;
      return (
        <TouchableOpacity testID="complete-setup" onPress={onPress}>
          <Text>{label}</Text>
        </TouchableOpacity>
      );
    },
  };
});

import { Alert } from 'react-native';
import SecuritySetupScreen from '../SecuritySetupScreen';
import {
  storeMnemonicSecret,
  getAccountSecret,
  clearAccountSecret,
  clearAllAccountSecrets,
} from '@/utils/accountQRParser';

const FAKE_MNEMONIC = Array(25).fill('fake-word-not-real').join(' ');
const UNAVAILABLE = /recovery phrase is no longer available/;

type BeforeRemove = (e: { preventDefault: () => void }) => void;

function makeNavigation() {
  let beforeRemove: BeforeRemove[] = [];
  return {
    navigate: jest.fn(),
    goBack: jest.fn(),
    setOptions: jest.fn(),
    addListener: jest.fn((event: string, cb: BeforeRemove) => {
      if (event === 'beforeRemove') beforeRemove.push(cb);
      return () => {
        beforeRemove = beforeRemove.filter((l) => l !== cb);
      };
    }),
    /** Simulate a pop (hardware back / swipe / programmatic). */
    emitBeforeRemove(): boolean {
      let prevented = false;
      beforeRemove.forEach((cb) =>
        cb({
          preventDefault: () => {
            prevented = true;
          },
        })
      );
      return prevented;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function enterPin(
  screen: Awaited<ReturnType<typeof render>>,
  value = '123456'
) {
  await fireEvent.changeText(screen.getByPlaceholderText('Enter PIN'), value);
  await fireEvent.changeText(screen.getByPlaceholderText('Confirm PIN'), value);
}

async function renderScreen(params: Record<string, unknown>) {
  const navigation = makeNavigation();
  const screen = await render(
    <SecuritySetupScreen
      navigation={navigation as never}
      route={{ key: 'SecuritySetup', name: 'SecuritySetup', params } as never}
    />
  );
  return { navigation, screen };
}

async function submitPin(
  screen: Awaited<ReturnType<typeof render>>,
  value = '123456'
) {
  await enterPin(screen, value);
  await fireEvent.press(screen.getByTestId('complete-setup'));
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockAuthSetupPin.mockResolvedValue(undefined);
  mockImportStandardAccount.mockResolvedValue({ address: 'FAKEADDRESS' });
});

afterEach(() => {
  clearAllAccountSecrets();
  jest.restoreAllMocks();
  mockAuthSetupPin.mockReset();
  mockImportStandardAccount.mockReset();
});

describe('SecuritySetupScreen — mnemonic secret carrier (TASK-224)', () => {
  it('imports the stored phrase and clears the secret on success', async () => {
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { navigation, screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'create',
      backupVerified: true,
    });

    await submitPin(screen);

    expect(mockImportStandardAccount).toHaveBeenCalledTimes(1);
    expect(mockImportStandardAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        mnemonic: FAKE_MNEMONIC,
        label: 'Main Account',
        backupVerified: true,
      })
    );
    // Cleared on consume — while the screen is still mounted, so this is the
    // import-path clear, not the unmount cleanup.
    expect(getAccountSecret(id)).toBeUndefined();
    expect(navigation.navigate).toHaveBeenCalledWith('Main');
    await screen.unmount();
  });

  it('keeps the secret on import failure so a same-screen retry works', async () => {
    mockImportStandardAccount.mockRejectedValueOnce(new Error('import boom'));
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { navigation, screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'mnemonic',
    });

    await submitPin(screen);

    expect(mockImportStandardAccount).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringContaining('import boom')
    );
    expect(navigation.navigate).not.toHaveBeenCalled();
    // Kept for the retry (the unmount cleanup still guarantees release).
    expect(getAccountSecret(id)?.mnemonic).toBe(FAKE_MNEMONIC);

    // Retry with the same PIN: no second first-secret setup, import succeeds,
    // secret released.
    await fireEvent.press(screen.getByTestId('complete-setup'));

    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);
    expect(mockImportStandardAccount).toHaveBeenCalledTimes(2);
    expect(mockImportStandardAccount).toHaveBeenLastCalledWith(
      expect.objectContaining({ mnemonic: FAKE_MNEMONIC })
    );
    expect(getAccountSecret(id)).toBeUndefined();
    expect(navigation.navigate).toHaveBeenCalledWith('Main');
    await screen.unmount();
  });

  it('refuses a retry with a different PIN than the one already committed', async () => {
    mockImportStandardAccount.mockRejectedValueOnce(new Error('import boom'));
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { navigation, screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'create',
    });

    await submitPin(screen, '123456');
    (Alert.alert as jest.Mock).mockClear();

    await submitPin(screen, '654321');

    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringMatching(/PIN is already set/)
    );
    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);
    expect(mockImportStandardAccount).toHaveBeenCalledTimes(1);
    expect(navigation.navigate).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it('releases the secret on unmount after an import failure', async () => {
    mockImportStandardAccount.mockRejectedValue(new Error('import boom'));
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'mnemonic',
    });

    await submitPin(screen);
    expect(getAccountSecret(id)?.mnemonic).toBe(FAKE_MNEMONIC);

    await screen.unmount();
    expect(getAccountSecret(id)).toBeUndefined();
  });

  it('blocks back while setupPin is pending, then imports and releases the phrase', async () => {
    const pending = deferred();
    mockAuthSetupPin.mockImplementation(() => pending.promise);
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { navigation, screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'create',
    });

    // Not submitting yet: back is allowed.
    expect(navigation.emitBeforeRemove()).toBe(false);
    expect(screen.getByTestId('header-back')).toBeTruthy();

    await enterPin(screen);
    // Fire the press without awaiting the handler: setupPin stays pending.
    await act(async () => {
      void mockCompleteOnPress.current!();
    });
    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);

    // Hardware back / swipe / programmatic pop while setupPin is in flight.
    expect(navigation.emitBeforeRemove()).toBe(true);
    // Header back is hidden and the swipe gesture disabled.
    expect(screen.queryByTestId('header-back')).toBeNull();
    expect(navigation.setOptions).toHaveBeenLastCalledWith({
      gestureEnabled: false,
    });
    expect(navigation.goBack).not.toHaveBeenCalled();
    expect(getAccountSecret(id)?.mnemonic).toBe(FAKE_MNEMONIC);

    await act(async () => {
      pending.resolve();
    });

    expect(mockImportStandardAccount).toHaveBeenCalledWith(
      expect.objectContaining({ mnemonic: FAKE_MNEMONIC })
    );
    expect(getAccountSecret(id)).toBeUndefined();
    expect(navigation.navigate).toHaveBeenCalledWith('Main');
    await screen.unmount();
  });

  it('an unmount mid-setupPin does not strand the PIN: the import still runs, then releases', async () => {
    const pending = deferred();
    mockAuthSetupPin.mockImplementation(() => pending.promise);
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'create',
    });

    await enterPin(screen);
    await act(async () => {
      void mockCompleteOnPress.current!();
    });
    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);
    await screen.unmount();
    // Unmount cleanup skipped the clear because a submit is in flight.
    expect(getAccountSecret(id)?.mnemonic).toBe(FAKE_MNEMONIC);

    await act(async () => {
      pending.resolve();
    });

    expect(mockImportStandardAccount).toHaveBeenCalledWith(
      expect.objectContaining({ mnemonic: FAKE_MNEMONIC })
    );
    expect(getAccountSecret(id)).toBeUndefined();
  });

  it('a double-tap runs setupPin and the import once', async () => {
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'create',
    });
    await enterPin(screen);

    await act(async () => {
      const onPress = mockCompleteOnPress.current!;
      // Two taps in the same tick, before any re-render.
      void onPress();
      void onPress();
    });

    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);
    expect(mockImportStandardAccount).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });

  it('clears the secret on unmount without submitting', async () => {
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'create',
    });

    expect(getAccountSecret(id)?.mnemonic).toBe(FAKE_MNEMONIC);
    await screen.unmount();

    expect(getAccountSecret(id)).toBeUndefined();
    expect(mockImportStandardAccount).not.toHaveBeenCalled();
  });

  it('shows an error and never imports (or sets a PIN) when the secret is missing', async () => {
    // Cold-boot resume: the id rehydrates with the params, the store is empty.
    const { navigation, screen } = await renderScreen({
      mnemonicSecretId: 'account_secret_stale_id',
      source: 'create',
    });

    await submitPin(screen);

    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringMatching(UNAVAILABLE)
    );
    expect(mockImportStandardAccount).not.toHaveBeenCalled();
    expect(mockAuthSetupPin).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it('shows an error and never imports when no id was passed at all', async () => {
    const { navigation, screen } = await renderScreen({ source: 'mnemonic' });

    await submitPin(screen);

    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringMatching(UNAVAILABLE)
    );
    expect(mockImportStandardAccount).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it('re-checks at import time if the secret vanishes during PIN setup', async () => {
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    mockAuthSetupPin.mockImplementation(async () => {
      clearAccountSecret(id);
    });
    const { navigation, screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'create',
    });

    await submitPin(screen);

    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);
    expect(mockImportStandardAccount).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringMatching(UNAVAILABLE)
    );
    expect(navigation.navigate).not.toHaveBeenCalled();
    await screen.unmount();
  });
});
