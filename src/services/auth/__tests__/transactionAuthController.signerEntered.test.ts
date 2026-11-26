jest.mock('@/services/messaging/keyDerivation', () => ({
  clearMessagingKeyCache: jest.fn(),
}));

jest.mock('expo-local-authentication', () => ({
  __esModule: true,
  hasHardwareAsync: jest.fn(),
  isEnrolledAsync: jest.fn(),
  authenticateAsync: jest.fn(),
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    hasPin: jest.fn(),
    isBiometricEnabled: jest.fn(),
    verifyPin: jest.fn(),
    getBiometricSecret: jest.fn(),
    clearPrivateKeyCache: jest.fn(),
  },
}));
jest.mock('@/services/secure/biometricUnlock', () => ({
  unlockVaultWithBiometrics: jest.fn(),
}));
jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getPrivateKey: jest.fn(),
    getSigningInfo: jest.fn(),
    getLedgerSigningInfo: jest.fn(),
  },
}));
jest.mock('@/services/transactions/unifiedSigner', () => {
  const signTransaction = jest.fn();
  return {
    signsSequentially: (request: unknown) =>
      jest
        .requireActual('@/services/transactions/unifiedSigner')
        .signsSequentially(request),
    UnifiedTransactionSigner: {
      getInstance: () => ({
        signTransaction,
        planBatch: (request: unknown) =>
          jest
            .requireActual('@/services/transactions/unifiedSigner')
            .UnifiedTransactionSigner.getInstance()
            .planBatch(request),
      }),
    },
  };
});
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: jest.fn(),
    getCurrentWallet: jest.fn(),
  },
}));
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    startDiscovery: jest.fn(),
    stopDiscovery: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    getConnectedDevice: jest.fn(),
    getDevices: jest.fn(),
    connect: jest.fn(),
  },
  LedgerDeviceInfo: class {},
}));
jest.mock('@/services/ledger/algorand', () => ({
  ledgerAlgorandService: { verifyApp: jest.fn() },
  LedgerAlgorandService: { isCurrentlySigningTransaction: jest.fn() },
}));
jest.mock('@/store/walletStore', () => ({ getRekeyStateStrict: jest.fn() }));
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: jest.fn(() => ({
      getCurrentNetworkId: () => 'voi-mainnet',
      getAccountRekeyInfo: jest.fn(async () => ({
        isRekeyed: true,
        authAddress: 'AUTH-X',
      })),
      submitTransaction: jest.fn(async () => ({
        txId: 'tx',
        confirmed: true,
      })),
    })),
  },
}));

jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: {
    getInstance: () => ({
      getApprovedAccountsForChain: () => [],
    }),
  },
}));
jest.mock('@/services/transactions', () => ({
  TransactionService: { buildTransaction: jest.fn() },
}));

import { AppState } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SecureKeyManager } from '@/services/secure/keyManager';
import {
  UnifiedTransactionSigner,
  UnifiedTransactionRequest,
  UnifiedSigningCallbacks,
} from '@/services/transactions/unifiedSigner';
import { MultiAccountWalletService } from '@/services/wallet';
import { ledgerTransportService } from '@/services/ledger/transport';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { reviewGrant, reviewBindingDigest } from '../reviewGrant';
import {
  ReviewEndedError,
  TransactionAuthController,
} from '../transactionAuthController';

const signer = UnifiedTransactionSigner.getInstance()
  .signTransaction as jest.Mock;
const key = 'review-fixture';
const request = (reviewGrantKey?: string): UnifiedTransactionRequest => ({
  type: 'batch_transaction',
  account: {
    address: 'ADDR',
    type: AccountType.STANDARD,
  } as UnifiedTransactionRequest['account'],
  networkId: NetworkId.VOI_MAINNET,
  reviewGrantKey,
  walletConnectParams: {
    transactions: [{ txn: 'AA==' }],
    reviewedSigners: ['ADDR'],
    sessionBinding: null,
  },
});
const digest = (req: UnifiedTransactionRequest) =>
  reviewBindingDigest({
    networkId: req.networkId!,
    txnBytesBase64: req.walletConnectParams!.transactions.map((txn) => txn.txn),
    signerAddresses: req.walletConnectParams!.reviewedSigners,
  });
