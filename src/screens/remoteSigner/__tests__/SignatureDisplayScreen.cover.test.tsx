import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import algosdk from 'algosdk';
import type {
  RemoteSignerRequest,
  RemoteSignerResponse,
} from '@/types/remoteSigner';
import { resetCoverForTests, setCovered } from '@/utils/lockCover';
import SignatureDisplayScreen from '../SignatureDisplayScreen';

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, popToTop: jest.fn() }),
  useRoute: () => ({ params: mockRouteParams }),
}));
jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));
jest.mock('@/hooks/useThemedStyles', () => ({ useThemedStyles: () => ({}) }));
jest.mock('@/hooks/useSecureScreen', () => ({ useSecureScreen: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/remoteSigner', () => ({
  AnimatedQRCode: ({ data }: { data: string }) =>
    require('react').createElement(require('react-native').Text, {
      testID: 'response-qr',
      children: data,
    }),
}));
jest.mock('@/store/remoteSignerStore', () => ({
  useRemoteSignerStore: (
    selector: (state: {
      markRequestProcessed: typeof mockMarkRequestProcessed;
      setPendingRequest: typeof mockSetPendingRequest;
    }) => unknown
  ) =>
    selector({
      markRequestProcessed: mockMarkRequestProcessed,
      setPendingRequest: mockSetPendingRequest,
    }),
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: (
    selector: (state: { wallet: { accounts: typeof mockAccounts } }) => unknown
  ) => selector({ wallet: { accounts: mockAccounts } }),
}));
jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    getPrivateKey: (...args: unknown[]) => mockGetPrivateKey(...args),
  },
}));
jest.mock('@/services/wallet/ownKeyCustody', () => ({
  filterOwnKeyAccounts: async (accounts: typeof mockAccounts) => accounts,
}));
jest.mock('@/utils/keyIdentity', () => ({
  keyBelongsToAddress: jest.fn((key: Uint8Array, address: string) =>
    jest.requireActual('@/utils/keyIdentity').keyBelongsToAddress(key, address)
  ),
}));
jest.mock('@/utils/keyregSafety', () => ({ assertSignableKeyreg: jest.fn() }));
jest.mock('@/services/remoteSigner', () => ({
  RemoteSignerService: {
    createSuccessResponse: (id: string, signedTxns: Uint8Array[]) =>
      mockCreateSuccessResponse(id, signedTxns),
    encodePayload: (response: RemoteSignerResponse) => JSON.stringify(response),
  },
}));

const mockGoBack = jest.fn();
const mockMarkRequestProcessed = jest.fn();
const mockSetPendingRequest = jest.fn();
const mockGetPrivateKey = jest.fn();
const mockCreateSuccessResponse = jest.fn(
  (id: string, signedTxns: Uint8Array[]): RemoteSignerResponse => ({
    v: 1,
    t: 'res',
    id,
    ts: 1,
    ok: true,
    sigs: signedTxns.map((bytes, i) => ({
      i,
      b: Buffer.from(bytes).toString('base64'),
    })),
  })
);
const mockAccounts: { id: string; address: string }[] = [];
const mockRouteParams: { request: RemoteSignerRequest; pin: string } = {
  request: {
    v: 1,
    t: 'req',
    id: 'cover-signing-request',
    ts: 1,
    net: 'voi-testnet',
    gh: Buffer.from(new Uint8Array(32)).toString('base64'),
    txns: [],
  },
  pin: '123456',
};
let signingAccount: algosdk.Account;

beforeEach(() => {
  resetCoverForTests();
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  signingAccount = algosdk.generateAccount();
  const address = signingAccount.addr.toString();
  mockAccounts.splice(0, mockAccounts.length, { id: 'signer', address });
  mockRouteParams.request.txns = [0, 1].map((i) => ({
    i,
    s: address,
    b: Buffer.from(
      algosdk.encodeUnsignedTransaction(
        algosdk.makePaymentTxnWithSuggestedParamsFromObject({
          sender: address,
          receiver: address,
          amount: i + 1,
          suggestedParams: {
            firstValid: 1,
            lastValid: 100,
            fee: 1000,
            minFee: 1000,
            flatFee: true,
            genesisHash: new Uint8Array(32),
          },
        })
      )
    ).toString('base64'),
  }));
  // The screen wipes each returned key, so each read needs a fresh copy.
  mockGetPrivateKey.mockImplementation(async () => signingAccount.sk.slice());
});

afterEach(() => {
  signingAccount.sk.fill(0);
  resetCoverForTests();
  jest.restoreAllMocks();
});

async function expectSigningError(view: Awaited<ReturnType<typeof render>>) {
  expect(await view.findByText('Signing failed')).toBeTruthy();
  expect(view.getByText('Signing Failed')).toBeTruthy();
  expect(view.queryByText('Transaction Signed')).toBeNull();
  expect(view.queryByTestId('response-qr')).toBeNull();
  expect(mockCreateSuccessResponse).not.toHaveBeenCalled();
  expect(mockMarkRequestProcessed).not.toHaveBeenCalled();
  expect(mockSetPendingRequest).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('Try Again'));
  expect(mockGoBack).toHaveBeenCalledTimes(1);
}

it('DEFECT cover before mount blocks every key read and offers Retry', async () => {
  await act(async () => setCovered(true));
  const view = await render(<SignatureDisplayScreen />);
  await expectSigningError(view);
  expect(mockGetPrivateKey).not.toHaveBeenCalled();
});

it('DEFECT cover between transactions blocks the second key read and offers Retry', async () => {
  mockGetPrivateKey.mockImplementationOnce(async () => {
    setCovered(true);
    return signingAccount.sk.slice();
  });
  const view = await render(<SignatureDisplayScreen />);
  await expectSigningError(view);
  expect(mockGetPrivateKey).toHaveBeenCalledTimes(1);
  expect(mockGetPrivateKey).toHaveBeenCalledWith('signer', mockRouteParams.pin);
});

it('REGRESSION uncovered twin signs both transactions with the route PIN and displays the response', async () => {
  const view = await render(<SignatureDisplayScreen />);
  expect(await view.findByText('Transaction Signed')).toBeTruthy();
  expect(view.getByText('Scan Response')).toBeTruthy();
  expect(view.queryByText('Signing Failed')).toBeNull();
  expect(mockGetPrivateKey).toHaveBeenCalledTimes(2);
  for (let call = 1; call <= 2; call++) {
    expect(mockGetPrivateKey).toHaveBeenNthCalledWith(
      call,
      'signer',
      mockRouteParams.pin
    );
  }
  expect(mockCreateSuccessResponse).toHaveBeenCalledTimes(1);
  const [requestId, signedTxns] = mockCreateSuccessResponse.mock.calls[0];
  expect(requestId).toBe(mockRouteParams.request.id);
  expect(signedTxns).toHaveLength(2);
  signedTxns.forEach((bytes, i) => {
    const signed = algosdk.decodeSignedTransaction(bytes);
    expect(signed.sig).toHaveLength(64);
    expect(algosdk.encodeUnsignedTransaction(signed.txn)).toEqual(
      Buffer.from(mockRouteParams.request.txns[i].b, 'base64')
    );
  });
  expect(mockMarkRequestProcessed).toHaveBeenCalledTimes(1);
  expect(mockMarkRequestProcessed).toHaveBeenCalledWith(requestId);
  expect(mockSetPendingRequest).toHaveBeenCalledWith(null);
  expect(view.getByTestId('response-qr').props.children).toBe(
    JSON.stringify(mockCreateSuccessResponse.mock.results[0].value)
  );
  expect(view.getByText('Done')).toBeTruthy();
});
