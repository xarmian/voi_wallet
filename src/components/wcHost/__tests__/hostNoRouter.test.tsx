jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
import React from 'react';
import { Alert, AppState } from 'react-native';
import { render, waitFor, fireEvent, act } from '@testing-library/react-native';
import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import { makeAccount } from '@/__tests__/fixtures/algorand';
import { NetworkId } from '@/types/network';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';

const VOI = NetworkId.VOI_MAINNET;

// ---------------------------------------------------------------------------
// Mutable per-test state (all `mock`-prefixed so jest.mock factories may close
// over them; the factories read them lazily at call time).
// ---------------------------------------------------------------------------

let mockLocked = false;
let mockBiometricEnabled = false;
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      isLocked: mockLocked,
      isAuthenticated: !mockLocked,
      biometricEnabled: mockBiometricEnabled,
      hasPin: true,
    },
  }),
}));
jest.mock('@/services/secure/sessionTeardown', () => ({
  clearSessionSecurity: jest.fn(() =>
    require('@/services/secure/SessionKeyVault').SessionKeyVault.clear()
  ),
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getCredentialSource: jest.fn(async () => 'pin'),
    verifyPin: jest.fn(async () => true),
    hasPin: jest.fn(async () => true),
    getBiometricSecret: jest.fn(),
    isBiometricEnabled: jest.fn(async () => false),
    clearPrivateKeyCache: jest.fn(),
  },
}));

let mockAccounts: {
  id: string;
  address: string;
  type: string;
  label: string;
}[];
const mockGetCachedAssetParams = jest.fn();
const mockGetAssetInfo = jest.fn();
const mockResolveSigningRoute = jest.fn();
/** Registry callbacks by id (TASK-257: onDismiss on unmount). */

// `@/utils/bigint` re-exports through `@/utils/formatting`, which pulls in the
// zustand wallet store (and therefore AsyncStorage). Only the locale lookup is
// involved, so a minimal store stub keeps this a pure display test.
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(),
  AuthenticationType: { FACIAL_RECOGNITION: 2 },
}));

jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: undefined }) },
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId: string) => ({
      getCachedAssetParams: (assetId: number) =>
        mockGetCachedAssetParams(networkId, assetId),
      getAssetInfo: (assetId: number) => mockGetAssetInfo(networkId, assetId),
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: async () => mockAccounts,
  },
}));

const mockPreventCapture = jest.fn();
const mockEnableAppSwitcherProtection = jest.fn(
  async (_intensity?: number) => {}
);
jest.mock('expo-screen-capture', () => ({
  usePreventScreenCapture: (key?: string) => mockPreventCapture(key),
  enableAppSwitcherProtectionAsync: (intensity?: number) =>
    mockEnableAppSwitcherProtection(intensity),
  disableAppSwitcherProtectionAsync: async () => {},
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getSigningInfo: jest.fn(async () => ({ signingAddress: 'ADDR' })),
    getLedgerSigningInfo: jest.fn(async () => null),
    resolveSigningRoute: (address: string, networkId?: string) =>
      mockResolveSigningRoute(address, networkId),
  },
}));

const mockAuthController = {
  getState: () => ({
    state: 'authenticating',
    isRemoteSignerFlow: true,
    remoteSignerStatus: 'waiting_signature',
  }),
  subscribe: () => () => {},
  cleanup: jest.fn(),
  cancel: jest.fn(),
  clearUserCancellation: jest.fn(),
  hasEnteredSigner: jest.fn(() => false),
  resetAfterDismiss: jest.fn(),
  wasUserCancelled: false,
};
jest.mock('@/services/auth/transactionAuthController', () => ({
  useTransactionAuthController: () => mockAuthController,
}));
jest.mock('@/services/walletconnect', () => ({
  ...jest.requireActual('@/services/walletconnect/config'),
  WalletConnectService: { getInstance: () => ({}) },
}));
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: { getInstance: () => ({}) },
}));
jest.mock('@/services/remoteSigner', () => ({ RemoteSignerService: {} }));
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: () =>
    require('react').createElement(
      require('react-native').Text,
      { testID: 'host-camera' },
      'fixture camera'
    ),
}));
jest.mock('@/services/remoteSigner/animatedQR', () => ({
  AnimatedQRService: { createDecoder: jest.fn(() => ({})) },
}));
jest.mock('@/components/remoteSigner', () => ({
  AnimatedQRScanner: jest.requireActual(
    '@/components/remoteSigner/AnimatedQRScanner'
  ).AnimatedQRScanner,
  AnimatedQRCode: () => null,
}));
jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => ({}),
  useThemeColors: () => ({}),
}));