const bind = (req: UnifiedTransactionRequest) => {
  SessionKeyVault.set('fixture', 'pin');
  AppLockSignal.setUnlocked(true);
  reviewGrant.mintForWaiting([key]);
  expect(reviewGrant.bind(key, digest(req))).toBe(true);
};
// Match the neighbouring tests' private-entry-point cast for defensive guards.
type SigningInternals = {
  startSigning(pin?: string): Promise<void>;
  reviewSigningStarted: boolean;
};
const internals = (controller: TransactionAuthController) =>
  controller as unknown as SigningInternals;

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() });
  (AccountSecureStorage.hasPin as jest.Mock).mockResolvedValue(true);
  (AccountSecureStorage.isBiometricEnabled as jest.Mock).mockResolvedValue(
    false
  );
  (AccountSecureStorage.verifyPin as jest.Mock).mockResolvedValue(true);
  (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(true);
  (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(true);
  (SecureKeyManager.getSigningInfo as jest.Mock).mockResolvedValue({
    signingAddress: 'ADDR',
    canSign: true,
  });
  (SecureKeyManager.getLedgerSigningInfo as jest.Mock).mockResolvedValue(null);
  (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
    { address: 'ADDR', type: AccountType.STANDARD },
  ]);
  (ledgerTransportService.getDevices as jest.Mock).mockReturnValue([]);
  signer
    .mockReset()
    .mockImplementation(
      async (
        _req: UnifiedTransactionRequest,
        callbacks: UnifiedSigningCallbacks
      ) => {
        callbacks.onComplete?.({
          success: true,
          signedTransactions: ['signature'],
        });
      }
    );
});
afterEach(() => {
  reviewGrant.revoke();
  SessionKeyVault.clear();
  AppLockSignal.setUnlocked(false);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('REGRESSION hasEnteredSigner is false while authenticating before signer entry', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  expect(controller.getState().state).toBe('authenticating');
  expect(controller.hasEnteredSigner()).toBe(false);
  expect(signer).not.toHaveBeenCalled();
});

it('REGRESSION hasEnteredSigner is true once the review signer runs after pauseIdle', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  const pauseIdle = jest.spyOn(reviewGrant, 'pauseIdle');
  signer.mockImplementationOnce(
    async (
      _req: UnifiedTransactionRequest,
      callbacks: UnifiedSigningCallbacks
    ) => {
      expect(pauseIdle).toHaveBeenCalledTimes(1);
      expect(pauseIdle.mock.results[0].value).toBe(true);
      expect(controller.hasEnteredSigner()).toBe(true);
      callbacks.onComplete?.({ success: true });
    }
  );
  await controller.initializeSigningFlow(req);
  expect(await controller.authenticateWithReviewGrant(key)).toBe(true);
  expect(signer).toHaveBeenCalledTimes(1);
  expect(controller.hasEnteredSigner()).toBe(true);
});

it('DEFECT hasEnteredSigner survives settlement when signing failure publishes error', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  const failure = new Error('signing failed');
  const published = jest.fn();
  controller.subscribe((state) => {
    if (state.state === 'error') {
      published({
        error: state.error,
        signingStarted: internals(controller).reviewSigningStarted,
        enteredSigner: controller.hasEnteredSigner(),
      });
    }
  });
  signer.mockImplementationOnce(
    async (
      _req: UnifiedTransactionRequest,
      callbacks: UnifiedSigningCallbacks
    ) => {
      callbacks.onError?.(failure);
      callbacks.onComplete?.({ success: false, error: failure });
    }
  );
  await controller.initializeSigningFlow(req);
  await controller.authenticateWithReviewGrant(key);
  expect(signer).toHaveBeenCalledTimes(1);
  expect(published).toHaveBeenCalledWith({
    error: failure,
    signingStarted: false,
    enteredSigner: true,
  });
  expect(internals(controller).reviewSigningStarted).toBe(false);
  expect(controller.hasEnteredSigner()).toBe(true);
});

