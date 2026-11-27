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
      getInstance: () => ({ signTransaction }),
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
    })),
  },
}));
jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: {
    getInstance: () => ({ getApprovedAccountsForChain: () => [] }),
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
import {
  ledgerAlgorandService,
  LedgerAlgorandService,
} from '@/services/ledger/algorand';
import { AppLockSignal } from '@/services/secure/appLockState';
import { AccountType } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { TransactionAuthController } from '../transactionAuthController';

const signer = UnifiedTransactionSigner.getInstance()
  .signTransaction as jest.Mock;
const transport = ledgerTransportService as unknown as Record<
  string,
  jest.Mock
>;
const DEVICE = { id: 'device', connected: true, type: 'ble', name: 'Nano' };

const request = (): UnifiedTransactionRequest => ({
  type: 'voi_transfer',
  account: {
    address: 'ADDR',
    type: AccountType.LEDGER,
  } as UnifiedTransactionRequest['account'],
  networkId: NetworkId.VOI_MAINNET,
  transferParams: {
    from: 'ADDR',
    to: 'ADDR',
    amount: 1,
    networkId: NetworkId.VOI_MAINNET,
  } as UnifiedTransactionRequest['transferParams'],
});

type Internals = {
  hasStartedSigning: boolean;
  hasSubmittedToNetwork: boolean;
  signerRunToken: symbol | null;
};
const internals = (controller: TransactionAuthController) =>
  controller as unknown as Internals;

const flush = async () => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

/** The transport's 'disconnected' handler the controller registered. */
const fireDisconnected = () => {
  const call = transport.on.mock.calls.find(
    ([event]) => event === 'disconnected'
  );
  expect(call).toBeDefined();
  (call![1] as () => void)();
};

let release: (() => void) | null;
let captured: UnifiedSigningCallbacks | null;

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
  AppLockSignal.setUnlocked(true);
  (AccountSecureStorage.hasPin as jest.Mock).mockResolvedValue(true);
  (AccountSecureStorage.isBiometricEnabled as jest.Mock).mockResolvedValue(
    false
  );
  (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(false);
  (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(false);
  (SecureKeyManager.getSigningInfo as jest.Mock).mockResolvedValue({
    signingAddress: 'ADDR',
    canSign: true,
  });
  (SecureKeyManager.getLedgerSigningInfo as jest.Mock).mockResolvedValue({
    deviceId: 'device',
    derivationPath: [1],
  });
  (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
    { address: 'ADDR', type: AccountType.LEDGER },
  ]);
  transport.on.mockReset();
  transport.getDevices.mockReturnValue([DEVICE]);
  transport.getConnectedDevice.mockReturnValue(DEVICE);
  transport.startDiscovery.mockResolvedValue(undefined);
  (ledgerAlgorandService.verifyApp as jest.Mock).mockResolvedValue(undefined);
  (
    LedgerAlgorandService.isCurrentlySigningTransaction as jest.Mock
  ).mockReturnValue(false);
  release = null;
  captured = null;
  // The device signs, the send is issued, and the network has not answered.
  signer.mockReset().mockImplementation(
    (_req: UnifiedTransactionRequest, callbacks: UnifiedSigningCallbacks) =>
      new Promise<void>((resolve) => {
        captured = callbacks;
        callbacks.onLedgerPrompt?.({ index: 1, total: 1 });
        callbacks.onLedgerSigned?.({ index: 1, total: 1 });
        callbacks.onNetworkSubmit?.();
        release = resolve;
      })
  );
});
afterEach(() => {
  AppLockSignal.setUnlocked(false);
  jest.clearAllTimers();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function processingWithDeviceLost() {
  const controller = new TransactionAuthController();
  // Not awaited: the flow resolves only when the signer does.
  void controller.initializeSigningFlow(request());
  await flush();
  expect(signer).toHaveBeenCalledTimes(1);
  expect(controller.getState().state).toBe('processing');
  fireDisconnected();
  expect(controller.getState()).toMatchObject({
    state: 'processing',
    ledgerDevice: null,
  });
  return controller;
}

async function finish(controller: TransactionAuthController) {
  captured?.onNetworkConfirmed?.('TXID', true);
  release?.();
  await flush();
  controller.cleanup();
}

describe('processingTryAgainDoesNotSignTwice', () => {
  it('as the app reaches it', async () => {
    const controller = await processingWithDeviceLost();
    void controller.retryLedgerConnection();
    await flush();
    expect(signer).toHaveBeenCalledTimes(1);
    await finish(controller);
  });

  // Isolates the signer-run token: the start latch and the submit marker are
  // forced open, so only the live signer keeps a second signing out.
  it('with only the signer-run token left', async () => {
    const controller = await processingWithDeviceLost();
    internals(controller).hasStartedSigning = false;
    internals(controller).hasSubmittedToNetwork = false;
    void controller.retryLedgerConnection();
    await flush();
    expect(signer).toHaveBeenCalledTimes(1);
    await finish(controller);
  });
});

// Isolates the submit marker in maybeStartSigningIfReady: the start latch and the
// signer-run token are both forced open.
it('submittedFlowNeverRestartsSigning', async () => {
  const controller = await processingWithDeviceLost();
  internals(controller).hasStartedSigning = false;
  internals(controller).signerRunToken = null;
  void controller.retryLedgerConnection();
  await flush();
  expect(signer).toHaveBeenCalledTimes(1);
  await finish(controller);
});

// A failure that reaches the controller's catch after the send was issued must
// not prepare a retry: no return to 'authenticating' and no second signing.
it('submittedFlowSkipsPrepareForRetry', async () => {
  signer.mockImplementationOnce(
    async (
      _req: UnifiedTransactionRequest,
      callbacks: UnifiedSigningCallbacks
    ) => {
      callbacks.onNetworkSubmit?.();
      throw new Error('Ledger device not connected');
    }
  );
  const controller = new TransactionAuthController();
  void controller.initializeSigningFlow(request());
  await flush();
  expect(signer).toHaveBeenCalledTimes(1);
  expect(controller.getState().state).toBe('processing');
  expect(internals(controller).hasStartedSigning).toBe(true);
  controller.cleanup();
});