jest.mock('@/contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  initialWindowMetrics: null,
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }), {
  virtual: true,
});

import { RequestCoordinator } from '@/services/walletconnect/requestCoordinator';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { HandledStore } from '@/services/walletconnect/handledStore';
import { getHeadSession } from '../headSession';
import WalletConnectHost from '../WalletConnectHost';
import { AnimatedQRService } from '@/services/remoteSigner/animatedQR';
import { reviewGrant } from '@/services/auth/reviewGrant';
import * as callbackRegistry from '@/services/navigation/callbackRegistry';
import { registerNavigationCallbacks } from '@/services/navigation/callbackRegistry';
import { AppLockSignal } from '@/services/secure/appLockState';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import AsyncStorage from '@react-native-async-storage/async-storage';
const owner = makeAccount('host-request-details').addr;
const account = {
  id: 'host-owner',
  address: owner,
  label: 'PRIVATE_ACCOUNT',
  type: 'standard',
};
const ref = {
  version: 2 as const,
  kind: 'request' as const,
  topic: 'fixture-topic',
  id: 1,
};
let queue: RequestQueue;
let coordinator: RequestCoordinator;
let session: ReturnType<typeof getHeadSession>;
let appState: typeof AppState.currentState;
let callbackId: string;
beforeEach(async () => {
  mockLocked = false;
  reviewGrant.revoke(false);
  AppLockSignal.setUnlocked(true);
  SessionKeyVault.set('fixture', 'pin');
  jest.spyOn(reviewGrant, 'leave');
  appState = AppState.currentState;
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(() => ({ remove: jest.fn() }));
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockAuthController.hasEnteredSigner.mockReturnValue(false);
  await AsyncStorage.clear();
  coordinator = new RequestCoordinator({
    store: new HandledStore(),
    transport: {
      rejectRequestV1: async () => {},
      rejectRequestV2: async () => {},
      rejectProposalV1: async () => {},
      rejectProposalV2: async () => {},
    },
  });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  await coordinator.admit(ref);
  queue = new RequestQueue({ coordinator });
  jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
  mockAccounts = [account];
  mockResolveSigningRoute.mockResolvedValue({
    kind: 'software',
    signingAddress: owner,
  });
  mockGetCachedAssetParams.mockResolvedValue(null);
  const config = NETWORK_CONFIGURATIONS[VOI];
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: owner,
    receiver: owner,
    amount: 987654321n,
    assetIndex: 424242n,
    note: Buffer.from('PRIVATE_TRANSACTION_NOTE'),
    suggestedParams: {
      fee: 1000,
      flatFee: true,
      minFee: 1000,
      firstValid: 1,
      lastValid: 1001,
      genesisID: config.genesisId,
      genesisHash: new Uint8Array(Buffer.from(config.genesisHash, 'base64')),
    },
  });
  const transactions = [
    {
      txn: Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString(
        'base64'
      ),
    },
  ];
  queue.push({
    ref,
    payload: { topic: ref.topic, id: ref.id },
    firstSeenMs: Date.now(),
  });
  session = getHeadSession(queue.getSnapshot().head!, { queue, coordinator });
  jest.spyOn(session.controller!, 'start').mockResolvedValue(undefined);
  callbackId = registerNavigationCallbacks({
    onReject: () => session.controller!.reject(),
    onEnd: async (reason) => {
      await coordinator.settle(ref, reason);
    },
  });
  session.presentReview({
    transactions: transactions.map((entry) => entry.txn),
    account: account as never,
    chainId: config.chainId,
    networkId: VOI,
    title: 'fixture request',
    callbackId,
    walletConnect: {
      ref,
      transactions,
      requestKey: 'fixture-key',
      binding: {
        topic: ref.topic,
        chainId: config.chainId,
        networkId: VOI,
        approvedAccounts: [config.chainId + ':' + owner],
      },
      dapp: { name: 'fixture dApp' },
    },
  });
});
afterEach(() => {
  queue.__resetForTests();
  coordinator.__resetForTests();
  reviewGrant.revoke(false);
  SessionKeyVault.clear();
  AppLockSignal.setUnlocked(false);
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: appState,
  });
  jest.restoreAllMocks();
});
const waitDetails = async (view: Awaited<ReturnType<typeof render>>) =>
  waitFor(() =>
    expect(view.getByText('987654321 base units of ASA #424242')).toBeTruthy()
  );
