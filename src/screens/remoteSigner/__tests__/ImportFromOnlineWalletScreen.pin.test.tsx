/**
 * TASK-522: the airgap import stores a private key, so it must not run on a
 * wallet with no PIN. With no PIN the screen says to set one first, opens no
 * scanner, and stores nothing; a PIN gone by scan time also stores nothing.
 *
 * SECURITY NOTE: the key is a throwaway account generated at runtime; storage
 * and wallet services are mocked.
 */
import React from 'react';
import algosdk from 'algosdk';
import { act, fireEvent, render } from '@testing-library/react-native';

const mockHasPin = jest.fn(async () => true);
const mockStoreCalls = {
  storeAccount: jest.fn(),
  storeAccountForCreation: jest.fn(),
  storeAccountForRestore: jest.fn(),
  storeAccountLocked: jest.fn(),
};
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    hasPin: () => mockHasPin(),
    ...mockStoreCalls,
  },
}));

const mockImportStandardAccount = jest.fn();
const mockGetAllAccounts = jest.fn(async () => []);
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    importStandardAccount: (...args: unknown[]) =>
      mockImportStandardAccount(...args),
    getAllAccounts: () => mockGetAllAccounts(),
  },
}));

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

const mockRefresh = jest.fn(async () => {});
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (selector: (state: unknown) => unknown) =>
    selector({ refresh: mockRefresh }),
}));
jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => 'voi-mainnet',
}));
jest.mock('@/services/network/config', () => ({
  getNetworkConfig: () => ({
    genesisHash: require('buffer').Buffer.alloc(32).toString('base64'),
    genesisId: 'test-v1',
  }),
}));
jest.mock('@/services/remoteSigner', () => ({
  RemoteSignerService: {
    createSuccessResponse: jest.fn(() => ({})),
    encodePayload: jest.fn(() => 'payload'),
  },
}));

const mockAccount = algosdk.generateAccount();
jest.mock('@/utils/arc0300', () => ({
  parseArc0300AccountImportUri: () => ({
    kind: 'standard',
    entries: [{ privateKeyBase64: 'fake', name: 'Airgap' }],
  }),
  normalizeBase64ToHex: () =>
    require('buffer').Buffer.from(mockAccount.sk).toString('hex'),
}));

jest.mock('@/components/remoteSigner/AnimatedQRScanner', () => {
  const { Button } = require('react-native');
  return {
    AnimatedQRScanner: ({ onScan }: { onScan: (data: string) => void }) => (
      <Button title="Fake scan" onPress={() => onScan('fake-uri')} />
    ),
  };
});
jest.mock('@/components/remoteSigner/AnimatedQRCode', () => ({
  AnimatedQRCode: () => null,
}));
jest.mock('@/hooks/useSecureScreen', () => ({ useSecureScreen: () => {} }));
jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: require('react-native').View,
}));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import ImportFromOnlineWalletScreen from '../ImportFromOnlineWalletScreen';

const SET_PIN_FIRST =
  'Set a PIN first. Add or import an account on this device to set one.';

function expectNothingStored() {
  expect(mockImportStandardAccount).not.toHaveBeenCalled();
  for (const store of Object.values(mockStoreCalls)) {
    expect(store).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  mockHasPin.mockReset().mockResolvedValue(true);
  mockImportStandardAccount.mockResolvedValue({
    label: 'Airgap',
    address: mockAccount.addr.toString(),
  });
});

describe('ImportFromOnlineWalletScreen — no PIN (TASK-522)', () => {
  it('no PIN: says to set one first, opens no scanner, stores nothing', async () => {
    mockHasPin.mockResolvedValue(false);
    const screen = await render(<ImportFromOnlineWalletScreen />);

    await fireEvent.press(screen.getByText('Start Scanning'));

    expect(await screen.findByText(SET_PIN_FIRST)).toBeTruthy();
    expect(screen.queryByText('Fake scan')).toBeNull();
    expect(mockHasPin).toHaveBeenCalledTimes(1);
    expect(mockGetAllAccounts).not.toHaveBeenCalled();
    expectNothingStored();
  });

  it('a failed PIN read opens no scanner and stores nothing', async () => {
    mockHasPin.mockRejectedValue(new Error('keychain unavailable'));
    const screen = await render(<ImportFromOnlineWalletScreen />);

    await fireEvent.press(screen.getByText('Start Scanning'));

    expect(
      await screen.findByText(
        "We couldn't verify your wallet's security state. Please restart the app."
      )
    ).toBeTruthy();
    expect(screen.queryByText('Fake scan')).toBeNull();
    expectNothingStored();
  });

  it('a PIN gone by scan time stores nothing', async () => {
    const screen = await render(<ImportFromOnlineWalletScreen />);
    await fireEvent.press(screen.getByText('Start Scanning'));
    mockHasPin.mockResolvedValue(false);

    await act(async () => {
      fireEvent.press(await screen.findByText('Fake scan'));
    });

    expect(await screen.findByText(SET_PIN_FIRST)).toBeTruthy();
    expectNothingStored();
  });

  it('with a PIN: scans and imports, as before', async () => {
    const screen = await render(<ImportFromOnlineWalletScreen />);
    await fireEvent.press(screen.getByText('Start Scanning'));

    await act(async () => {
      fireEvent.press(await screen.findByText('Fake scan'));
    });

    expect(mockImportStandardAccount).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Account imported successfully!')
    ).toBeTruthy();
  });
});
