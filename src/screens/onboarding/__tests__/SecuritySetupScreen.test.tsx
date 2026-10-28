/**
 * TASK-224 — SecuritySetupScreen consumes the recovery phrase from the
 * in-memory secret holder via an opaque `mnemonicSecretId` route param.
 *
 * Contracts pinned here:
 * - the phrase is read from the holder at import time and the entry is
 *   cleared on success AND on import failure;
 * - unmounting without submitting (back / swipe / hardware back) clears it;
 * - a missing entry (e.g. TASK-213 cold boot: params rehydrate, memory does
 *   not) shows an error and never calls importStandardAccount, and never sets a
 *   PIN first.
 *
 * SECURITY NOTE: obviously-fake phrase only; wallet/secure services are mocked.
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

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

jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));

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
    }) => (
      <TouchableOpacity testID="complete-setup" onPress={onPress}>
        <Text>{label}</Text>
      </TouchableOpacity>
    ),
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

function makeNavigation() {
  return { navigate: jest.fn(), goBack: jest.fn() };
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

async function submitPin(screen: Awaited<ReturnType<typeof render>>) {
  await fireEvent.changeText(
    screen.getByPlaceholderText('Enter PIN'),
    '123456'
  );
  await fireEvent.changeText(
    screen.getByPlaceholderText('Confirm PIN'),
    '123456'
  );
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

  it('clears the secret when the import fails', async () => {
    mockImportStandardAccount.mockRejectedValue(new Error('import boom'));
    const id = storeMnemonicSecret(FAKE_MNEMONIC);
    const { navigation, screen } = await renderScreen({
      mnemonicSecretId: id,
      source: 'mnemonic',
    });

    await submitPin(screen);

    expect(mockImportStandardAccount).toHaveBeenCalledTimes(1);
    expect(getAccountSecret(id)).toBeUndefined();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      expect.stringContaining('import boom')
    );
    expect(navigation.navigate).not.toHaveBeenCalled();
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