function treeText(view: Awaited<ReturnType<typeof render>>) {
  return JSON.stringify(view.toJSON());
}
it('DEFECT real TransactionReview and scanner mount with no NavigationContainer and real useFocusEffect', async () => {
  const view = await render(<WalletConnectHost />);
  await waitDetails(view);
  const before = jest.mocked(AnimatedQRService.createDecoder).mock.calls.length;
  await fireEvent.press(view.getByText('Sign with PIN'));
  expect(view.getByTestId('host-camera')).toBeTruthy();
  // Scanner mount initializes once, and real useFocusEffect resets once.
  expect(
    jest.mocked(AnimatedQRService.createDecoder).mock.calls.length - before
  ).toBe(2);
});
const lockedDetailCases = (valid: boolean, realLock: boolean) => async () => {
  if (valid) reviewGrant.mintForWaiting(['fixture-key']);
  const view = await render(<WalletConnectHost />);
  await waitDetails(view);
  if (realLock) AppLockSignal.setUnlocked(false);
  mockLocked = true;
  await view.rerender(<WalletConnectHost />);
  expect(reviewGrant.isValid('fixture-key')).toBe(valid && !realLock);
  for (const detail of [
    'PRIVATE_ACCOUNT',
    '987654321',
    '424242',
    'PRIVATE_TRANSACTION_NOTE',
    owner.slice(0, 4) + '...' + owner.slice(-4),
  ])
    expect(treeText(view)).not.toContain(detail);
};
it(
  'DEFECT request real body active lock, no grant, hides every seeded detail in text and labels',
  lockedDetailCases(false, true)
);
it(
  'DEFECT request real lock (AppLockSignal) revokes a valid grant and hides every seeded detail',
  lockedDetailCases(true, true)
);
// RESIDUAL (dev lead to rule): see the proposal twin. A grant that survives the
// lock is not reachable in production under the cover; the tree shows detail.
it.failing(
  'RESIDUAL request body with a grant that survived the lock hides every seeded detail',
  lockedDetailCases(true, false)
);
it('DEFECT request before signer survives active lock/unlock, then real controller reject settles once', async () => {
  const view = await render(<WalletConnectHost />);
  await waitDetails(view);
  const clear = jest.spyOn(callbackRegistry, 'clearNavigationCallbacks');
  const settle = jest.spyOn(coordinator, 'settle');
  const dispose = jest.spyOn(session.controller!, 'dispose');
  const leave = jest.fn();
  session.binding.onLeave(leave);
  mockLocked = true;
  await view.rerender(<WalletConnectHost />);
  mockLocked = false;
  await view.rerender(<WalletConnectHost />);
  expect(settle).not.toHaveBeenCalled();
  expect(reviewGrant.leave).not.toHaveBeenCalled();
  expect(dispose).not.toHaveBeenCalled();
  expect(mockAuthController.cleanup).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(leave).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('Reject'));
  expect(settle).toHaveBeenCalledTimes(1);
  expect(settle).toHaveBeenCalledWith(ref, 'declined');
});
it('DEFECT entered-signer lapse follows the real TransactionReview grant subscription', async () => {
  reviewGrant.mintForWaiting(['fixture-key']);
  const view = await render(<WalletConnectHost />);
  await waitDetails(view);
  await fireEvent.press(view.getByText('Sign'));
  mockAuthController.hasEnteredSigner.mockReturnValue(true);
  const settle = jest.spyOn(coordinator, 'settle');
  await act(async () => {
    mockLocked = true;
    AppLockSignal.setUnlocked(false);
  });
  expect(settle).toHaveBeenCalledWith(ref, 'lapsed');
  expect(queue.getSnapshot().head).toBeNull();
});
