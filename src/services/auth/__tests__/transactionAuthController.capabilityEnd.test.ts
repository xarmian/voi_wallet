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

import { AppState, type AppStateStatus } from 'react-native';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';
import { ledgerTransportService } from '@/services/ledger/transport';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SecureKeyManager } from '@/services/secure/keyManager';
import {
  UnifiedTransactionSigner,
  UnifiedTransactionRequest,
  UnifiedSigningCallbacks,
} from '@/services/transactions/unifiedSigner';
import { MultiAccountWalletService } from '@/services/wallet';
import * as LocalAuthentication from 'expo-local-authentication';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import {
  reviewGrant,
  reviewBindingDigest,
  walletConnectReviewDigest,
} from '../reviewGrant';
import { TransactionAuthController } from '../transactionAuthController';

const signer = UnifiedTransactionSigner.getInstance()
  .signTransaction as jest.Mock;
const pinPresence = AccountSecureStorage.hasPin as jest.Mock;
const keyRead = SecureKeyManager.getPrivateKey as jest.Mock;
const setupMessage =
  'Wallet setup is not finished. Finish setup, then try the request again.';
const readMessage = "Couldn't read your wallet security settings. Try again.";
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
const bind = (req: UnifiedTransactionRequest) => {
  SessionKeyVault.set('fixture', 'pin');
  AppLockSignal.setUnlocked(true);
  reviewGrant.mintForWaiting([req.reviewGrantKey!]);
  reviewGrant.bind(
    req.reviewGrantKey!,
    reviewBindingDigest({
      networkId: req.networkId!,
      txnBytesBase64: req.walletConnectParams!.transactions.map((t) => t.txn),
      signerAddresses: req.walletConnectParams!.reviewedSigners,
    })
  );
};
// Private entry points exercise callers that bypass preflight and changes between
// authentication and key access, without stubbing the guards under test.
type SigningInternals = {
  startSigning(pin?: string): Promise<void>;
  currentRequest: UnifiedTransactionRequest;
  signingAbortController: AbortController | null;
  isSigningInProgress: boolean;
  reviewAuthorized: boolean;
  reviewSigningStarted: boolean;
  hasSubmittedToNetwork: boolean;
  getReviewDigest(): string | null;
  maybeStartSigningIfReady(): Promise<void>;
  updateState(state: Record<string, unknown>): void;
  initializeRemoteSignerFlow(): Promise<void>;
};
const internals = (controller: TransactionAuthController) =>
  controller as unknown as SigningInternals;
