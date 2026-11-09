/**
 * TASK-400 — the copy buttons on the transaction detail view showed an
 * "Address Copied" alert without writing anything to the clipboard (the handler
 * was a stub). These specs press each copy control and assert the clipboard
 * actually receives the value it shows.
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const FROM = 'FROMADDRESSFROMADDRESSFROMADDRESSFROMADDRESSFROMADDRESSAAAA';
const TO = 'TOADDRESSTOADDRESSTOADDRESSTOADDRESSTOADDRESSTOADDRESSBBBBB';
const TXID = 'TXIDTXIDTXIDTXIDTXIDTXIDTXIDTXIDTXIDTXIDTXIDTXIDTXID';

const mockSetString = jest.fn((_text: string) => Promise.resolve());
const mockAlertShow = jest.fn();

jest.mock('@/platform', () => ({
  clipboard: {
    setString: (text: string) => mockSetString(text),
    getString: jest.fn(() => Promise.resolve('')),
  },
  alert: { show: (...args: unknown[]) => mockAlertShow(...args) },
}));

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({
    params: {
      transaction: {
        id: TXID,
        from: FROM,
        to: TO,
        amount: 1_000_000,
        fee: 1_000,
        timestamp: 1_700_000_000,
        type: 'payment',
      },
      assetName: 'VOI',
      assetId: 0,
      accountAddress: FROM,
    },
  }),
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
}));

jest.mock('@/store/networkStore', () => ({
  useCurrentNetwork: () => 'voi-mainnet',
  useCurrentNetworkConfig: () => ({
    nativeToken: 'VOI',
  }),
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('@/services/envoi', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      getName: jest.fn(() => Promise.resolve(null)),
      configureForNetwork: jest.fn(),
    }),
  },
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('@/components/common/NFTBackground', () => ({
  NFTBackground: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/common/BlurredContainer', () => ({
  BlurredContainer: ({ children }: { children: React.ReactNode }) => children,
}));

import TransactionDetailScreen from '../TransactionDetailScreen';

describe('TransactionDetailScreen copy buttons (TASK-400)', () => {
  beforeEach(() => {
    mockSetString.mockClear();
    mockAlertShow.mockClear();
  });

  it.each([
    ['copy-transaction-id', TXID, 'Transaction ID copied to clipboard'],
    ['copy-from', FROM, 'Address copied to clipboard'],
    ['copy-to', TO, 'Address copied to clipboard'],
  ])('%s writes its value to the clipboard', async (testID, value, message) => {
    const { getByTestId } = await render(<TransactionDetailScreen />);
    await fireEvent.press(getByTestId(testID));
    await waitFor(() => expect(mockSetString).toHaveBeenCalledWith(value));
    expect(mockAlertShow).toHaveBeenCalledWith('Copied!', message);
  });
});
