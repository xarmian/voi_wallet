import React from 'react';
import { Alert, AppState, type AppStateStatus } from 'react-native';
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
const mockBiometricEnabled = false;
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
let mockRoutes: Record<string, unknown>;
const mockGetCachedAssetParams = jest.fn();
const mockGetAssetInfo = jest.fn();
const mockResolveSigningRoute = jest.fn();
/** Registry callbacks by id (TASK-257: onDismiss on unmount). */
let mockRegistry: Record<
  string,
  { onDismiss?: () => void; onReject?: () => Promise<void> }
> = {};

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
  getRekeyStateStrict: jest.fn(async () => ({ authAddress: null })),
}));

jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: (networkId: string) => ({
      getCachedAssetParams: (assetId: number) =>
        mockGetCachedAssetParams(networkId, assetId),
      getAssetInfo: (assetId: number) => mockGetAssetInfo(networkId, assetId),
      submitTransaction: (...args: unknown[]) => mockSubmit(...args),
    }),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: async () => mockAccounts,
    getCurrentWallet: jest.fn(),
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
    getSigningInfo: jest.fn(async (address: string) => ({
      signingAddress: address,
      canSign: true,
    })),
    getLedgerSigningInfo: jest.fn(async () =>
      mockLedger ? { deviceId: 'device', derivationIndex: 0 } : null
    ),
    resolveSigningRoute: (address: string, networkId?: string) =>
      mockResolveSigningRoute(address, networkId),
  },
}));

jest.mock('@/services/navigation/callbackRegistry', () => ({
  getNavigationCallbacks: (id?: string) => (id ? mockRegistry[id] : undefined),
  clearNavigationCallbacks: jest.fn(),
}));

jest.mock('@/components/common/UniversalHeader', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/hooks/useThemedStyles', () => ({
  useThemedStyles: () => new Proxy({}, { get: () => ({}) }),
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

let mockController: TransactionAuthController;
let mockObservedModalProps: any;
let mockModalMounted = false;
jest.mock('@/services/auth/transactionAuthController', () => {
  const actual = jest.requireActual(
    '@/services/auth/transactionAuthController'
  );
  return {
    ...actual,
    useTransactionAuthController: () => {
      mockController = actual.useTransactionAuthController();
      return mockController;
    },
  };
});
jest.mock('@/components/UnifiedTransactionAuthModal', () => {
  const Actual = jest.requireActual(
    '@/components/UnifiedTransactionAuthModal'
  ).default;
  return {
    __esModule: true,
    default: (props: any) => {
      mockObservedModalProps = props;
      require('react').useEffect(() => {
        mockModalMounted = true;
        return () => {
          mockModalMounted = false;
        };
      }, []);
      return Actual(props);
    },
  };
});
let mockLedger = false;
const mockSign = jest.fn();
const mockSubmit = jest.fn();
const mockDeviceListeners = new Map<string, Set<(...args: any[]) => void>>();
jest.mock('@/services/transactions/unifiedSigner', () => ({
  UnifiedTransactionSigner: {
    getInstance: () => ({
      signTransaction: mockSign,
      planBatch: async (request: UnifiedTransactionRequest) =>
        request.walletConnectParams!.transactions.map((entry) => ({
          action: 'sign',
          txn: require('algosdk').decodeUnsignedTransaction(
            require('buffer').Buffer.from(entry.txn, 'base64')
          ),
        })),
    }),
  },
}));
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    startDiscovery: jest.fn(),
    stopDiscovery: jest.fn(),
    cancelConnect: jest.fn(),
    getConnectedDevice: () => null,
    getDevices: () => [],
    on: (event: string, cb: (...args: any[]) => void) => {
      if (!mockDeviceListeners.has(event))
        mockDeviceListeners.set(event, new Set());
      mockDeviceListeners.get(event)!.add(cb);
    },
    off: (event: string, cb: (...args: any[]) => void) =>
      mockDeviceListeners.get(event)?.delete(cb),
  },
}));
jest.mock('@/services/ledger/algorand', () => ({
  ledgerAlgorandService: { verifyApp: jest.fn(async () => true) },
  LedgerAlgorandService: { isCurrentlySigningTransaction: () => false },
}));
jest.mock('@/services/messaging/keyDerivation', () => ({
  clearMessagingKeyCache: jest.fn(),
}));
jest.mock('@/services/remoteSigner', () => ({
  RemoteSignerService: {
    createSigningRequest: jest.fn(async () => ({ id: 'request' })),
    encodePayload: jest.fn(() => ''),
  },
}));
jest.mock('@/services/transactions', () => ({ TransactionService: {} }));
jest.mock('@/components/remoteSigner', () => ({
  AnimatedQRCode: () => null,
  AnimatedQRScanner: () => null,
}));
jest.mock('@/utils/haptics', () => ({ hapticNotify: jest.fn() }));
import UniversalTransactionSigningScreen from '../../UniversalTransactionSigningScreen';
import { TransactionAuthController } from '@/services/auth/transactionAuthController';
import { reviewGrant } from '@/services/auth/reviewGrant';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import {
  UnifiedSigningCallbacks,
  UnifiedTransactionRequest,
} from '@/services/transactions/unifiedSigner';
import { AccountType } from '@/types/wallet';

