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

import { AppState, type AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SecureKeyManager } from '@/services/secure/keyManager';
import {
  UnifiedTransactionSigner,
  UnifiedTransactionRequest,
  UnifiedSigningCallbacks,
  UnifiedSigningResult,
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
import * as flowLapse from '../flowLapse';
import { ReviewEndedError } from '../ReviewEndedError';
import {
  TransactionAuthController,
  SIGNED_THEN_LAPSED_BATCH_MESSAGE,
} from '../transactionAuthController';

const STOPPED =
  'Your wallet locked or the app went to the background before signing finished. Nothing was sent. Please try again.';
const WITHHELD =
  'Your wallet locked or the app went to the background before this was sent. Nothing was sent. Please try again.';
const WC_STOPPED =
  'Your approval ended before signing finished. Try again in the dApp.';

const signer = UnifiedTransactionSigner.getInstance()
  .signTransaction as jest.Mock;
const transport = ledgerTransportService as unknown as Record<
  string,
  jest.Mock
>;
const DEVICE = { id: 'device', connected: true, type: 'ble', name: 'Nano' };
const VOI = NetworkId.VOI_MAINNET;

type Shape = 'inApp' | 'wc';
const batch = (
  shape: Shape = 'inApp',
  accountType = AccountType.LEDGER,
  sequentialSigning = accountType === AccountType.LEDGER
): UnifiedTransactionRequest => ({
  type: 'batch_transaction',
  account: {
    address: 'ADDR',
    type: accountType,
  } as UnifiedTransactionRequest['account'],
  networkId: VOI,
  walletConnectParams: {
    transactions: [{ txn: 'a' }, { txn: 'b' }, { txn: 'c' }],
    reviewedSigners: ['ADDR'],
    sequentialSigning,
    sessionBinding:
      shape === 'wc'
        ? {
            topic: 'topic',
            chainId: 'voi:chain',
            networkId: VOI,
            approvedAccounts: ['voi:chain:ADDR'],
          }
        : null,
  } as UnifiedTransactionRequest['walletConnectParams'],
});
const transfer = (): UnifiedTransactionRequest => ({
  type: 'voi_transfer',
  account: {
    address: 'ADDR',
    type: AccountType.LEDGER,
  } as UnifiedTransactionRequest['account'],
  networkId: VOI,
  transferParams: {
    from: 'ADDR',
    to: 'ADDR',
    amount: 1,
    networkId: VOI,
  } as UnifiedTransactionRequest['transferParams'],
});

type Internals = {
  cancelledFlowGeneration: number;
  startSigning(pin?: string): Promise<void>;
};
const internals = (controller: TransactionAuthController) =>
  controller as unknown as Internals;

const flush = async () => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

type Run = {
  callbacks: UnifiedSigningCallbacks;
  signal: AbortSignal;
  resolve: () => void;
};
let runs: Run[];
const run = () => runs[runs.length - 1];
let appListeners: Set<(state: AppStateStatus) => void>;
const lapse = (reason: 'lock' | 'background') => {
  if (reason === 'lock') AppLockSignal.setUnlocked(false);
  else [...appListeners].forEach((cb) => cb('background'));
};
const finish = async (result: UnifiedSigningResult) => {
  run().callbacks.onComplete?.(result);
  run().resolve();
  await flush();
};
const cancelled = { success: false, error: new Error('Signing cancelled') };
const signed = { success: true, signedTransactions: ['a', 'b', 'c'] };

/** Live flow-lapse listeners, counted through the module the controller uses. */
let active: Set<unknown>;

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
  appListeners = new Set();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_e, cb) => {
    appListeners.add(cb);
    return { remove: () => appListeners.delete(cb) } as never;
  });
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
  runs = [];
  // Entry 1 is on the device; the signer resolves only when the test says so.
  signer.mockReset().mockImplementation(
    (
      _req: UnifiedTransactionRequest,
      callbacks: UnifiedSigningCallbacks,
      options: { signal: AbortSignal }
    ) =>
      new Promise<void>((resolve) => {
        runs.push({ callbacks, signal: options.signal, resolve });
        callbacks.onLedgerPrompt?.({ index: 1, total: 3 });
      })
  );
  active = new Set();
  const subscribe = flowLapse.subscribeFlowLapse;
  jest.spyOn(flowLapse, 'subscribeFlowLapse').mockImplementation((cb) => {
    active.add(cb);
    const stop = subscribe(cb);
    return () => {
      active.delete(cb);
      stop();
    };
  });
});
afterEach(() => {
  AppLockSignal.setUnlocked(false);
  jest.clearAllTimers();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function signing(request: UnifiedTransactionRequest) {
  const controller = new TransactionAuthController();
  void controller.initializeSigningFlow(request);
  await flush();
  expect(signer).toHaveBeenCalledTimes(1);
  expect(controller.getState().state).toBe('signing');
  return controller;
}

const expectLapseError = (
  controller: TransactionAuthController,
  message: string
) => {
  const state = controller.getState();
  expect(state.state).toBe('error');
  expect(state.result).toBeNull();
  expect(state.error).toBeInstanceOf(ReviewEndedError);
  expect(state.error?.message).toBe(message);
  expect((state.error as ReviewEndedError).title).toBe('Request ended');
};

// The watch stops the loop and keeps the outcome callback live: it aborts the
// signal and never bumps the generation, so the lapse publishes its own text.
describe.each(['lock', 'background'] as const)('lapse by %s', (reason) => {
  it.each([
    ['inApp', STOPPED],
    ['wc', WC_STOPPED],
  ] as const)('noGrantLapseStopsBeforeSigned:%s', async (shape, message) => {
    const controller = await signing(batch(shape));
    const generation = internals(controller).cancelledFlowGeneration;
    lapse(reason);
    expect(run().signal.aborted).toBe(true);
    expect(internals(controller).cancelledFlowGeneration).toBe(generation);
    await finish(cancelled);
    expectLapseError(controller, message);
  });

  it.each([
    ['inApp', WITHHELD],
    ['wc', SIGNED_THEN_LAPSED_BATCH_MESSAGE],
  ] as const)('noGrantSignedThenLapsedWithholds:%s', async (shape, message) => {
    const controller = await signing(batch(shape));
    run().callbacks.onNetworkSubmit?.();
    lapse(reason);
    await finish(signed);
    expectLapseError(controller, message);
  });

  it('noGrantLapseDuringDeviceFailureKeepsLapseText', async () => {
    const controller = await signing(batch());
    lapse(reason);
    const error = new Error('Ledger device not connected');
    run().callbacks.onError?.(error);
    expectLapseError(controller, STOPPED);
    await finish({ success: false, error });
    expectLapseError(controller, STOPPED);
  });

  // Keyed on signsSequentially, not on the Ledger flow: a software route that
  // signs one entry at a time is watched too.
  it('noGrantSequentialSoftwareRouteStops', async () => {
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      { address: 'ADDR', type: AccountType.STANDARD },
    ]);
    (SecureKeyManager.getLedgerSigningInfo as jest.Mock).mockResolvedValue(
      null
    );
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow(
      batch('inApp', AccountType.STANDARD, true)
    );
    expect(controller.getState().isLedgerFlow).toBe(false);
    void internals(controller).startSigning('123456');
    await flush();
    expect(signer).toHaveBeenCalledTimes(1);
    lapse(reason);
    expect(run().signal.aborted).toBe(true);
    await finish(cancelled);
    expectLapseError(controller, STOPPED);
  });

  // A lapse that lands before the watch is installed (here, during the PIN
  // presence check) still stops the flow before its first entry.
  it('noGrantLapseBeforeWatchInstalledStops', async () => {
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      { address: 'ADDR', type: AccountType.STANDARD },
    ]);
    (SecureKeyManager.getLedgerSigningInfo as jest.Mock).mockResolvedValue(
      null
    );
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow(
      batch('inApp', AccountType.STANDARD, true)
    );
    let answer!: (value: boolean) => void;
    (AccountSecureStorage.hasPin as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })
    );
    void internals(controller).startSigning('123456');
    await flush();
    lapse(reason);
    answer(true);
    await flush();
    if (signer.mock.calls.length) {
      expect(run().signal.aborted).toBe(true);
      await finish(cancelled);
    }
    expectLapseError(controller, STOPPED);
  });
});