let appListeners: Set<(state: AppStateStatus) => void>;
beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  appListeners = new Set();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      appListeners.add(listener);
      return { remove: () => appListeners.delete(listener) };
    });
  pinPresence.mockReset().mockResolvedValue(true);
  (AccountSecureStorage.isBiometricEnabled as jest.Mock).mockResolvedValue(
    true
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
  signer.mockReset().mockImplementation(async (_req, callbacks) => {
    await keyRead();
    callbacks.onComplete({ success: true, signedTransactions: ['signature'] });
  });
  (unlockVaultWithBiometrics as jest.Mock).mockResolvedValue({
    status: 'unlocked',
  });
  (ledgerTransportService.getDevices as jest.Mock).mockReturnValue([]);
});
afterEach(() => {
  reviewGrant.revoke();
  SessionKeyVault.clear();
  AppLockSignal.setUnlocked(false);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const key = 'A';
const completeResult = { success: true, signedTransactions: ['signature'] };
const pendingSigner = () => {
  let callbacks!: UnifiedSigningCallbacks;
  signer.mockImplementationOnce((_req, cb) => {
    return new Promise<void>((resolve) => {
      callbacks = {
        ...cb,
        onComplete: (result) => {
          cb.onComplete(result);
          resolve();
        },
      };
    });
  });
  return () => callbacks;
};
async function beginReviewSigning(controller: TransactionAuthController) {
  // Keep the signer pending while authentication crosses its asynchronous PIN checks.
  void controller.authenticateWithReviewGrant(key);
  for (let i = 0; i < 4; i++) await Promise.resolve();
}
async function assertEnded(
  controller: TransactionAuthController,
  state: string
) {
  await Promise.resolve();
  expect(internals(controller).isSigningInProgress).toBe(false);
  expect(controller.getState().state).toBe(state);
  expect(internals(controller).currentRequest.reviewGrantKey).toBeUndefined();
  expect(internals(controller).reviewAuthorized).toBe(false);
  expect(internals(controller).reviewSigningStarted).toBe(false);
  expect(reviewGrant.isValid(key)).toBe(false);
  expect(reviewGrant.isUnspent(key)).toBe(false);
  const calls = signer.mock.calls.length;
  const before = controller.getState();
  expect(await controller.authenticateWithReviewGrant(key)).toBe(false);
  expect(controller.getState()).toEqual(before);
  expect(signer).toHaveBeenCalledTimes(calls);
}
async function cancelThenFreshPinSigns(
  controller: TransactionAuthController,
  req: UnifiedTransactionRequest
) {
  controller.cancel();
  expect(controller.getState().state).toBe('idle');
  expect(internals(controller).isSigningInProgress).toBe(false);
  await controller.initializeSigningFlow(req);
  expect(controller.getState().state).toBe('authenticating');
  const calls = signer.mock.calls.length;
  expect(await controller.authenticateWithPin('123456')).toBe(true);
  expect(signer).toHaveBeenCalledTimes(calls + 1);
  expect(controller.getState().state).toBe('completed');
}
// REGRESSION E1
it('signatureProducedAndDelivered', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  expect(await controller.authenticateWithReviewGrant(key)).toBe(true);
  expect(controller.getState()).toMatchObject({
    state: 'completed',
    result: completeResult,
  });
  expect(internals(controller).isSigningInProgress).toBe(false);
});
// DEFECT E2: both fresh authentication paths work on the same flow.
it.each(['PIN', 'biometric'])(
  'signerFailureEndsCapabilityAndFresh%sSigns',
  async (method) => {
    const req = request(key);
    bind(req);
    const controller = new TransactionAuthController();
    const callbacks = pendingSigner();
    await controller.initializeSigningFlow(req);
    await beginReviewSigning(controller);
    callbacks().onComplete!({
      success: false,
      error: new Error('signing failed'),
    });
    await assertEnded(controller, 'authenticating');
    expect(controller.getState()).toMatchObject({
      requiresPin: true,
      ledgerError: null,
    });
    const calls = signer.mock.calls.length;
    if (method === 'PIN') await controller.authenticateWithPin('123456');
    else await controller.authenticateWithBiometrics();
    expect(signer).toHaveBeenCalledTimes(calls + 1);
    expect(controller.getState().state).toBe('completed');
    await cancelThenFreshPinSigns(controller, req);
  }
);
const lapseMessage =
  'Your approval ended before signing finished. Start the request again.';
const signedThenLapsedBatchMessage =
  'Your approval ended after signing finished, so the signed result was not returned to the dApp. This wallet did not send anything. Check the dApp, then start the request again if you still need it.';
const signedThenLapsedNonBatchMessage =
  "Your approval ended after signing finished, and this wallet can't tell whether the transaction was sent. Check your account or the dApp before you try again.";
// idle after signer entry: not applicable, the pause removes it; idle before signer entry: ledgerIdleBeforeSignerShowsTimedOutText
const lapseReasons = ['lock', 'background', 'rotation'] as const;
function lapse(reason: (typeof lapseReasons)[number]) {
  if (reason === 'lock') AppLockSignal.setUnlocked(false);
  if (reason === 'background')
    [...appListeners].forEach((listener) => listener('background'));
  if (reason === 'rotation') SessionKeyVault.set('rotated fixture', 'pin');
}
function keyregRequest(): UnifiedTransactionRequest {
  // Directly attach a capability and digest inputs to exercise defensive routing.
  return {
    ...request(key),
    type: 'keyreg',
    keyregParams: { address: 'ADDR', networkId: NetworkId.VOI_MAINNET },
  };
}
// DEFECT E3e signed, then lapsed: copy depends only on request type and the flag.
it.each(lapseReasons)(
  'signedThenLapsedBatchUsesNoSendText:%s',
  async (reason) => {
    const req = request(key);
    bind(req);
    const controller = new TransactionAuthController();
    const callbacks = pendingSigner();
    await controller.initializeSigningFlow(req);
    await beginReviewSigning(controller);
    callbacks().onNetworkSubmit!();
    lapse(reason);
    callbacks().onComplete!(completeResult);
    expect(controller.getState().error?.message).toBe(
      signedThenLapsedBatchMessage
    );
    expect(controller.getState().result).toBeNull();
    expect(reviewGrant.endReason(key)).toBe(reason);
    await assertEnded(controller, 'error');
    await cancelThenFreshPinSigns(controller, req);
  }
);
// DEFECT: a non-batch request must never claim that this wallet sent nothing.
it.each(lapseReasons)(
  'signedThenLapsedNonBatchUsesOutcomeUnknownText:%s',
  async (reason) => {
    const req = keyregRequest();
    bind(req);
    const controller = new TransactionAuthController();
    const callbacks = pendingSigner();
    await controller.initializeSigningFlow(req);
    await beginReviewSigning(controller);
    callbacks().onNetworkSubmit!();
    lapse(reason);
    callbacks().onComplete!(completeResult);
    const message = controller.getState().error?.message;
    expect(message).toBe(signedThenLapsedNonBatchMessage);
    expect(message).not.toBe(signedThenLapsedBatchMessage);
    expect(message?.toLowerCase()).not.toContain('start the request again');
    expect(controller.getState().result).toBeNull();
    expect(reviewGrant.endReason(key)).toBe(reason);
    await assertEnded(controller, 'error');
    await cancelThenFreshPinSigns(controller, req);
  }
);
// REGRESSION E3a-E3d: a false flag preserves the ending for every request type.
it.each(lapseReasons)(
  'lapseWithoutSubmitKeepsExistingEnding:%s',
  async (reason) => {
    for (const req of [request(key), keyregRequest()]) {
      bind(req);
      const controller = new TransactionAuthController();
      const callbacks = pendingSigner();
      await controller.initializeSigningFlow(req);
      await beginReviewSigning(controller);
      expect(internals(controller).hasSubmittedToNetwork).toBe(false);
      lapse(reason);
      callbacks().onComplete!(completeResult);
      const message = controller.getState().error?.message;
      expect(message).toBe(lapseMessage);
      expect(message).not.toBe(signedThenLapsedBatchMessage);
      expect(message).not.toBe(signedThenLapsedNonBatchMessage);
      expect(controller.getState().result).toBeNull();
      await assertEnded(controller, 'error');
      await cancelThenFreshPinSigns(controller, req);
    }
  }
);
// E3a-E3d: success and failure must both discard undeliverable results.
it.each(['lock', 'background', 'rotation'] as const)(
  'lapsed%sEndsSigningAndCancelThenFreshPinSigns',
  async (reason) => {
    for (const success of [true, false]) {
      const req = request(key);
      bind(req);
      const controller = new TransactionAuthController();
      const callbacks = pendingSigner();
      await controller.initializeSigningFlow(req);
      await beginReviewSigning(controller);

      if (reason === 'lock') AppLockSignal.setUnlocked(false);
      if (reason === 'background')
        [...appListeners].forEach((listener) => listener('background'));
      if (reason === 'rotation') SessionKeyVault.set('rotated fixture', 'pin');
      callbacks().onComplete!({ success, signedTransactions: ['discard'] });
      expect(controller.getState().error?.message).toBe(lapseMessage);
      expect(reviewGrant.endReason(key)).toBe(reason);
      expect(controller.getState().result).toBeNull();
      await assertEnded(controller, 'error');
      await cancelThenFreshPinSigns(controller, req);
    }
  }
);
// E3e signed, then lapsed: true is DEFECT; false is REGRESSION (E3b-E3d ending).
it.each([true, false])(
  'signedThenLapsedFlag%sWithholdsDappResultAndCancelThenFreshPinSigns',
  async (submitted) => {
    const req = request(key);
    bind(req);
    const controller = new TransactionAuthController();
    const callbacks = pendingSigner();
    await controller.initializeSigningFlow(req);
    await beginReviewSigning(controller);
    if (submitted) callbacks().onNetworkSubmit!();
    internals(controller).hasSubmittedToNetwork = submitted;
    reviewGrant.leave(key);
    callbacks().onComplete!(completeResult);
    expect(controller.getState().error?.message).toBe(
      submitted ? signedThenLapsedBatchMessage : lapseMessage
    );
    expect(controller.getState().result).toBeNull();
    await assertEnded(controller, 'error');
    await cancelThenFreshPinSigns(controller, req);
  }
);
// REGRESSION E4: permission ends before QR setup and stays absent during exchange.
it('remoteSignerPermissionEndsBeforeQrExchange', async () => {
  const req = request(key);
  bind(req);
  (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValueOnce(
    [{ address: 'ADDR', type: AccountType.REMOTE_SIGNER }]
  );
  const controller = new TransactionAuthController();
  jest
    .spyOn(internals(controller), 'initializeRemoteSignerFlow')
    .mockImplementationOnce(async () => {
      expect(req.reviewGrantKey).toBeUndefined();
      expect(reviewGrant.isValid(key)).toBe(false);
      internals(controller).updateState({
        state: 'signing',
        remoteSignerStatus: 'displaying_request',
      });
    });
  await controller.initializeSigningFlow(req);
  expect(controller.getState()).toMatchObject({
    state: 'signing',
    isRemoteSignerFlow: true,
    remoteSignerStatus: 'displaying_request',
  });
  const qrState = controller.getState();
  for (const reason of ['lock', 'background', 'rotation'] as const) {
    lapse(reason);
    expect(reviewGrant.isValid(key)).toBe(false);
    expect(req.reviewGrantKey).toBeUndefined();
    expect(controller.getState()).toEqual(qrState);
  }
  await assertEnded(controller, 'signing');
  expect(signer).not.toHaveBeenCalled();
  await cancelThenFreshPinSigns(controller, req);
});
// DEFECT E5
it.each([false, 'unreadable'])(
  'initializationRefusal%sSurvivesGrantAuthenticationAndCancelThenFreshPinSigns',
  async (failure) => {
    const req = request(key);
    bind(req);
    if (failure === false) pinPresence.mockResolvedValueOnce(false);
    else pinPresence.mockRejectedValueOnce(new Error('unavailable'));
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow(req);
    const before = controller.getState();
    expect(before.error?.message).toBe(
      failure === false ? setupMessage : readMessage
    );
    expect(await controller.authenticateWithReviewGrant(key)).toBe(false);
    expect(controller.getState()).toEqual(before);
    await assertEnded(controller, 'error');
    await cancelThenFreshPinSigns(controller, req);
  }
);
// DEFECT E6
it('spentLedgerFailureRequiresFreshAuthenticationBeforeReadyRetry', async () => {
  const req = request(key);
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  internals(controller).updateState({
    isLedgerFlow: true,
    ledgerStatus: 'searching',
  });
  const callbacks = pendingSigner();
  await beginReviewSigning(controller);
  expect(signer).not.toHaveBeenCalled();
  internals(controller).updateState({ ledgerStatus: 'ready' });
  void internals(controller).maybeStartSigningIfReady();
  callbacks().onComplete!({
    success: false,
    error: new Error('transport failed'),
  });
  await assertEnded(controller, 'authenticating');
  expect(controller.getState().ledgerStatus).toBe('error');
  // Device recovery cannot authorize another signature after this permission ends.
  jest
    .spyOn(
      controller as unknown as { initializeLedgerFlow(): Promise<void> },
      'initializeLedgerFlow'
    )
    .mockImplementationOnce(async () => {
      internals(controller).updateState({ ledgerStatus: 'ready' });
      await internals(controller).maybeStartSigningIfReady();
    });
  await controller.retryLedgerConnection();
  expect(signer).toHaveBeenCalledTimes(1);
  await controller.authenticateWithPin('123456');
  expect(signer).toHaveBeenCalledTimes(2);
  expect(controller.getState().state).toBe('completed');
  await cancelThenFreshPinSigns(controller, req);
});
// REGRESSION E7
it.each(['digest', 'unconsumed'])(
  'preSigner%sFailureNeverTouchesSignerOrKey',
  async (failure) => {
    const req = request(key);
    bind(req);
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow(req);
    if (failure === 'digest') {
      jest.spyOn(internals(controller), 'startSigning').mockResolvedValueOnce();
      await beginReviewSigning(controller);
      jest.restoreAllMocks();
      req.walletConnectParams!.transactions[0].txn = 'AQ==';
    }
    await internals(controller).startSigning();
    expect(controller.getState()).toMatchObject({
      state: 'error',
      error: new Error('Unlock to review this request again.'),
    });
    expect(signer).not.toHaveBeenCalled();
    expect(keyRead).not.toHaveBeenCalled();
  }
);
// DEFECT R2
it('sharedReviewDigestMatchesControllerWithSessionBindingAndRejectsMismatch', async () => {
  const req = request(key);
  req.walletConnectParams!.sessionBinding = {
    topic: 'topic',
    chainId: 'chain',
    networkId: NetworkId.VOI_MAINNET,
    approvedAccounts: ['ADDR'],
  };
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  const args = {
    requestNetworkId: req.networkId,
    sessionBindingNetworkId: req.walletConnectParams!.sessionBinding.networkId,
    transactions: req.walletConnectParams!.transactions,
    reviewedSigners: req.walletConnectParams!.reviewedSigners,
  };
  expect(walletConnectReviewDigest(args)).toBe(
    internals(controller).getReviewDigest()
  );
  expect(
    walletConnectReviewDigest({
      ...args,
      requestNetworkId: null,
      sessionBindingNetworkId: null,
    })
  ).toBeNull();
  req.walletConnectParams!.sessionBinding.networkId =
    NetworkId.ALGORAND_MAINNET;
  expect(
    walletConnectReviewDigest({
      ...args,
      sessionBindingNetworkId: NetworkId.ALGORAND_MAINNET,
    })
  ).toBeNull();
  expect(internals(controller).getReviewDigest()).toBeNull();
  expect(await controller.authenticateWithReviewGrant(key)).toBe(false);
  expect(signer).not.toHaveBeenCalled();
});

// The Ledger device stays pending until the test delivers a terminal callback.
async function enterLedgerSigner(keys = [key]) {
  const req = request(key);
  bind(req);
  if (keys.length > 1) {
    reviewGrant.mintForWaiting(keys);
    reviewGrant.bind(
      key,
      reviewBindingDigest({
        networkId: req.networkId!,
        txnBytesBase64: ['AA=='],
        signerAddresses: ['ADDR'],
      })
    );
  }
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  internals(controller).updateState({
    isLedgerFlow: true,
    ledgerStatus: 'ready',
  });
  let callbacks!: UnifiedSigningCallbacks;
  let settle!: () => void;
  signer.mockImplementationOnce((_req, cb) => {
    callbacks = cb;
    return new Promise<void>((resolve) => {
      settle = resolve;
    });
  });
  const flow = controller.authenticateWithReviewGrant(key);
  expect(signer).toHaveBeenCalledTimes(1);
  const signal = internals(controller).signingAbortController!.signal;
  return {
    controller,
    req,
    callbacks,
    signal,
    finish: async () => {
      settle();
      await flow;
    },
  };
}
async function assertIdleExit(controller: TransactionAuthController) {
  expect(internals(controller).isSigningInProgress).toBe(false);
  expect(internals(controller).currentRequest?.reviewGrantKey).toBeUndefined();
  expect(reviewGrant.isValid(key)).toBe(false);
  expect(reviewGrant.isUnspent(key)).toBe(false);
  expect(reviewGrant.pauseIdle?.(key) ?? false).toBe(false);
  controller.cancel();
  expect(controller.getState().state).toBe('idle');
  expect(internals(controller).isSigningInProgress).toBe(false);
}
// DEFECT
it('ledgerSignPast60sDelivers', async () => {
  const { controller, callbacks, finish } = await enterLedgerSigner();
  jest.advanceTimersByTime(61_000);
  expect(reviewGrant.isValid(key)).toBe(true);
  jest.advanceTimersByTime(5 * 60_000);
  expect(reviewGrant.isValid(key)).toBe(true);
  callbacks.onComplete!(completeResult);
  await finish();
  expect(controller.getState()).toMatchObject({
    state: 'completed',
    result: completeResult,
    error: null,
  });
  await assertIdleExit(controller);
});
// REGRESSION: each event already revokes synchronously; the same guards must cover pauses.
it.each(['Lock', 'Background', 'Rotation'] as const)(
  'ledgerSignPast60sThen%sEndsAtOnce',
  async (event) => {
    const { controller, callbacks, finish } = await enterLedgerSigner();
    if (event === 'Lock') AppLockSignal.setUnlocked(false);
    if (event === 'Background')
      [...appListeners].forEach((listener) => listener('background'));
    if (event === 'Rotation') SessionKeyVault.set('rotated fixture', 'pin');
    // No timer advance between the event and the validity check.
    expect(reviewGrant.isValid(key)).toBe(false);
    expect(reviewGrant.endReason(key)).toBe(event.toLowerCase());
    jest.advanceTimersByTime(61_000 + 5 * 60_000);
    callbacks.onComplete!(completeResult);
    await finish();
    expect(controller.getState()).toMatchObject({
      state: 'error',
      result: null,
      error: new Error(lapseMessage),
    });
    await assertEnded(controller, 'error');
    await assertIdleExit(controller);
  }
);
// DEFECT: neither activity nor consumption of K1 renews K2.
it.each(['touch', 'consume'] as const)(
  'secondWaitingRequestTimerKeepsRunning:%s',
  async (activity) => {
    const req = request(key);
    bind(req);
    reviewGrant.mintForWaiting([key, 'B']);
    reviewGrant.bind(
      key,
      reviewBindingDigest({
        networkId: req.networkId!,
        txnBytesBase64: ['AA=='],
        signerAddresses: ['ADDR'],
      })
    );
    jest.advanceTimersByTime(30_000);
    if (activity === 'touch') reviewGrant.touch(key);
    const controller = new TransactionAuthController();
    const callbacks = pendingSigner();
    await controller.initializeSigningFlow(req);
    internals(controller).updateState({
      isLedgerFlow: true,
      ledgerStatus: 'ready',
    });
    await beginReviewSigning(controller);
    jest.advanceTimersByTime(31_000);
    expect(reviewGrant.isValid('B')).toBe(false);
    expect(reviewGrant.isValid(key)).toBe(true);
    expect(reviewGrant.isUnspent('B')).toBe(false);
    callbacks().onComplete!(completeResult);
    expect(controller.getState()).toMatchObject({
      state: 'completed',
      result: completeResult,
      error: null,
    });
    await assertIdleExit(controller);
  }
);
// DEFECT: success, onError, cleanup and replacement currently retain part of the flow.
it.each(['success', 'error', 'cancel', 'cleanup', 'replaced flow'] as const)(
  'pauseNeverSurvivesAnExit:%s',
  async (exit) => {
    const { controller, callbacks, signal, finish } = await enterLedgerSigner();
    if (exit === 'success') callbacks.onComplete!(completeResult);
    if (exit === 'error') callbacks.onError!(new Error('transport failed'));
    if (exit === 'cancel') controller.cancel();
    if (exit === 'cleanup') controller.cleanup();
    if (exit === 'replaced flow')
      await controller.initializeSigningFlow(request());
    const expected = {
      success: 'completed',
      error: 'authenticating',
      cancel: 'idle',
      cleanup: 'idle',
      'replaced flow': 'authenticating',
    }[exit];
    expect(controller.getState().state).toBe(expected);
    expect(internals(controller).isSigningInProgress).toBe(false);
    expect(
      internals(controller).currentRequest?.reviewGrantKey
    ).toBeUndefined();
    expect(reviewGrant.isValid(key)).toBe(false);
    expect(reviewGrant.isUnspent(key)).toBe(false);
    expect(reviewGrant.pauseIdle?.(key) ?? false).toBe(false);
    if (['cancel', 'cleanup', 'replaced flow'].includes(exit)) {
      expect(signal.aborted).toBe(true);
      const state = controller.getState();
      callbacks.onError!(new Error('late error'));
      callbacks.onComplete!(completeResult);
      expect(controller.getState()).toEqual(state);
    }
    await finish();
    await assertIdleExit(controller);
  }
);
