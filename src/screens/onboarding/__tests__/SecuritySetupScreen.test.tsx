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
import { render, fireEvent, act, waitFor } from '@testing-library/react-native';

const mockImportStandardAccount = jest.fn();
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    importStandardAccount: (...args: unknown[]) =>
      mockImportStandardAccount(...args),
    addWatchAccount: jest.fn(),
    hasKeyBearingAccountStrict: jest.fn(),
  },
}));

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    PASSPHRASE_MIN_LENGTH: 12,
    hasPinStrict: jest.fn(),
    deletePin: jest.fn(),
    readAccountListStrict: jest.fn(),
    readPendingCreatesStrict: jest.fn(),
    probeSecretPresenceStrict: jest.fn(),
    clearBiometricSecret: jest.fn(),
    setBiometricEnabled: jest.fn(async () => {}),
    setBiometricSecret: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/secure/AccountSecureStorage', () =>
  jest.requireMock('@/services/secure')
);

jest.mock('@/services/wallet/crossStoreReconcile', () => ({
  reconcileCrossStoreHalfState: jest.fn(),
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
import { AccountSecureStorage } from '@/services/secure';
import { MultiAccountWalletService } from '@/services/wallet';
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import { ORPHAN_PIN_UNVERIFIABLE_MESSAGE } from '@/services/secure/orphanPin';
import SecuritySetupScreen from '../SecuritySetupScreen';
import {
  storeMnemonicSecret,
  getAccountSecret,
  clearAccountSecret,
  clearAllAccountSecrets,
  ScannedAccount,
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
  jest.mocked(reconcileCrossStoreHalfState).mockResolvedValue({
    ran: true,
    orphanSecretsDeleted: [],
    phantomAccountsPruned: [],
    staleJournalDropped: [],
  });
  jest
    .mocked(AccountSecureStorage.readAccountListStrict)
    .mockResolvedValue(['listed']);
  jest
    .mocked(AccountSecureStorage.readPendingCreatesStrict)
    .mockResolvedValue({ journaled: 'attempt' });
  jest
    .mocked(AccountSecureStorage.probeSecretPresenceStrict)
    .mockResolvedValue(false);
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.mocked(AccountSecureStorage.hasPinStrict).mockResolvedValue(false);
  jest.mocked(AccountSecureStorage.deletePin).mockResolvedValue(undefined);
  jest
    .mocked(AccountSecureStorage.clearBiometricSecret)
    .mockResolvedValue(undefined);
  jest
    .mocked(MultiAccountWalletService.hasKeyBearingAccountStrict)
    .mockResolvedValue(false);
  mockAuthSetupPin.mockResolvedValue(undefined);
  mockImportStandardAccount.mockResolvedValue({ address: 'FAKEADDRESS' });
});

afterEach(() => {
  clearAllAccountSecrets();
  jest.restoreAllMocks();
  jest.clearAllMocks();
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
    jest.mocked(AccountSecureStorage.hasPinStrict).mockResolvedValue(true);
    await fireEvent.press(screen.getByTestId('complete-setup'));

    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);
    expect(AccountSecureStorage.hasPinStrict).toHaveBeenCalledTimes(1);
    for (const fn of [
      reconcileCrossStoreHalfState,
      MultiAccountWalletService.hasKeyBearingAccountStrict,
      AccountSecureStorage.readAccountListStrict,
      AccountSecureStorage.readPendingCreatesStrict,
      AccountSecureStorage.probeSecretPresenceStrict,
      AccountSecureStorage.clearBiometricSecret,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
    expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
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

describe('SecuritySetupScreen — QR secret ownership (TASK-422)', () => {
  function qrAccount(secretId?: string): ScannedAccount {
    return {
      id: 'qr-standard',
      type: 'standard',
      address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
      name: 'QR account',
      secretId,
      isValid: true,
    };
  }

  it('keeps QR secrets readable on back and imports on the next setup visit', async () => {
    const secretId = storeMnemonicSecret(FAKE_MNEMONIC);
    const params = { source: 'qr', accounts: [qrAccount(secretId)] };
    const first = await renderScreen(params);
    await fireEvent.press(first.screen.getByTestId('header-back'));
    expect(first.navigation.goBack).toHaveBeenCalledTimes(1);
    await first.screen.unmount();
    expect(getAccountSecret(secretId)?.mnemonic).toBe(FAKE_MNEMONIC);
    expect(mockAuthSetupPin).not.toHaveBeenCalled();

    const retry = await renderScreen(params);
    await submitPin(retry.screen);
    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);
    expect(mockAuthSetupPin).toHaveBeenCalledWith('123456', 'pin');
    expect(mockImportStandardAccount).toHaveBeenCalledTimes(1);
    expect(mockImportStandardAccount).toHaveBeenCalledWith({
      type: 'standard',
      label: 'QR account',
      mnemonic: FAKE_MNEMONIC,
    });
    expect(retry.navigation.navigate).toHaveBeenCalledWith('Main');
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(getAccountSecret(secretId)).toBeUndefined();
    await retry.screen.unmount();
  });

  it.each(['cleared', 'absent', 'empty'])(
    'rejects a %s QR secret before PIN setup, even after a valid account',
    async (missing) => {
      const validId = storeMnemonicSecret(FAKE_MNEMONIC);
      const missingId = storeMnemonicSecret('');
      if (missing === 'cleared') clearAccountSecret(missingId);
      const { screen, navigation } = await renderScreen({
        source: 'qr',
        accounts: [
          qrAccount(validId),
          {
            ...qrAccount(missing === 'absent' ? undefined : missingId),
            id: 'missing',
          },
        ],
      });
      await submitPin(screen);
      expect(Alert.alert).toHaveBeenCalledWith(
        'Error',
        'Your account data is no longer available. Please go back and scan the QR code again.'
      );
      expect(mockAuthSetupPin).not.toHaveBeenCalled();
      expect(AccountSecureStorage.hasPinStrict).not.toHaveBeenCalled();
      expect(mockImportStandardAccount).not.toHaveBeenCalled();
      expect(navigation.navigate).not.toHaveBeenCalled();
      expect(getAccountSecret(validId)?.mnemonic).toBe(FAKE_MNEMONIC);
      await screen.unmount();
    }
  );
});

describe('SecuritySetupScreen — orphan PIN healing (TASK-413)', () => {
  it.each(['create', 'mnemonic', 'qr', 'watch', 'restore', 'ledger'])(
    'clears an orphan before first-secret setup for %s',
    async (source) => {
      const order: string[] = [];
      jest.mocked(AccountSecureStorage.hasPinStrict).mockResolvedValue(true);
      jest
        .mocked(AccountSecureStorage.deletePin)
        .mockImplementation(async () => {
          order.push('delete');
        });
      jest
        .mocked(AccountSecureStorage.clearBiometricSecret)
        .mockImplementation(async () => {
          order.push('clear');
        });
      jest
        .mocked(AccountSecureStorage.setBiometricEnabled)
        .mockImplementation(async () => {
          order.push('disable');
        });
      mockAuthSetupPin.mockImplementation(async () => {
        order.push('setup');
      });
      mockImportStandardAccount.mockImplementation(async () => {
        order.push('import');
        return { address: 'FAKEADDRESS' };
      });
      const secretId = storeMnemonicSecret(FAKE_MNEMONIC);
      const account = {
        id: 'orphan-healing-account',
        type: source === 'watch' ? 'watch' : 'standard',
        address: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
        name: 'Recovered account',
        isValid: true,
        isDuplicate: false,
        ...(source === 'qr' ? { secretId } : {}),
      };
      const { screen, navigation } = await renderScreen({
        source,
        mnemonicSecretId: secretId,
        ...(['qr', 'watch'].includes(source) ? { accounts: [account] } : {}),
      });
      await submitPin(screen, '654321');
      expect(order.slice(0, 4)).toEqual([
        'delete',
        'clear',
        'disable',
        'setup',
      ]);
      const at = (fn: unknown, n = 0) =>
        jest.mocked(fn as jest.Mock).mock.invocationCallOrder[n];
      const calls = [
        at(AccountSecureStorage.readAccountListStrict, 0),
        at(AccountSecureStorage.readPendingCreatesStrict, 0),
        at(reconcileCrossStoreHalfState),
        at(AccountSecureStorage.readAccountListStrict, 1),
        at(AccountSecureStorage.readPendingCreatesStrict, 1),
        at(AccountSecureStorage.probeSecretPresenceStrict),
        at(AccountSecureStorage.deletePin),
        at(AccountSecureStorage.clearBiometricSecret),
        at(mockAuthSetupPin),
      ];
      expect(calls.every((c) => typeof c === 'number')).toBe(true);
      expect(calls).toEqual([...calls].sort((a, b) => a - b));
      expect(mockAuthSetupPin).toHaveBeenCalledWith('654321', 'pin');
      if (source === 'create' || source === 'mnemonic') {
        expect(order).toEqual([
          'delete',
          'clear',
          'disable',
          'setup',
          'disable',
          'import',
        ]);
      }
      if (source === 'qr') {
        expect(mockImportStandardAccount).toHaveBeenCalledTimes(1);
        expect(mockImportStandardAccount).toHaveBeenCalledWith({
          type: 'standard',
          label: 'Recovered account',
          mnemonic: FAKE_MNEMONIC,
        });
        expect(
          MultiAccountWalletService.addWatchAccount
        ).not.toHaveBeenCalled();
        expect(getAccountSecret(secretId)).toBeUndefined();
      }
      if (source === 'watch') {
        expect(MultiAccountWalletService.addWatchAccount).toHaveBeenCalledTimes(
          1
        );
        expect(MultiAccountWalletService.addWatchAccount).toHaveBeenCalledWith({
          type: 'watch',
          address: account.address,
          label: 'Recovered account',
        });
        expect(mockImportStandardAccount).not.toHaveBeenCalled();
      }
      expect(navigation.navigate).toHaveBeenCalledWith('Main');
      await screen.unmount();
    }
  );

  it.each([
    'probe failure (fail-open regression)',
    'reconcile skipped',
    'reconcile throws',
    'listed secret',
    'journaled secret',
    'list read failure',
    'journal read failure',
    'keys',
    'delete refusal',
    'PIN read failure',
    'account read failure',
  ])('fails closed on %s', async (failure) => {
    jest.mocked(AccountSecureStorage.hasPinStrict).mockResolvedValue(true);
    if (failure === 'probe failure (fail-open regression)')
      jest
        .mocked(AccountSecureStorage.probeSecretPresenceStrict)
        .mockRejectedValue(new Error('timeout'));
    if (failure === 'reconcile skipped')
      jest.mocked(reconcileCrossStoreHalfState).mockResolvedValue({
        ran: false,
        orphanSecretsDeleted: [],
        phantomAccountsPruned: [],
        staleJournalDropped: [],
      });
    if (failure === 'reconcile throws')
      jest
        .mocked(reconcileCrossStoreHalfState)
        .mockRejectedValue(new Error('timeout'));
    if (failure === 'listed secret' || failure === 'journaled secret')
      jest
        .mocked(AccountSecureStorage.probeSecretPresenceStrict)
        .mockImplementation(
          async (id) =>
            id === (failure === 'listed secret' ? 'listed' : 'journaled')
        );
    if (failure === 'list read failure')
      jest
        .mocked(AccountSecureStorage.readAccountListStrict)
        .mockRejectedValue(new Error('timeout'));
    if (failure === 'journal read failure')
      jest
        .mocked(AccountSecureStorage.readPendingCreatesStrict)
        .mockRejectedValue(new Error('timeout'));
    if (failure === 'keys')
      jest
        .mocked(MultiAccountWalletService.hasKeyBearingAccountStrict)
        .mockResolvedValue(true);
    if (failure === 'delete refusal')
      jest
        .mocked(AccountSecureStorage.deletePin)
        .mockRejectedValue(new Error('private details'));
    if (failure === 'PIN read failure')
      jest
        .mocked(AccountSecureStorage.hasPinStrict)
        .mockRejectedValue(new Error('private details'));
    if (failure === 'account read failure')
      jest
        .mocked(MultiAccountWalletService.hasKeyBearingAccountStrict)
        .mockRejectedValue(new Error('private details'));
    const { screen, navigation } = await renderScreen({
      source: 'create',
      mnemonicSecretId: storeMnemonicSecret(FAKE_MNEMONIC),
    });
    await submitPin(screen);
    expect(mockAuthSetupPin).not.toHaveBeenCalled();
    expect(mockImportStandardAccount).not.toHaveBeenCalled();
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      'Failed to setup wallet security: ' + ORPHAN_PIN_UNVERIFIABLE_MESSAGE
    );
    if (failure !== 'delete refusal')
      expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
    expect(AccountSecureStorage.clearBiometricSecret).not.toHaveBeenCalled();
    expect(navigation.emitBeforeRemove()).toBe(false);
    expect(screen.getByTestId('header-back')).toBeTruthy();
    await screen.unmount();
  });

  it('releases the submit when the PIN read never settles', async () => {
    jest
      .mocked(AccountSecureStorage.hasPinStrict)
      .mockReturnValue(new Promise<never>(() => {}));
    const { screen, navigation } = await renderScreen({
      source: 'create',
      mnemonicSecretId: storeMnemonicSecret(FAKE_MNEMONIC),
    });
    // Real timers: the press awaits the handler, so the 1500ms bound elapses.
    await submitPin(screen);
    expect(mockAuthSetupPin).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      'Failed to setup wallet security: ' + ORPHAN_PIN_UNVERIFIABLE_MESSAGE
    );
    // The timeout settles outside act, so wait for the released header.
    await waitFor(() => expect(screen.getByTestId('header-back')).toBeTruthy());
    expect(navigation.emitBeforeRemove()).toBe(false);
    await screen.unmount();
  });

  it('keeps first-secret setup unchanged when no PIN exists', async () => {
    const { screen } = await renderScreen({
      source: 'create',
      mnemonicSecretId: storeMnemonicSecret(FAKE_MNEMONIC),
    });
    await submitPin(screen);
    expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
    expect(
      MultiAccountWalletService.hasKeyBearingAccountStrict
    ).not.toHaveBeenCalled();
    expect(mockAuthSetupPin).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});