it('noGrantSuccessCarriesLapseEpoch', async () => {
  const controller = await signing(batch());
  run().callbacks.onNetworkSubmit?.();
  await finish(signed);
  const state = controller.getState();
  expect(state.state).toBe('completed');
  const epoch = state.result?.lapseEpoch;
  expect(typeof epoch).toBe('number');
  expect(flowLapse.flowLapsedSince(epoch)).toBe(false);
  // The caller checks the same epoch right before its send.
  AppLockSignal.setUnlocked(false);
  expect(flowLapse.flowLapsedSince(epoch)).toBe(true);
});

// Q7: a non-batch Ledger send is out of scope and stays unwatched.
it('noGrantNonBatchLedgerSendNotWatched', async () => {
  const controller = await signing(transfer());
  expect(active.size).toBe(0);
  lapse('lock');
  lapse('background');
  expect(run().signal.aborted).toBe(false);
  run().callbacks.onNetworkSubmit?.();
  run().callbacks.onNetworkConfirmed?.('TXID', true);
  await finish({ success: true, transactionId: 'TXID', confirmed: true });
  expect(controller.getState().state).toBe('completed');
  expect(controller.getState().result?.lapseEpoch).toBeUndefined();
});

it.each(['completion', 'cancel', 'reset', 'newFlow', 'cleanup'] as const)(
  'noGrantWatchEndsOnEveryExit:%s',
  async (exit) => {
    const controller = await signing(batch());
    expect(active.size).toBe(1);
    const first = run();
    if (exit === 'completion') await finish(signed);
    if (exit === 'cancel') controller.cancel({ byUser: true });
    if (exit === 'reset') controller.resetAfterDismiss();
    if (exit === 'cleanup') controller.cleanup();
    if (exit === 'newFlow') {
      void controller.initializeSigningFlow(batch());
      await flush();
    }
    // The ended flow holds no watch. (A new flow is refused while the old
    // signer is still alive, so it installs none either.)
    expect(active.size).toBe(0);
    const before = controller.getState();
    lapse('lock');
    if (exit === 'completion' || exit === 'cancel' || exit === 'reset')
      expect(controller.getState()).toEqual(before);
    first.resolve();
    await flush();
    controller.cleanup();
    expect(active.size).toBe(0);
  }
);
