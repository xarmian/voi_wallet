/**
 * Wiring test for the air-gapped signer's review (TASK-445, folded into
 * TASK-440 #243): the real decoder feeds the shared danger detector and
 * banner, and Sign waits for the acknowledgment. Transactions are real
 * algosdk v3 objects; only the network read, navigation and the auth modal
 * are stubbed.
 */

// Same native-module stubs as the service's decodeTransaction tests.
jest.mock('@ledgerhq/react-native-hw-transport-ble', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('@ledgerhq/react-native-hid', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('@ledgerhq/hw-transport', () => ({
  __esModule: true,
  default: class {},
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => {}),
  },
}));

let mockRequest: any;
const mockNavigate = jest.fn();
let mockAuthVisible = false;
const mockGetAssetInfo = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useRoute: () => ({ params: { request: mockRequest } }),
  useFocusEffect: () => {},
}));

jest.mock('@/store/remoteSignerStore', () => ({
  useRemoteSignerStore: (select: (s: any) => unknown) =>
    select({ setPendingRequest: jest.fn() }),
}));

jest.mock('@/components/remoteSigner/SignerAuthModal', () => ({
  __esModule: true,
  default: (props: { visible: boolean }) => {
    mockAuthVisible = props.visible;
    return null;
  },
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId: string) => ({
      getCachedAssetParams: async () => null,
      getAssetInfo: (assetId: number) => mockGetAssetInfo(networkId, assetId),
    }),
  },
}));

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import { makeAccount } from '@/__tests__/fixtures/algorand';
import { NetworkId } from '@/types/network';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';
import TransactionReviewScreen from '../TransactionReviewScreen';

const VOI = NetworkId.VOI_MAINNET;
const config = NETWORK_CONFIGURATIONS[VOI];
const PARAMS: algosdk.SuggestedParams = {
  fee: 1000,
  firstValid: 1,
  lastValid: 1001,
  genesisID: config.genesisId,
  genesisHash: new Uint8Array(Buffer.from(config.genesisHash, 'base64')),
  flatFee: true,
  minFee: 1000,
};
const b64 = (txn: algosdk.Transaction) =>
  Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64');

const manager = makeAccount('rs-manager').addr.toString();
const attacker = makeAccount('rs-attacker').addr.toString();
const reserve = makeAccount('rs-reserve').addr.toString();

beforeEach(() => {
  mockAuthVisible = false;
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockGetAssetInfo.mockResolvedValue({
    params: { manager, reserve, freeze: reserve, clawback: reserve },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

const reconfigRequest = () => ({
  txns: [
    {
      b: b64(
        algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
          sender: manager,
          assetIndex: 4242n,
          manager: attacker,
          reserve,
          freeze: reserve,
          clawback: reserve,
          strictEmptyAddressChecking: false,
          suggestedParams: PARAMS,
        })
      ),
    },
  ],
});

// Negative control: at 50993c5 this screen showed no warning for an acfg
// hand-over, and Sign opened the auth modal straight away.
it('lists an asset authority hand-over and gates Sign on the acknowledgment', async () => {
  mockRequest = reconfigRequest();
  const view = await render(<TransactionReviewScreen />);

  expect(
    await view.findByText(
      new RegExp(
        `Transaction 1: ${manager} gives the manager authority of asset #4242 to ${attacker}\\.$`
      )
    )
  ).toBeTruthy();
  expect(mockGetAssetInfo).toHaveBeenCalledWith(VOI, 4242);
  // Unchanged roles are not listed.
  expect(view.queryByText(/reserve authority/)).toBeNull();

  await fireEvent.press(view.getByText(/^Sign/));
  expect(mockAuthVisible).toBe(false);

  await fireEvent.press(
    view.getByLabelText('Acknowledge dangerous transaction warning')
  );
  await fireEvent.press(view.getByText(/^Sign/));
  await waitFor(() => expect(mockAuthVisible).toBe(true));
});

it('marks authority changes unverified when the signer is offline', async () => {
  mockGetAssetInfo.mockRejectedValue(new Error('offline'));
  mockRequest = reconfigRequest();
  const view = await render(<TransactionReviewScreen />);

  await waitFor(() => expect(mockGetAssetInfo).toHaveBeenCalled());
  expect(
    await view.findByText(
      /gives the reserve authority of asset #4242 .*unverified/
    )
  ).toBeTruthy();
});

it('shows no banner and does not gate a plain payment', async () => {
  mockRequest = {
    txns: [
      {
        b: b64(
          algosdk.makePaymentTxnWithSuggestedParamsFromObject({
            sender: manager,
            receiver: attacker,
            amount: 1,
            suggestedParams: PARAMS,
          })
        ),
      },
    ],
  };
  const view = await render(<TransactionReviewScreen />);

  expect(view.queryByText(/Dangerous operation/)).toBeNull();
  await fireEvent.press(view.getByText(/^Sign/));
  await waitFor(() => expect(mockAuthVisible).toBe(true));
});
