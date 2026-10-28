/** TASK-417: screen contracts, with the strict onboarding decision mocked at
 * its module boundary. Only obviously fake secret material is used. */
import React from 'react';
import { Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const mockNavigation = {
  navigate: jest.fn(),
  replace: jest.fn(),
  goBack: jest.fn(),
  setOptions: jest.fn(),
};
let mockParams: { isOnboarding?: boolean } = {};
const mockAddWatchAccount = jest.fn();
const mockRefresh = jest.fn();
const mockExistingAccounts: never[] = [];
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useRoute: () => ({ params: mockParams }),
  useFocusEffect: () => {},
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({ addWatchAccount: mockAddWatchAccount, refresh: mockRefresh }),
  useAccounts: () => mockExistingAccounts,
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    importStandardAccount: jest.fn(),
    addWatchAccount: jest.fn(),
    importLedgerAccount: jest.fn(),
    detectLedgerAccounts: jest.fn(),
  },
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: { hasPin: jest.fn() },
}));
jest.mock('@/services/secure/orphanPin', () => ({
  onboardingNeedsSecuritySetup: jest.fn(),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('@/components/common/KeyboardAwareScrollView', () => ({
  __esModule: true,
  default: require('react-native').ScrollView,
}));
jest.mock('@/utils/clipboard', () => ({ getFromClipboard: jest.fn() }));
jest.mock('@/components/account/AccountImportItem', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    getConnectedDevice: () => ({ id: 'fake-ledger', name: 'Test Ledger' }),
  },
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/components/ledger/ConnectionModal', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/ledger/AccountImport', () => ({
  __esModule: true,
  default: ({ footerComponent }: { footerComponent: React.ReactNode }) =>
    footerComponent,
}));
jest.mock('@/components/ledger/AccountPreview', () => {
  const { Button } = require('react-native');
  return {
    __esModule: true,
    default: ({ onImportAccounts }: { onImportAccounts: () => void }) => (
      <Button title="Import Ledger selection" onPress={onImportAccounts} />
    ),
  };
});
jest.mock('@/components/auth-account/AuthAccountDiscovery', () => {
  const { Button } = require('react-native');
  return {
    __esModule: true,
    default: ({ onSkip }: { onSkip: () => void }) => (
      <Button title="Skip discovery" onPress={onSkip} />
    ),
  };
});
jest.mock('expo-camera', () => {
  const { View } = require('react-native');
  return {
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
    CameraView: (props: Record<string, unknown>) => (
      <View {...props} testID="camera" />
    ),
  };
});

import AccountImportPreviewScreen from '../AccountImportPreviewScreen';
import AddWatchAccountScreen from '../AddWatchAccountScreen';
import LedgerAccountImportScreen from '../LedgerAccountImportScreen';
import QRAccountImportScreen from '../QRAccountImportScreen';
import { AccountSecureStorage } from '@/services/secure';
import { onboardingNeedsSecuritySetup } from '@/services/secure/orphanPin';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import {
  AccountQRParser,
  clearAllAccountSecrets,
  ScannedAccount,
  storeMnemonicSecret,
} from '@/utils/accountQRParser';

const FAKE_MNEMONIC = Array(25).fill('fake-word-not-real').join(' ');
// Algorand's valid zero address; no corresponding private key is used.
const WATCH_ADDRESS =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const mockLedgerAccount = {
  derivationIndex: 0,
  derivationPath: "m/44'/283'/0'/0/0",
  address: WATCH_ADDRESS,
  publicKey: '00'.repeat(32),
  existsInWallet: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.mocked(AccountSecureStorage.hasPin).mockResolvedValue(true);
  jest.mocked(onboardingNeedsSecuritySetup).mockResolvedValue(true);
  jest
    .mocked(MultiAccountWalletService.detectLedgerAccounts)
    .mockResolvedValue([mockLedgerAccount]);
});
afterEach(() => {
  jest.restoreAllMocks();
  clearAllAccountSecrets();
});

async function pressAlert(title: string, button: string) {
  const call = jest
    .mocked(Alert.alert)
    .mock.calls.findLast(([t]) => t === title);
  expect(call).toBeDefined();
  const action = call?.[2]?.find((item) => item.text === button)?.onPress;
  expect(action).toEqual(expect.any(Function));
  await act(async () => {
    await action?.();
  });
}
function expectNoDirectImport() {
  expect(
    MultiAccountWalletService.importStandardAccount
  ).not.toHaveBeenCalled();
  expect(MultiAccountWalletService.addWatchAccount).not.toHaveBeenCalled();
  expect(mockAddWatchAccount).not.toHaveBeenCalled();
}

async function renderQRPreview(isOnboarding?: boolean) {
  const accounts: ScannedAccount[] = [
    {
      id: 'qr-standard',
      type: 'standard',
      name: 'QR account',
      address: WATCH_ADDRESS,
      secretId: storeMnemonicSecret(FAKE_MNEMONIC),
      isValid: true,
      isDuplicate: false,
    },
  ];
  const screen = await render(
    <AccountImportPreviewScreen
      navigation={mockNavigation as never}
      route={{ params: { accounts, isOnboarding } } as never}
    />
  );
  await fireEvent.press(screen.getByText('Import Selected'));
  return { screen, accounts };
}

describe('QR preview onboarding decision', () => {
  it('routes an orphan PIN to SecuritySetup with selected accounts', async () => {
    const { accounts } = await renderQRPreview(true);
    await pressAlert('Import Accounts', 'Import');
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('SecuritySetup', {
      accounts,
      source: 'qr',
    });
    expect(onboardingNeedsSecuritySetup).toHaveBeenCalledTimes(1);
    expect(AccountSecureStorage.hasPin).not.toHaveBeenCalled();
    expectNoDirectImport();
  });

  it('directly imports with a key-bearing PIN and continues to Main', async () => {
    jest.mocked(onboardingNeedsSecuritySetup).mockResolvedValue(false);
    await renderQRPreview(true);
    await pressAlert('Import Accounts', 'Import');
    expect(
      MultiAccountWalletService.importStandardAccount
    ).toHaveBeenCalledTimes(1);
    expect(
      MultiAccountWalletService.importStandardAccount
    ).toHaveBeenCalledWith({
      type: AccountType.STANDARD,
      label: 'QR account',
      mnemonic: FAKE_MNEMONIC,
    });
    expect(onboardingNeedsSecuritySetup).toHaveBeenCalledTimes(1);
    expect(AccountSecureStorage.hasPin).not.toHaveBeenCalled();
    await pressAlert('Import Complete', 'OK');
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Main', {
      screen: 'Home',
    });
  });

  it('alerts on a rejected check, imports nothing, and releases loading', async () => {
    jest
      .mocked(onboardingNeedsSecuritySetup)
      .mockRejectedValueOnce(new Error('strict read failed'));
    const { screen } = await renderQRPreview(true);
    await pressAlert('Import Accounts', 'Import');
    expect(Alert.alert).toHaveBeenCalledWith(
      'Import Error',
      'An unexpected error occurred during import. Please try again.',
      [{ text: 'OK' }]
    );
    expectNoDirectImport();
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(screen.queryByText('Importing...')).toBeNull();
    // A second real press reaches the decision again: the button was released.
    await fireEvent.press(screen.getByText('Import Selected'));
    await pressAlert('Import Accounts', 'Import');
    expect(onboardingNeedsSecuritySetup).toHaveBeenCalledTimes(2);
    expect(mockNavigation.navigate).toHaveBeenCalledWith(
      'SecuritySetup',
      expect.anything()
    );
  });

  it.each([true, false])(
    'outside onboarding uses hasPin() = %s',
    async (hasPin) => {
      jest.mocked(AccountSecureStorage.hasPin).mockResolvedValue(hasPin);
      const { accounts } = await renderQRPreview(false);
      await pressAlert('Import Accounts', 'Import');
      expect(AccountSecureStorage.hasPin).toHaveBeenCalledTimes(1);
      expect(onboardingNeedsSecuritySetup).not.toHaveBeenCalled();
      if (hasPin) {
        expect(
          MultiAccountWalletService.importStandardAccount
        ).toHaveBeenCalledTimes(1);
      } else {
        expect(mockNavigation.navigate).toHaveBeenCalledWith('SecuritySetup', {
          accounts,
          source: 'qr',
        });
        expectNoDirectImport();
      }
    }
  );
});