export const key = 'outcome-request';
export const result = { success: true, signedTransactions: ['signed fixture'] };
export const texts = {
  idle: 'Your approval timed out before signing finished. Start the request again.',
  lock: 'Your approval ended before signing finished. Start the request again.',
  batch:
    'Your approval ended after signing finished, so the signed result was not returned to the dApp. This wallet did not send anything. Check the dApp, then start the request again if you still need it.',
  other:
    "Your approval ended after signing finished, and this wallet can't tell whether the transaction was sent. Check your account or the dApp before you try again.",
  remote:
    'This account signs on another device, so your wallet needs to be fully unlocked. Unlock your wallet, then start the request again.',
  unlock: 'Unlock to review this request again.',
  noPin:
    'Wallet setup is not finished. Finish setup, then try the request again.',
  unreadable: "Couldn't read your wallet security settings. Try again.",
};
export type Internals = {
  currentRequest: UnifiedTransactionRequest | null;
  updateState(state: Record<string, unknown>): void;
  maybeStartSigningIfReady(): Promise<void>;
  startSigning(): Promise<void>;
  getReviewDigest(): string | null;
  initializeRemoteSignerFlow(): Promise<void>;
  isSigningInProgress: boolean;
  hasStartedSigning: boolean;
  reviewAuthorized: boolean;
  reviewSigningStarted: boolean;
};
export const currentController = () => mockController;
export const inside = (c: TransactionAuthController) =>
  c as unknown as Internals;
