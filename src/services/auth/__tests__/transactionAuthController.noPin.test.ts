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

import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SecureKeyManager } from '@/services/secure/keyManager';
import {
  UnifiedTransactionSigner,
  UnifiedTransactionRequest,
} from '@/services/transactions/unifiedSigner';
import { MultiAccountWalletService } from '@/services/wallet';
import * as LocalAuthentication from 'expo-local-authentication';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { reviewGrant, reviewBindingDigest } from '../reviewGrant';
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
};
const internals = (controller: TransactionAuthController) =>
  controller as unknown as SigningInternals;
beforeEach(() => {
  pinPresence.mockReset().mockResolvedValue(true);
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
  signer.mockReset().mockImplementation(async () => {
    await keyRead();
    return { success: true };
  });
});
afterEach(() => {
  reviewGrant.revoke();
  SessionKeyVault.clear();
  AppLockSignal.setUnlocked(false);
  jest.restoreAllMocks();
});

it.each([
  'no reviewGrantKey',
  'with reviewGrantKey',
  'restore-before-PIN window',
  'setupPin crash window',
])('noPinSoftwareKeyNeverSigns: %s', async (window) => {
  pinPresence.mockResolvedValue(false);
  const req = request(window === 'with reviewGrantKey' ? 'A' : undefined);
  if (req.reviewGrantKey) bind(req);
  // The restore and setup crash windows retain key-bearing accounts on disk.
  expect((await MultiAccountWalletService.getAllAccounts()).length).toBe(1);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  expect(controller.getState().state).toBe('error');
  expect(controller.getState().error?.message).toBe(setupMessage);
  expect(signer).not.toHaveBeenCalled();
  expect(keyRead).not.toHaveBeenCalled();
});
it('unreadablePinIsNotAbsent', async () => {
  pinPresence.mockRejectedValueOnce(new Error('unavailable'));
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(request());
  expect(controller.getState().state).toBe('error');
  expect(controller.getState().error?.message).toBe(readMessage);
  expect(signer).not.toHaveBeenCalled();
  await controller.initializeSigningFlow(request());
  expect(controller.getState().state).toBe('authenticating');
  expect(controller.getState().requiresPin).toBe(true);
  await controller.authenticateWithPin('123456');
  expect(signer).toHaveBeenCalledTimes(1);
});
it.each([false, 'throw'])(
  'startSigningRechecksPinBeforeKeyAccess: %s',
  async (result) => {
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow(request());
    if (result === false) pinPresence.mockResolvedValue(false);
    else pinPresence.mockRejectedValue(new Error('unavailable'));
    await internals(controller).startSigning();
    expect(controller.getState().state).toBe('error');
    expect(controller.getState().error?.message).toBe(
      result === false ? setupMessage : readMessage
    );
    expect(signer).not.toHaveBeenCalled();
    expect(keyRead).not.toHaveBeenCalled();
  }
);
it('ledgerFlowIgnoresPinRefusal', async () => {
  pinPresence.mockResolvedValue(false);
  (SecureKeyManager.getLedgerSigningInfo as jest.Mock).mockResolvedValue({
    deviceId: 'device',
    derivationPath: [1],
  });
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(request());
  expect(controller.getState()).toMatchObject({
    state: 'authenticating',
    isLedgerFlow: true,
    ledgerStatus: 'searching',
  });
  controller.cleanup();
});
it('waitingCapabilitySignsWithoutSecondPromptAndLateArrivalUsesPin', async () => {
  const req = request('A');
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  expect(await controller.authenticateWithReviewGrant('A')).toBe(true);
  expect(signer).toHaveBeenCalledTimes(1);
  expect(AccountSecureStorage.verifyPin).not.toHaveBeenCalled();
  expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  await controller.initializeSigningFlow(request());
  expect(controller.getState().state).toBe('authenticating');
  expect(controller.getState().requiresPin).toBe(true);
  expect(signer).toHaveBeenCalledTimes(1);
  await controller.authenticateWithPin('123456');
  expect(AccountSecureStorage.verifyPin).toHaveBeenCalledTimes(1);
  expect(signer).toHaveBeenCalledTimes(2);
});
it('consumeOnceUnderDoubleTap: controller starts one signing', async () => {
  const req = request('A');
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  const results = await Promise.all([
    controller.authenticateWithReviewGrant('A'),
    controller.authenticateWithReviewGrant('A'),
  ]);
  expect(results).toEqual([true, false]);
  expect(signer).toHaveBeenCalledTimes(1);
});
it.each(['bytes', 'chain', 'signers', 'same'] as const)(
  'consumeOnceThenVerifyAgainBeforeSigning: %s',
  async (change) => {
    const req = request('A');
    bind(req);
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow(req);
    const start = jest
      .spyOn(internals(controller), 'startSigning')
      .mockResolvedValueOnce();
    expect(await controller.authenticateWithReviewGrant('A')).toBe(true);
    start.mockRestore();
    expect(
      reviewGrant.isConsumedFor(
        'A',
        reviewBindingDigest({
          networkId: req.networkId!,
          txnBytesBase64: ['AA=='],
          signerAddresses: ['ADDR'],
        })
      )
    ).toBe(true);
    if (change === 'bytes')
      req.walletConnectParams!.transactions[0].txn = 'AQ==';
    if (change === 'chain') req.networkId = NetworkId.ALGORAND_MAINNET;
    if (change === 'signers')
      req.walletConnectParams!.reviewedSigners = ['OTHER'];
    await internals(controller).startSigning();
    if (change === 'same') expect(signer).toHaveBeenCalledTimes(1);
    else {
      expect(controller.getState().state).toBe('error');
      expect(signer).not.toHaveBeenCalled();
      expect(keyRead).not.toHaveBeenCalled();
    }
    expect(await controller.authenticateWithReviewGrant('A')).toBe(false);
  }
);
it('releaseOnlyBeforeKeyAccess: a validity failure releases', async () => {
  const req = request('A');
  bind(req);
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  pinPresence.mockResolvedValue(false);
  const release = jest.spyOn(reviewGrant, 'release');
  await controller.authenticateWithReviewGrant('A');
  expect(release).toHaveBeenCalledWith('A');
  expect(signer).not.toHaveBeenCalled();
  expect(keyRead).not.toHaveBeenCalled();
  const d = reviewBindingDigest({
    networkId: req.networkId!,
    txnBytesBase64: ['AA=='],
    signerAddresses: ['ADDR'],
  });
  expect(reviewGrant.consume('A', d)).toBe(true);
});
it('releaseOnlyBeforeKeyAccess: signing failure leaves permission used', async () => {
  const req = request('A');
  bind(req);
  signer.mockImplementationOnce(async (_req, callbacks) => {
    await keyRead();
    callbacks.onComplete({
      success: false,
      error: new Error('signing failed'),
    });
  });
  const controller = new TransactionAuthController();
  await controller.initializeSigningFlow(req);
  const release = jest.spyOn(reviewGrant, 'release');
  await controller.authenticateWithReviewGrant('A');
  expect(keyRead).toHaveBeenCalledTimes(1);
  expect(release).not.toHaveBeenCalled();
  expect(await controller.authenticateWithReviewGrant('A')).toBe(false);
  expect(signer).toHaveBeenCalledTimes(1);
});