it('DEFECT hasEnteredSigner survives cancel then resetAfterDismiss', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  await controller.authenticateWithReviewGrant(key);
  expect(signer).toHaveBeenCalledTimes(1);
  controller.cancel();
  expect(internals(controller).reviewSigningStarted).toBe(false);
  expect(controller.hasEnteredSigner()).toBe(true);
  controller.resetAfterDismiss();
  expect(controller.getState().state).toBe('idle');
  expect(internals(controller).reviewSigningStarted).toBe(false);
  expect(controller.hasEnteredSigner()).toBe(true);
});

it('REGRESSION the next initializeSigningFlow resets hasEnteredSigner', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  await controller.authenticateWithReviewGrant(key);
  expect(controller.hasEnteredSigner()).toBe(true);
  // Reuse the controller without dismissal, so initialization owns the reset.
  await controller.initializeSigningFlow(request());
  expect(controller.getState().state).toBe('authenticating');
  expect(controller.hasEnteredSigner()).toBe(false);
});

it('DEFECT a signer run without a review grant sets hasEnteredSigner (the screen reads it only for WalletConnect)', async () => {
  const controller = new TransactionAuthController();
  signer.mockImplementationOnce(
    async (
      _req: UnifiedTransactionRequest,
      callbacks: UnifiedSigningCallbacks
    ) => {
      expect(controller.hasEnteredSigner()).toBe(true);
      callbacks.onComplete?.({ success: true });
    }
  );
  await controller.initializeSigningFlow(request());
  expect(controller.hasEnteredSigner()).toBe(false);
  expect(await controller.authenticateWithPin('123456')).toBe(true);
  expect(signer).toHaveBeenCalledTimes(1);
  expect(controller.hasEnteredSigner()).toBe(true);
});

function expectApprovalEnded(controller: TransactionAuthController) {
  const error = controller.getState().error;
  expect(controller.getState().state).toBe('error');
  expect(error).toBeInstanceOf(ReviewEndedError);
  expect((error as ReviewEndedError).title).toBe('Approval ended');
  expect(error?.message).toBe('Unlock to review this request again.');
  expect(controller.hasEnteredSigner()).toBe(false);
  expect(signer).not.toHaveBeenCalled();
}

it.each(['missing digest', 'consumed grant'] as const)(
  'REGRESSION authenticateWithReviewGrant reports Approval ended for %s',
  async (failure) => {
    const req = request(key);
    bind(req);
    if (failure === 'missing digest') req.networkId = undefined;
    else expect(reviewGrant.consume(key, digest(req))).toBe(true);
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow(req);
    expect(await controller.authenticateWithReviewGrant(key)).toBe(false);
    expectApprovalEnded(controller);
  }
);

it('REGRESSION startSigning reports Approval ended for an unconsumed capability', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  await internals(controller).startSigning();
  expectApprovalEnded(controller);
});

it('REGRESSION pauseIdle failure before signer entry reports Approval ended', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  const pauseIdle = jest.spyOn(reviewGrant, 'pauseIdle');
  // Lose the real capability after consumption, before pauseIdle at the
  // signer boundary. The state listener models navigation away at that point.
  const unsubscribe = controller.subscribe((state) => {
    if (state.state === 'signing') reviewGrant.leave(key);
  });
  await controller.authenticateWithReviewGrant(key);
  unsubscribe();
  expect(pauseIdle).toHaveBeenCalledTimes(1);
  expect(pauseIdle.mock.results[0].value).toBe(false);
  expectApprovalEnded(controller);
});