let appListeners: Set<(s: AppStateStatus) => void>;
export function setupOutcomeHarness() {
  beforeEach(() => {
    jest.useFakeTimers();
    mockLocked = true;
    mockLedger = false;
    mockRegistry = {};
    mockAccounts = [];
    mockRoutes = {};
    mockDeviceListeners.clear();
    mockResolveSigningRoute.mockImplementation(
      async (address: string) => mockRoutes[address]
    );
    mockGetCachedAssetParams.mockResolvedValue(null);
    mockGetAssetInfo.mockResolvedValue(null);
    mockSign.mockReset();
    mockSubmit.mockReset();
    (AccountSecureStorage.hasPin as jest.Mock).mockResolvedValue(true);
    Object.defineProperty(AppState, 'currentState', {
      value: 'active',
      writable: true,
      configurable: true,
    });
    appListeners = new Set();
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, cb) => {
        appListeners.add(cb);
        return { remove: () => appListeners.delete(cb) };
      });
    AppLockSignal.setUnlocked(false);
    reviewGrant.revoke();
    SessionKeyVault.clear();
  });
  afterEach(() => {
    reviewGrant.revoke();
    SessionKeyVault.clear();
    AppLockSignal.setUnlocked(false);
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
export async function lapse(
  reason: 'lock' | 'background' | 'rotation' | 'idle'
) {
  await act(async () => {
    if (reason === 'lock') AppLockSignal.setUnlocked(false);
    if (reason === 'background') {
      AppState.currentState = 'background';
      [...appListeners].forEach((cb) => cb('background'));
    }
    if (reason === 'rotation') SessionKeyVault.set('rotated fixture', 'pin');
    if (reason === 'idle') {
      // Completion can be delayed after the signer's pause has resumed.
      reviewGrant.resumeIdle(key);
      jest.advanceTimersByTime(61_000);
    }
  });
}
export async function openOutcome(
  options: {
    locked?: boolean;
    ledger?: boolean;
    remote?: boolean;
    sign?: boolean;
    signerThrows?: boolean;
  } = {}
) {
  const {
    locked = true,
    ledger = false,
    remote = false,
    sign = true,
  } = options;
  mockLocked = locked;
  mockLedger = ledger;
  AppLockSignal.setUnlocked(!locked);
  if (locked) await reviewGrant.unlock(key, { pin: '123456' });
  else {
    SessionKeyVault.set('fixture', 'pin');
    reviewGrant.mintForWaiting([key]);
  }
  const address = makeAccount('review-outcome').addr;
  const account = {
    id: 'account',
    address,
    label: 'Alpha',
    type: remote
      ? AccountType.REMOTE_SIGNER
      : ledger
        ? AccountType.LEDGER
        : AccountType.STANDARD,
  };
  mockAccounts = [account];
  mockRoutes[address] = ledger
    ? { kind: 'ledger', signingAddress: address }
    : { kind: 'software', signingAddress: address };
  const config = NETWORK_CONFIGURATIONS[VOI];
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 1,
    suggestedParams: {
      fee: 1000,
      firstValid: 1,
      lastValid: 1001,
      genesisID: config.genesisId,
      genesisHash: new Uint8Array(Buffer.from(config.genesisHash, 'base64')),
      flatFee: true,
      minFee: 1000,
    },
  });
  const bytes = Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString(
    'base64'
  );
  let callbacks!: UnifiedSigningCallbacks;
  let finish!: () => void;
  let rejectSigner!: (error: Error) => void;
  mockSign.mockImplementation((_request, cb) => {
    callbacks = cb;
    return new Promise<void>((resolve, reject) => {
      finish = resolve;
      rejectSigner = reject;
    });
  });
  if (options.signerThrows)
    mockSign.mockRejectedValueOnce(new Error('signing failed'));
  const onSuccess = jest.fn(async () => {
    expect(SessionKeyVault.isUnlocked()).toBe(true);
  });
  const onReject = jest.fn(async () => {});
  const shownWithVault: boolean[] = [];
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {
    shownWithVault.push(SessionKeyVault.isUnlocked());
  });
  const navigation = {
    canGoBack: () => false,
    navigate: jest.fn(),
    addListener: () => () => {},
  };
  const view = await render(
    <UniversalTransactionSigningScreen
      navigation={navigation as never}
      route={
        {
          params: {
            transactions: [bytes],
            account,
            networkId: VOI,
            chainId: config.chainId,
            onSuccess,
            onReject,
            walletConnect: {
              requestKey: key,
              transactions: [{ txn: bytes }],
              binding: {
                topic: 'topic',
                chainId: config.chainId,
                networkId: VOI,
                approvedAccounts: [config.chainId + ':' + address],
              },
            },
          },
        } as never
      }
    />
  );
  await waitFor(() => expect(view.getByText('Sign')).toBeEnabled());
  if (sign) await fireEvent.press(view.getByText('Sign'));
  const modal = () => {
    expect(mockModalMounted).toBe(true);
    return { props: mockObservedModalProps };
  };
  const controller = mockController;
  await act(async () => {});
  return {
    view,
    controller,
    modal,
    onSuccess,
    onReject,
    alert,
    shownWithVault,
    signer: mockSign,
    submit: mockSubmit,
    callbacks: () => callbacks,
    rejectSigner: async () => {
      await act(async () => {
        rejectSigner(new Error('transport failed'));
      });
    },
    complete: async (value = result) => {
      await act(async () => {
        callbacks.onComplete!(value);
        finish();
      });
    },
    ready: async () => {
      await act(async () => {
        inside(controller).updateState({ ledgerStatus: 'ready' });
        void inside(controller).maybeStartSigningIfReady();
      });
    },
  };
}
export {
  reviewGrant,
  SessionKeyVault,
  AppLockSignal,
  AccountSecureStorage,
  TransactionAuthController,
  act,
  fireEvent,
  render,
  waitFor,
};