async function renderWatch(isOnboarding?: boolean) {
  mockParams = { isOnboarding };
  const screen = await render(<AddWatchAccountScreen />);
  await fireEvent.changeText(
    screen.getByPlaceholderText('Enter address (58 characters)'),
    WATCH_ADDRESS
  );
  await fireEvent.changeText(
    screen.getByPlaceholderText('e.g., Trading Account, Cold Storage'),
    'My watch'
  );
  return screen;
}
async function submitWatch(screen: Awaited<ReturnType<typeof render>>) {
  await fireEvent.press(screen.getAllByText('Add Watch Account').at(-1)!);
}

describe('watch onboarding decision', () => {
  it('routes an orphan PIN to SecuritySetup with one watch account', async () => {
    const screen = await renderWatch(true);
    await submitWatch(screen);
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('SecuritySetup', {
      source: 'watch',
      accounts: [
        {
          id: expect.stringMatching(/^watch-/),
          address: WATCH_ADDRESS,
          name: 'My watch',
          type: 'watch',
          isValid: true,
          isDuplicate: false,
        },
      ],
    });
    expect(onboardingNeedsSecuritySetup).toHaveBeenCalledTimes(1);
    expect(AccountSecureStorage.hasPin).not.toHaveBeenCalled();
    expectNoDirectImport();
  });

  it('adds the watch account with a key-bearing PIN and continues to Main', async () => {
    jest.mocked(onboardingNeedsSecuritySetup).mockResolvedValue(false);
    const screen = await renderWatch(true);
    await submitWatch(screen);
    expect(mockAddWatchAccount).toHaveBeenCalledTimes(1);
    expect(mockAddWatchAccount).toHaveBeenCalledWith({
      type: AccountType.WATCH,
      address: WATCH_ADDRESS,
      label: 'My watch',
      notes: undefined,
    });
    expect(onboardingNeedsSecuritySetup).toHaveBeenCalledTimes(1);
    expect(AccountSecureStorage.hasPin).not.toHaveBeenCalled();
    await pressAlert('Success', 'OK');
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Main');
  });

  it('alerts on a rejected check, imports nothing, and releases loading', async () => {
    jest
      .mocked(onboardingNeedsSecuritySetup)
      .mockRejectedValueOnce(new Error('strict read failed'));
    const screen = await renderWatch(true);
    await submitWatch(screen);
    expect(Alert.alert).toHaveBeenCalledWith(
      'Error',
      'strict read failed',
      undefined
    );
    expectNoDirectImport();
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    await submitWatch(screen);
    expect(onboardingNeedsSecuritySetup).toHaveBeenCalledTimes(2);
    expect(mockNavigation.navigate).toHaveBeenCalledWith(
      'SecuritySetup',
      expect.anything()
    );
  });

  it('outside onboarding preserves direct add and back without a PIN check', async () => {
    const screen = await renderWatch(false);
    await submitWatch(screen);
    expect(mockAddWatchAccount).toHaveBeenCalledTimes(1);
    expect(onboardingNeedsSecuritySetup).not.toHaveBeenCalled();
    expect(AccountSecureStorage.hasPin).not.toHaveBeenCalled();
    await pressAlert('Success', 'OK');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
  });
});

async function renderLedger(isOnboarding: boolean) {
  const screen = await render(
    <LedgerAccountImportScreen
      navigation={mockNavigation as never}
      route={{ params: { isOnboarding } } as never}
    />
  );
  await waitFor(() =>
    expect(
      MultiAccountWalletService.detectLedgerAccounts
    ).toHaveBeenCalledTimes(1)
  );
  await fireEvent.press(screen.getByText('Import Ledger selection'));
  expect(MultiAccountWalletService.importLedgerAccount).toHaveBeenCalledTimes(
    1
  );
  expect(onboardingNeedsSecuritySetup).not.toHaveBeenCalled();
  return screen;
}
function expectOnlyLedgerImport() {
  expectNoDirectImport();
  // Ledger imports before completion; finishing must never import again.
  expect(MultiAccountWalletService.importLedgerAccount).toHaveBeenCalledTimes(
    1
  );
}

describe('Ledger onboarding completion decision', () => {
  it('replaces with SecuritySetup for an orphan PIN without importing again', async () => {
    await renderLedger(true);
    await pressAlert('Ledger Import Complete', 'Continue');
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('SecuritySetup', {
      source: 'ledger',
    });
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(onboardingNeedsSecuritySetup).toHaveBeenCalledTimes(1);
    expect(AccountSecureStorage.hasPin).not.toHaveBeenCalled();
    expectOnlyLedgerImport();
  });

  it('continues to Main with a key-bearing PIN', async () => {
    jest.mocked(onboardingNeedsSecuritySetup).mockResolvedValue(false);
    await renderLedger(true);
    await pressAlert('Ledger Import Complete', 'Continue');
    expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).toHaveBeenCalledWith('Main');
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expectOnlyLedgerImport();
  });

  it('preserves the catch fallback to SecuritySetup on a rejected check', async () => {
    jest
      .mocked(onboardingNeedsSecuritySetup)
      .mockRejectedValueOnce(new Error('strict read failed'));
    await renderLedger(true);
    await pressAlert('Ledger Import Complete', 'Continue');
    expect(mockNavigation.replace).toHaveBeenCalledTimes(1);
    expect(mockNavigation.replace).toHaveBeenCalledWith('SecuritySetup', {
      source: 'ledger',
    });
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expectOnlyLedgerImport();
  });

  it('outside onboarding preserves back without a PIN check', async () => {
    const screen = await renderLedger(false);
    await pressAlert('Ledger Import Complete', 'Search for Rekeyed Accounts');
    await fireEvent.press(screen.getByText('Skip discovery'));
    await pressAlert('Skip Auth Discovery', 'Skip');
    expect(mockNavigation.goBack).toHaveBeenCalledTimes(1);
    expect(mockNavigation.navigate).not.toHaveBeenCalled();
    expect(mockNavigation.replace).not.toHaveBeenCalled();
    expect(onboardingNeedsSecuritySetup).not.toHaveBeenCalled();
    expect(AccountSecureStorage.hasPin).not.toHaveBeenCalled();
    expectOnlyLedgerImport();
  });
});

describe('QR camera handoff', () => {
  it.each([true, false, undefined])(
    'forwards isOnboarding = %s to preview',
    async (isOnboarding) => {
      const accounts: ScannedAccount[] = [
        {
          id: 'scanned-watch',
          type: 'watch',
          address: WATCH_ADDRESS,
          isValid: true,
        },
      ];
      jest.spyOn(AccountQRParser, 'parseQRContent').mockResolvedValue({
        isAccountData: true,
        accounts,
      });
      const screen = await render(
        <QRAccountImportScreen
          navigation={mockNavigation as never}
          route={{ params: { isOnboarding } } as never}
        />
      );
      await fireEvent(screen.getByTestId('camera'), 'barcodeScanned', {
        data: 'fake-qr-content',
      });
      expect(AccountQRParser.parseQRContent).toHaveBeenCalledWith(
        'fake-qr-content',
        mockExistingAccounts
      );
      expect(mockNavigation.navigate).toHaveBeenCalledTimes(1);
      expect(mockNavigation.navigate).toHaveBeenCalledWith(
        'AccountImportPreview',
        { accounts, source: 'qr', isOnboarding }
      );
    }
  );
});
