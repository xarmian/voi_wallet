// Unit tests for the PR6.1 biometric-sign fix in TransactionAuthController.
//
// Regression fixed: the modal fired Face ID whenever the DEVICE had biometrics
// enrolled (OS-level), but getPrivateKey(pin=undefined) refuses unless the
// IN-APP biometric-unlock feature is enabled — so a user with Face ID enrolled
// but the in-app feature OFF got a Face ID prompt that then failed with "PIN
// required", retried 3×, and showed "unlock your Ledger device".
//
// These tests pin the two behaviors that fix it:
//   1. determineAuthRequirements gates biometric-to-sign on isBiometricEnabled()
//      for SOFTWARE keys (Case A → straight to PIN), while a LEDGER flow keeps
//      OS-level biometric as a pure UI gate.
//   2. authenticateWithBiometrics for a software key routes through
//      unlockVaultWithBiometrics (populating the vault for v2 keys), NOT a bare
//      OS prompt; invalidated/cancelled falls back to PIN without signing.
//
// NOTE on mocking: every jest.mock factory creates its jest.fn()s INLINE (no
// reference to outer consts) — ES import hoisting evaluates the controller and
// its expo/native deps before any top-level `const mock…` initializes, so a
// factory closing over an outer const would capture `undefined` (TDZ). Handles
// are recovered from the mocked module imports and configured in beforeEach.

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
let mockApprovedAccounts: string[] = [];
jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: {
    getInstance: () => ({
      getApprovedAccountsForChain: () => mockApprovedAccounts,
    }),
  },
}));
jest.mock('@/services/transactions', () => ({
  TransactionService: { buildTransaction: jest.fn() },
}));

import * as LocalAuthentication from 'expo-local-authentication';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { UnifiedTransactionSigner } from '@/services/transactions/unifiedSigner';
import { MultiAccountWalletService } from '@/services/wallet';
import { ledgerTransportService } from '@/services/ledger/transport';
import {
  paymentTxn,
  makeAccount,
  SUGGESTED_PARAMS,
} from '@/__tests__/fixtures/algorand';
import { RemoteSignerService } from '@/services/remoteSigner';
import { NetworkService } from '@/services/network';
import { getRekeyStatusEpoch } from '@/services/wallet/rekeyStatusInvalidation';
import { NETWORK_CONFIGURATIONS } from '@/services/network/config';
import { getRekeyStateStrict } from '@/store/walletStore';
import { NetworkId } from '@/types/network';
import { AccountType } from '@/types/wallet';
import {
  PENDING_TRANSACTION_ALERT,
  toUnsettledTransactionAlert,
} from '@/utils/errorMapping';
import { TransactionAuthController } from '../transactionAuthController';

const mockLA = LocalAuthentication as jest.Mocked<typeof LocalAuthentication>;
const mockASS = AccountSecureStorage as jest.Mocked<
  typeof AccountSecureStorage
>;
const mockUnlock = unlockVaultWithBiometrics as jest.Mock;
const mockGetLedgerSigningInfo =
  SecureKeyManager.getLedgerSigningInfo as jest.Mock;
const mockSignTransaction = UnifiedTransactionSigner.getInstance()
  .signTransaction as jest.Mock;

const softwareRequest = {
  account: { address: 'ADDR', type: AccountType.STANDARD },
  pin: undefined,
} as any;

const flush = () => new Promise((r) => setTimeout(r, 0));

async function initFlow(controller: TransactionAuthController) {
  await controller.initializeSigningFlow(softwareRequest);
  await flush();
}

beforeEach(() => {
  // clearMocks (jest config) wipes call records before each test; re-seed the
  // default implementations here.
  mockLA.hasHardwareAsync.mockResolvedValue(true);
  mockLA.isEnrolledAsync.mockResolvedValue(true);
  mockLA.authenticateAsync.mockResolvedValue({ success: true } as any);

  mockASS.hasPin.mockResolvedValue(true);
  mockASS.isBiometricEnabled.mockResolvedValue(false);
  mockASS.verifyPin.mockResolvedValue(true);

  mockUnlock.mockResolvedValue({ status: 'unlocked' });

  (SecureKeyManager.getSigningInfo as jest.Mock).mockResolvedValue({
    canSign: true,
    signingAddress: 'ADDR',
    signingAccountId: undefined,
    isRekeyed: false,
  });
  mockGetLedgerSigningInfo.mockRejectedValue(new Error('not ledger'));

  (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
    { address: 'ADDR', type: 'standard' },
  ]);
  (MultiAccountWalletService.getCurrentWallet as jest.Mock).mockResolvedValue({
    accounts: [{ address: 'ADDR', type: 'standard', id: 'acct-1' }],
  });

  (ledgerTransportService.startDiscovery as jest.Mock).mockResolvedValue(
    undefined
  );
  (ledgerTransportService.getConnectedDevice as jest.Mock).mockReturnValue(
    null
  );
  (ledgerTransportService.getDevices as jest.Mock).mockReturnValue([]);

  mockSignTransaction.mockResolvedValue({
    success: true,
    transactionId: 'tx-1',
  });
});

describe('determineAuthRequirements — biometric-to-sign gate (PR6.1)', () => {
  it('Case A: Face ID enrolled but in-app biometrics OFF → no biometric, PIN only', async () => {
    mockASS.isBiometricEnabled.mockResolvedValue(false);
    const controller = new TransactionAuthController();
    await initFlow(controller);

    const state = controller.getState();
    // The modal keys its auto-trigger + fingerprint button off biometricAvailable.
    expect(state.biometricAvailable).toBe(false);
    expect(state.requiresBiometric).toBe(false);
    expect(state.requiresPin).toBe(true);
    expect(state.isLedgerFlow).toBe(false);
    expect(state.state).toBe('authenticating');
  });

  it('Case B: Face ID enrolled AND in-app biometrics ON → biometric usable', async () => {
    mockASS.isBiometricEnabled.mockResolvedValue(true);
    const controller = new TransactionAuthController();
    await initFlow(controller);

    const state = controller.getState();
    expect(state.biometricAvailable).toBe(true);
    expect(state.requiresBiometric).toBe(true);
    expect(state.requiresPin).toBe(true);
  });

  it('OS biometrics unavailable → biometric off even with in-app flag ON', async () => {
    mockLA.hasHardwareAsync.mockResolvedValue(false);
    mockASS.isBiometricEnabled.mockResolvedValue(true);
    const controller = new TransactionAuthController();
    await initFlow(controller);

    expect(controller.getState().biometricAvailable).toBe(false);
  });
});

describe('authenticateWithBiometrics — software path routes through the vault (PR6.1)', () => {
  beforeEach(() => {
    mockASS.isBiometricEnabled.mockResolvedValue(true);
  });

  it('unlocked → populates the vault, does NOT use a bare OS prompt, and signs', async () => {
    mockUnlock.mockResolvedValue({ status: 'unlocked' });
    const controller = new TransactionAuthController();
    await initFlow(controller);

    const ok = await controller.authenticateWithBiometrics();
    await flush();

    expect(ok).toBe(true);
    expect(mockUnlock).toHaveBeenCalledTimes(1);
    // Software path must NOT fall back to a bare OS prompt (that leaves the vault
    // empty → a v2 key would fail to decrypt).
    expect(mockLA.authenticateAsync).not.toHaveBeenCalled();
    // Signing started with no PIN (the vault supplies the wrap key).
    expect(mockSignTransaction).toHaveBeenCalledTimes(1);
  });

  it('invalidated (enrollment change) → PIN fallback + hides the now-disabled biometric control, never signs', async () => {
    mockUnlock.mockResolvedValue({ status: 'invalidated' });
    const controller = new TransactionAuthController();
    await initFlow(controller);
    expect(controller.getState().biometricAvailable).toBe(true); // before

    const ok = await controller.authenticateWithBiometrics();
    await flush();

    expect(ok).toBe(false);
    expect(mockSignTransaction).not.toHaveBeenCalled();
    const s = controller.getState();
    expect(s.state).toBe('authenticating');
    // The fingerprint button must disappear now that biometrics is disabled.
    expect(s.biometricAvailable).toBe(false);
    expect(s.requiresBiometric).toBe(false);
  });

  it('cancelled → falls back to PIN, never signs', async () => {
    mockUnlock.mockResolvedValue({ status: 'cancelled' });
    const controller = new TransactionAuthController();
    await initFlow(controller);

    const ok = await controller.authenticateWithBiometrics();
    await flush();

    expect(ok).toBe(false);
    expect(mockSignTransaction).not.toHaveBeenCalled();
    expect(controller.getState().state).toBe('authenticating');
  });
});

describe('software signing failure is never Ledger-shaped (PR6.1, onError + onComplete)', () => {
  it('an auth error during PIN signing → back to PIN entry, no "unlock your Ledger"', async () => {
    // The signer ALWAYS calls onError THEN onComplete(failResult) on a throw
    // (unifiedSigner). Both must keep a software wallet PIN-shaped, not
    // Ledger-shaped — this pins the onComplete-clobber Codex found.
    mockASS.isBiometricEnabled.mockResolvedValue(false); // PIN flow (Case A)
    const authErr = new Error(
      'Failed to retrieve private key: PIN required to access private key'
    );
    mockSignTransaction.mockImplementation(
      async (_req: any, callbacks: any) => {
        callbacks?.onError?.(authErr);
        callbacks?.onComplete?.({ success: false, error: authErr });
        return { success: false, error: authErr };
      }
    );

    const controller = new TransactionAuthController();
    await initFlow(controller);

    await controller.authenticateWithPin('123456');
    await flush();

    const s = controller.getState();
    expect(s.state).toBe('authenticating'); // returned to PIN entry, not 'error'
    expect(s.ledgerError).toBeNull(); // NEVER "Please unlock your Ledger device"
    expect(s.ledgerStatus).not.toBe('error'); // not Ledger-shaped
    expect(s.error?.message).toContain('Enter your PIN');
  });
});

describe('request-network signing authority', () => {
  it('fails closed when auth preflight cannot resolve authority', async () => {
    (SecureKeyManager.getSigningInfo as jest.Mock).mockRejectedValueOnce(
      new Error('offline')
    );
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow({
      ...softwareRequest,
      networkId: NetworkId.ALGORAND_MAINNET,
    });
    expect(controller.getState()).toMatchObject({
      state: 'error',
      isRemoteSignerFlow: false,
    });
    expect(SecureKeyManager.getSigningInfo).toHaveBeenCalledWith(
      'ADDR',
      NetworkId.ALGORAND_MAINNET
    );
  });

  it('ignores stale metadata in flow selection and stamps the request network in the QR envelope', async () => {
    const sender = makeAccount('u2a-sender');
    const auth = makeAccount('u2a-auth');
    const txn = paymentTxn(sender.addr, {
      suggestedParams: {
        ...SUGGESTED_PARAMS,
        genesisHash: new Uint8Array(
          Buffer.from(
            NETWORK_CONFIGURATIONS[NetworkId.ALGORAND_MAINNET].genesisHash,
            'base64'
          )
        ),
      },
    });
    const { TransactionService } = require('@/services/transactions');
    TransactionService.buildTransaction.mockResolvedValue({ txn });
    (SecureKeyManager.getSigningInfo as jest.Mock).mockResolvedValue({
      signingAddress: auth.addr,
    });
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      { address: auth.addr, type: AccountType.REMOTE_SIGNER },
    ]);
    (getRekeyStateStrict as jest.Mock).mockResolvedValue({
      isRekeyed: true,
      authAddress: auth.addr,
      canSign: true,
    });
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow({
      type: 'voi_transfer',
      account: {
        address: sender.addr,
        type: AccountType.REKEYED,
        authAddress: 'STALE',
        canSign: false,
      },
      transferParams: { networkId: NetworkId.ALGORAND_MAINNET },
    } as any);
    const request = controller.getState().remoteSignerRequest!;
    expect(controller.getState().isRemoteSignerFlow).toBe(true);
    expect(request.gh).toBe(
      NETWORK_CONFIGURATIONS[NetworkId.ALGORAND_MAINNET].genesisHash
    );
    expect(request).toMatchObject({
      net: NetworkId.ALGORAND_MAINNET,
      txns: [{ s: auth.addr, a: auth.addr }],
    });
    expect(getRekeyStateStrict).toHaveBeenCalledWith(
      sender.addr,
      NetworkId.ALGORAND_MAINNET
    );
    expect(SecureKeyManager.getSigningInfo).toHaveBeenCalledWith(
      sender.addr,
      NetworkId.ALGORAND_MAINNET
    );
    const net = NetworkService.getInstance(request.net as NetworkId);
    (NetworkService.getInstance as jest.Mock).mockReturnValue(net);
    (net.getAccountRekeyInfo as jest.Mock).mockResolvedValue({
      isRekeyed: true,
      authAddress: auth.addr,
    });
    await controller.processRemoteSignerResponse({
      v: request.v,
      t: 'res',
      id: request.id,
      ts: Date.now(),
      ok: true,
      sigs: [{ i: 0, b: Buffer.from(txn.signTxn(auth.sk)).toString('base64') }],
    });
    expect(controller.getState().state).toBe('completed');
    expect(controller.getState().result?.transactionId).toBe('tx');
    expect(NetworkService.getInstance).toHaveBeenLastCalledWith(
      NetworkId.ALGORAND_MAINNET
    );
    expect(net.getAccountRekeyInfo).toHaveBeenCalledWith(sender.addr, true);
    expect(
      (await RemoteSignerService.createSigningRequest([txn], [sender.addr])).net
    ).toBe(NetworkId.VOI_MAINNET);
    (getRekeyStateStrict as jest.Mock).mockRejectedValueOnce(
      new Error('offline')
    );
    await (controller as any).initializeRemoteSignerFlow();
    expect(controller.getState()).toMatchObject({
      state: 'error',
      remoteSignerStatus: 'error',
    });
  });
});

// Real signed responses through the controller and the production caller
// callbacks. Only UI/transport closure dependencies are supplied by the fixture.
describe('remote batch submission ownership (TASK-418)', () => {
  const { screenHandler } = require('@/__tests__/fixtures/screenHandler');
  const { NetworkId: Nets } = require('@/types/network');
  const owner = makeAccount('task418-owner');
  const wrong = makeAccount('task418-wrong');
  const netId = Nets.VOI_MAINNET;
  const txn = paymentTxn(owner.addr, {
    suggestedParams: {
      ...SUGGESTED_PARAMS,
      genesisID: NETWORK_CONFIGURATIONS[netId as NetworkId].genesisId,
      genesisHash: new Uint8Array(
        Buffer.from(
          NETWORK_CONFIGURATIONS[netId as NetworkId].genesisHash,
          'base64'
        )
      ),
    },
  });
  const encoded = Buffer.from(txn.toByte()).toString('base64');
  const signed = Buffer.from(txn.signTxn(owner.sk)).toString('base64');
  const submit = jest.fn(async (_bytes: Uint8Array | Uint8Array[]) => ({
    txId: 'batch-tx',
    confirmed: true,
  }));
  const respondV1 = jest.fn();
  const respondV2 = jest.fn();
  const net = {
    getSuggestedParams: jest.fn(),
    getCurrentNetworkId: () => netId,
    getAccountRekeyInfo: jest.fn(async () => ({ isRekeyed: false })),
    submitTransaction: submit,
    getAlgodClient: () => ({
      sendRawTransaction: (bytes: Uint8Array[]) => ({
        do: () => submit(bytes),
      }),
    }),
  };

  beforeEach(() => {
    mockApprovedAccounts = [
      `${NETWORK_CONFIGURATIONS[netId as NetworkId].chainId}:${owner.addr}`,
    ];
    (NetworkService.getInstance as jest.Mock).mockReturnValue(net);
    (SecureKeyManager.getSigningInfo as jest.Mock).mockResolvedValue({
      signingAddress: owner.addr,
    });
    (MultiAccountWalletService.getAllAccounts as jest.Mock).mockResolvedValue([
      { address: owner.addr, type: AccountType.REMOTE_SIGNER },
    ]);
    (getRekeyStateStrict as jest.Mock).mockResolvedValue({ isRekeyed: false });
  });

  async function flow(type = 'batch_transaction', declined = false) {
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow({
      type,
      networkId: netId,
      account: { address: owner.addr, type: AccountType.REMOTE_SIGNER },
      walletConnectParams: {
        transactions: [
          { txn: encoded },
          ...(declined ? [{ txn: encoded, signers: [] }] : []),
        ],
        reviewedSigners: [owner.addr],
        sessionBinding: declined
          ? {
              topic: 'dapp',
              networkId: netId,
              chainId: NETWORK_CONFIGURATIONS[netId as NetworkId].chainId,
              approvedAccounts: mockApprovedAccounts,
            }
          : null,
      },
    } as any);
    expect(controller.getState().isRemoteSignerFlow).toBe(true);
    const request = controller.getRemoteSignerRequest()!;
    expect(request.txns).toHaveLength(1);
    const response = RemoteSignerService.createSuccessResponse(request.id, [
      txn.signTxn(owner.sk),
    ]);
    return { controller, request, response };
  }

  function scope() {
    const noop = jest.fn();
    return {
      Buffer,
      Uint8Array,
      NetworkService,
      CLAIM_NETWORK_ID: netId,
      selectedNetwork: netId,
      hasSubmittedRef: { current: false },
      // TASK-416 unit 3's recovery hook, closed over by the claim callbacks.
      recover: jest.fn(async (_error: unknown, _group: unknown) => false),
      txnGroup: [],
      ARC200_RECONFIRM_MESSAGE: 'Network state changed, please confirm again.',
      navigation: {
        dispatch: jest.fn(),
        navigate: jest.fn(),
        goBack: jest.fn(),
        canGoBack: () => true,
      },
      CommonActions: { reset: (value: unknown) => value },
      claimableItem: { id: 'claim' },
      items: [{ id: 'claim' }],
      Alert: { alert: jest.fn() },
      // The claim callbacks' pending rendering (TASK-447 / TASK-451).
      toUnsettledTransactionAlert,
      PENDING_TRANSACTION_ALERT,
      Toast: { show: noop },
      redactError: (e: unknown) => e,
      setIsSwapping: noop,
      setIsWaitingForConfirmation: noop,
      delayedRefreshTimeout: { current: null },
      setTimeout: noop,
      accountId: null,
      routeParams: null,
      inputToken: null,
      settledRef: { current: false },
      requestEvent: { id: 418, topic: 'dapp' },
      WalletConnectService: {
        getInstance: () => ({ respondToRequest: respondV2 }),
      },
      WalletConnectV1Client: {
        getInstance: () => ({ approveRequest: respondV1 }),
      },
      takeNextRequest: async () => null,
      forgetUnanswered: noop,
      setShowAuthModal: noop,
      setCurrentRequest: noop,
    };
  }

  it('returns nulls without a QR exchange when every entry is declined', async () => {
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow({
      type: 'walletconnect_batch',
      networkId: netId,
      account: { address: owner.addr, type: AccountType.REMOTE_SIGNER },
      walletConnectParams: {
        transactions: [{ txn: encoded, signers: [] }],
        reviewedSigners: [owner.addr],
        sessionBinding: null,
      },
    } as any);
    expect(controller.getState().result).toEqual({
      success: true,
      signedTransactions: [null],
    });
    expect(controller.getRemoteSignerRequest()).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['ClaimTokenScreen', 'ClaimAllConfirmationScreen', 'SwapScreen'])(
    '%s submits a remote batch exactly once',
    async (screen) => {
      const { controller, response } = await flow();
      await controller.processRemoteSignerResponse(response);
      const result = controller.getState().result;
      const env = scope();
      await screenHandler(
        `wallet/${screen}`,
        screen === 'SwapScreen' ? 'handleSwapSuccess' : 'onSuccess',
        env
      )(result);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith([
        new Uint8Array(Buffer.from(signed, 'base64')),
      ]);
      expect(result).toEqual({ success: true, signedTransactions: [signed] });
      expect(env.Alert.alert).not.toHaveBeenCalled();
      expect(env.navigation.dispatch).toHaveBeenCalled();
    }
  );

  it.each([1, 2])(
    'WalletConnect v%s returns base64/null without broadcasting',
    async (version) => {
      const { controller, response } = await flow('batch_transaction', true);
      await controller.processRemoteSignerResponse(response);
      const env = { ...scope(), version };
      await screenHandler(
        'walletconnect/TransactionRequestScreen',
        'handleWalletConnectSuccess',
        env
      )(controller.getState().result);
      if (version === 1) {
        expect(respondV1).toHaveBeenCalledWith(418, [signed, null]);
        expect(respondV2).not.toHaveBeenCalled();
      } else {
        expect(respondV2).toHaveBeenCalledWith('dapp', 418, [signed, null]);
        expect(respondV1).not.toHaveBeenCalled();
      }
      expect(submit).not.toHaveBeenCalled();
      expect(env.navigation.navigate).not.toHaveBeenCalled();
    }
  );

  it('legacy walletconnect_batch returns base64/null through the response callback without broadcasting', async () => {
    const { controller, response } = await flow('walletconnect_batch', true);
    await controller.processRemoteSignerResponse(response);
    const env = { ...scope(), version: 2 };
    const handler = screenHandler(
      'walletconnect/TransactionRequestScreen',
      'handleWalletConnectSuccess',
      env
    );
    await handler(controller.getState().result);
    expect(respondV2).toHaveBeenCalledWith('dapp', 418, [signed, null]);
    expect(respondV1).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  async function transferFlow(
    controller = new TransactionAuthController(),
    type = 'voi_transfer'
  ) {
    const { TransactionService } = require('@/services/transactions');
    const realService = jest.requireActual(
      '@/services/transactions'
    ).TransactionService;
    (TransactionService.buildTransaction as jest.Mock).mockImplementation(
      realService.buildTransaction.bind(realService)
    );
    TransactionService.buildRekeyTransaction =
      realService.buildRekeyTransaction.bind(realService);
    TransactionService.buildRekeyReverseTransaction =
      realService.buildRekeyReverseTransaction.bind(realService);
    // The pre-submit custody re-check (TASK-425 U3).
    TransactionService.assertSignsAfterRekey =
      realService.assertSignsAfterRekey.bind(realService);
    net.getSuggestedParams = jest.fn(async () => ({
      ...SUGGESTED_PARAMS,
      genesisID: NETWORK_CONFIGURATIONS[netId as NetworkId].genesisId,
      genesisHash: new Uint8Array(
        Buffer.from(
          NETWORK_CONFIGURATIONS[netId as NetworkId].genesisHash,
          'base64'
        )
      ),
    }));
    // The rekey builders check the receiving key is held (TASK-425 U3).
    (MultiAccountWalletService.getCurrentWallet as jest.Mock).mockResolvedValue(
      {
        accounts: [
          { id: 'owner', address: owner.addr, type: AccountType.REMOTE_SIGNER },
          { id: 'wrong', address: wrong.addr, type: AccountType.STANDARD },
        ],
      }
    );
    await controller.initializeSigningFlow({
      type,
      rekeyParams: {
        fromAddress: owner.addr,
        rekeyToAddress: wrong.addr,
        networkId: netId,
      },
      networkId: netId,
      account: { address: owner.addr, type: AccountType.REMOTE_SIGNER },
      transferParams: {
        from: owner.addr,
        to: wrong.addr,
        amount: 7,
        networkId: netId,
      },
    } as any);
    return controller;
  }

  it.each(['rekey', 'rekey_reverse', 'voi_transfer'])(
    '%s invalidates only after successful remote rekey submission',
    async (type) => {
      const controller = await transferFlow(
        new TransactionAuthController(),
        type
      );
      const request = controller.getRemoteSignerRequest()!;
      const bytes = require('algosdk')
        .decodeUnsignedTransaction(Buffer.from(request.txns[0].b, 'base64'))
        .signTxn(owner.sk);
      const response = RemoteSignerService.createSuccessResponse(request.id, [
        bytes,
      ]);
      const before = getRekeyStatusEpoch();
      submit.mockRejectedValueOnce(new Error('offline'));
      await controller.processRemoteSignerResponse(response);
      expect(getRekeyStatusEpoch()).toBe(before);
      await controller.processRemoteSignerResponse(response);
      expect(controller.getState().result?.success).toBe(true);
      expect(getRekeyStatusEpoch()).toBe(
        before + (type === 'voi_transfer' ? 0 : 1)
      );
    }
  );

  it.each(['rekey', 'rekey_reverse'])(
    '%s is not submitted when the receiving key is lost during the QR round trip (TASK-425 U3)',
    async (type) => {
      const controller = await transferFlow(
        new TransactionAuthController(),
        type
      );
      const request = controller.getRemoteSignerRequest()!;
      const bytes = require('algosdk')
        .decodeUnsignedTransaction(Buffer.from(request.txns[0].b, 'base64'))
        .signTxn(owner.sk);
      // While the QR request is out, the receiving record loses its key.
      (
        MultiAccountWalletService.getCurrentWallet as jest.Mock
      ).mockResolvedValue({
        accounts: [
          { id: 'owner', address: owner.addr, type: AccountType.WATCH },
          { id: 'wrong', address: wrong.addr, type: AccountType.WATCH },
        ],
      });
      await controller.processRemoteSignerResponse(
        RemoteSignerService.createSuccessResponse(request.id, [bytes])
      );
      expect(submit).not.toHaveBeenCalled();
      expect(controller.getState().result?.success).not.toBe(true);
    }
  );

  it('voi_transfer built by TransactionService retains controller submission', async () => {
    const controller = await transferFlow();
    const request = controller.getRemoteSignerRequest()!;
    const algosdk = require('algosdk');
    const bytes = algosdk
      .decodeUnsignedTransaction(Buffer.from(request.txns[0].b, 'base64'))
      .signTxn(owner.sk);
    await controller.processRemoteSignerResponse(
      RemoteSignerService.createSuccessResponse(request.id, [bytes])
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(bytes);
    expect(controller.getState().result).toMatchObject({
      transactionId: 'batch-tx',
      confirmed: true,
    });
  });

  it.each(['cancel', 'resetAfterDismiss', 'cancelRemoteSignerFlow', 'replace'])(
    'discards a response when %s occurs during verification',
    async (action) => {
      const { controller, response } = await flow();
      let release!: (value: { isRekeyed: boolean }) => void;
      let entered!: () => void;
      const pending = new Promise<{ isRekeyed: boolean }>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      net.getAccountRekeyInfo.mockImplementationOnce(() => {
        entered();
        return pending;
      });
      const processing = controller.processRemoteSignerResponse(response);
      await started;
      if (action === 'replace') await transferFlow(controller);
      else
        controller[
          action as 'cancel' | 'resetAfterDismiss' | 'cancelRemoteSignerFlow'
        ]();
      const state = controller.getState();
      const request = controller.getRemoteSignerRequest();
      expect((controller as any).remoteBatchPlan).toBeNull();
      release({ isRekeyed: false });
      await processing;
      expect(submit).not.toHaveBeenCalled();
      expect(controller.getState()).toEqual(state);
      expect(controller.getState().state).not.toBe('completed');
      expect(controller.getRemoteSignerRequest()).toBe(request);
    }
  );

  // Codex confirm (TASK-418): a stale INITIALIZATION (batch planning still
  // pending) must not publish its plan or an all-declined result onto the next
  // request.
  it('a replaced flow never publishes its pending batch plan onto the next request', async () => {
    const controller = new TransactionAuthController();
    const realPlan = (controller as any).unifiedSigner.planBatch.bind(
      (controller as any).unifiedSigner
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const planning = new Promise<void>((resolve) => (entered = resolve));
    (controller as any).unifiedSigner.planBatch = async (request: unknown) => {
      entered();
      await gate;
      return realPlan(request);
    };
    const first = controller.initializeSigningFlow({
      type: 'walletconnect_batch',
      networkId: netId,
      account: { address: owner.addr, type: AccountType.REMOTE_SIGNER },
      walletConnectParams: {
        transactions: [{ txn: encoded, signers: [] }],
        reviewedSigners: [owner.addr],
        sessionBinding: null,
      },
    } as any);
    // Wait until A is actually inside batch planning, then replace it.
    await planning;
    await transferFlow(controller);
    const afterReplace = controller.getState();
    release();
    await first;
    expect(controller.getState()).toEqual(afterReplace);
    expect(controller.getState().result).not.toEqual({
      success: true,
      signedTransactions: [null],
    });
    expect((controller as any).remoteBatchPlan).toBeNull();
    expect(submit).not.toHaveBeenCalled();
  });

  it('uses the captured batch type and plan even if currentRequest is cleared', async () => {
    const { controller, response } = await flow();
    net.getAccountRekeyInfo.mockImplementationOnce(async () => {
      (controller as any).currentRequest = null;
      (controller as any).remoteBatchPlan = null;
      return { isRekeyed: false };
    });
    await controller.processRemoteSignerResponse(response);
    expect(submit).not.toHaveBeenCalled();
    expect(controller.getState().result).toEqual({
      success: true,
      signedTransactions: [signed],
    });
  });

  it('restores distinct interleaved sign, passthrough and declined slots exactly', async () => {
    const distinct = [1, 2, 3, 4].map((amount) =>
      paymentTxn(owner.addr, {
        amount,
        suggestedParams: {
          ...SUGGESTED_PARAMS,
          genesisID: txn.genesisID,
          genesisHash: txn.genesisHash,
        },
      })
    );
    const blobs = distinct.map((entry) =>
      Buffer.from(entry.signTxn(owner.sk)).toString('base64')
    );
    const controller = new TransactionAuthController();
    await controller.initializeSigningFlow({
      type: 'walletconnect_batch',
      networkId: netId,
      account: { address: owner.addr, type: AccountType.REMOTE_SIGNER },
      walletConnectParams: {
        transactions: distinct.map((entry, i) => ({
          txn:
            i === 1 ? blobs[i] : Buffer.from(entry.toByte()).toString('base64'),
          ...(i === 1 || i === 2 ? { signers: [] } : {}),
        })),
        reviewedSigners: [owner.addr],
        sessionBinding: null,
      },
    } as any);
    const request = controller.getRemoteSignerRequest()!;
    expect(request.txns).toHaveLength(2);
    const response = RemoteSignerService.createSuccessResponse(request.id, [
      distinct[0].signTxn(owner.sk),
      distinct[3].signTxn(owner.sk),
    ]);
    response.sigs!.reverse(); // Indexed responses may arrive in any order.
    await controller.processRemoteSignerResponse(response);
    expect(controller.getState().result).toEqual({
      success: true,
      signedTransactions: [blobs[0], blobs[1], null, blobs[3]],
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['ClaimTokenScreen', 'ClaimAllConfirmationScreen'])(
    '%s retries with the same ref after validation or submit failure and blocks in-flight duplicates',
    async (screen) => {
      const env = scope();
      const handler = screenHandler(`wallet/${screen}`, 'onSuccess', env);
      await handler({ signedTransactions: [null] });
      expect(env.hasSubmittedRef.current).toBe(false);
      expect(submit).not.toHaveBeenCalled();
      submit.mockRejectedValueOnce(new Error('offline'));
      await handler({ signedTransactions: [signed] });
      expect(env.hasSubmittedRef.current).toBe(false);
      let release!: (value: { txId: string; confirmed: boolean }) => void;
      submit.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      );
      const retry = handler({ signedTransactions: [signed] });
      await handler({ signedTransactions: [signed] });
      expect(submit).toHaveBeenCalledTimes(2);
      expect(env.hasSubmittedRef.current).toBe(true);
      release({ txId: 'retry', confirmed: true });
      await retry;
      expect(env.navigation.dispatch).toHaveBeenCalledTimes(1);
    }
  );

  // TASK-418 + TASK-416: after a recovery rebuild, the user confirms again and
  // the SAME mounted callback must submit (the latch is released first).
  it.each(['ClaimTokenScreen', 'ClaimAllConfirmationScreen'])(
    '%s submits the reconfirmed group after a recovery rebuild',
    async (screen) => {
      const env = scope();
      env.recover.mockResolvedValueOnce('rebuilt' as never);
      const handler = screenHandler(`wallet/${screen}`, 'onSuccess', env);
      submit.mockRejectedValueOnce(new Error('below min'));
      await handler({ signedTransactions: [signed] });
      expect(env.recover).toHaveBeenCalledTimes(1);
      expect(env.navigation.goBack).toHaveBeenCalledTimes(1);
      expect(env.Alert.alert).toHaveBeenCalledWith(
        'Confirm Again',
        'Network state changed, please confirm again.'
      );
      expect(env.hasSubmittedRef.current).toBe(false);
      await handler({ signedTransactions: [signed] });
      expect(submit).toHaveBeenCalledTimes(2);
      expect(env.navigation.dispatch).toHaveBeenCalledTimes(1);
    }
  );

  // Codex focused confirm (#208): while recover() is still awaiting, a second
  // success callback for the OLD group must not submit.
  it.each(['ClaimTokenScreen', 'ClaimAllConfirmationScreen'])(
    '%s blocks an old-group submit while recovery is pending, then accepts the reconfirm',
    async (screen) => {
      const env = scope();
      let finishRecovery!: (value: unknown) => void;
      env.recover.mockImplementationOnce(
        () => new Promise((resolve) => (finishRecovery = resolve)) as never
      );
      const handler = screenHandler(`wallet/${screen}`, 'onSuccess', env);
      submit.mockRejectedValueOnce(new Error('below min'));
      const first = handler({ signedTransactions: [signed] });
      // Let the failed submit reach the pending recovery.
      for (let i = 0; i < 5 && env.recover.mock.calls.length === 0; i += 1)
        await Promise.resolve();
      expect(env.recover).toHaveBeenCalledTimes(1);
      await handler({ signedTransactions: [signed] });
      expect(submit).toHaveBeenCalledTimes(1);
      finishRecovery('rebuilt');
      await first;
      expect(env.hasSubmittedRef.current).toBe(false);
      await handler({ signedTransactions: [signed] });
      expect(submit).toHaveBeenCalledTimes(2);
    }
  );

  // Codex focused confirm 2 (#208): a THROWING recovery must not leave the
  // latch set (that would silently swallow every later submit).
  it.each(['ClaimTokenScreen', 'ClaimAllConfirmationScreen'])(
    '%s releases the latch and shows the original error when recovery throws',
    async (screen) => {
      const env = scope();
      env.recover.mockRejectedValueOnce(new Error('rebuild exploded'));
      const handler = screenHandler(`wallet/${screen}`, 'onSuccess', env);
      submit.mockRejectedValueOnce(new Error('below min'));
      await handler({ signedTransactions: [signed] });
      expect(env.hasSubmittedRef.current).toBe(false);
      expect(env.Alert.alert).toHaveBeenCalledWith(
        'Submission Failed',
        'below min'
      );
      await handler({ signedTransactions: [signed] });
      expect(submit).toHaveBeenCalledTimes(2);
    }
  );

  it.each(['signer', 'network', 'genesis'])(
    'still rejects mismatched %s',
    async (mismatch) => {
      const { controller, request, response } = await flow();
      if (mismatch === 'signer')
        response.sigs![0].b = Buffer.from(txn.signTxn(wrong.sk)).toString(
          'base64'
        );
      if (mismatch !== 'signer') {
        const foreign = paymentTxn(owner.addr, {
          suggestedParams: {
            ...SUGGESTED_PARAMS,
            genesisID:
              NETWORK_CONFIGURATIONS[Nets.ALGORAND_MAINNET as NetworkId]
                .genesisId,
            genesisHash: new Uint8Array(
              Buffer.from(
                NETWORK_CONFIGURATIONS[Nets.ALGORAND_MAINNET as NetworkId]
                  .genesisHash,
                'base64'
              )
            ),
          },
        });
        response.sigs![0].b = Buffer.from(foreign.signTxn(owner.sk)).toString(
          'base64'
        );
        if (mismatch === 'network') {
          // A matching foreign request/response still resolves authority on
          // request.net; an account rekeyed there cannot use the sender's key.
          request.txns[0].b = Buffer.from(foreign.toByte()).toString('base64');
          request.net = Nets.ALGORAND_MAINNET;
          request.gh =
            NETWORK_CONFIGURATIONS[
              Nets.ALGORAND_MAINNET as NetworkId
            ].genesisHash;
          net.getAccountRekeyInfo.mockResolvedValueOnce({
            isRekeyed: true,
            authAddress: wrong.addr,
          } as any);
        }
      }
      await controller.processRemoteSignerResponse(response);
      expect(controller.getState().state).toBe('error');
      expect(controller.getState().result).toBeNull();
      expect(submit).not.toHaveBeenCalled();
    }
  );
});

it('uses the supplied signing summary for software biometrics (TASK-437)', async () => {
  mockASS.isBiometricEnabled.mockResolvedValue(true);
  const controller = new TransactionAuthController();
  await initFlow(controller);
  await controller.authenticateWithBiometrics('Send 12.5 VOI to ABCD…WXYZ');
  expect(mockUnlock).toHaveBeenCalledWith('Send 12.5 VOI to ABCD…WXYZ');
});
it('requests confirmation on the Ledger biometric gate (TASK-437)', async () => {
  const controller = new TransactionAuthController();
  (controller as any).currentState = {
    ...controller.getState(),
    biometricAvailable: true,
    isLedgerFlow: true,
    ledgerStatus: 'ready',
  };
  (controller as any).startSigning = jest.fn();
  mockLA.authenticateAsync.mockResolvedValue({ success: true });
  await controller.authenticateWithBiometrics(
    'Sign 3 transactions for example.org'
  );
  expect(mockLA.authenticateAsync).toHaveBeenCalledWith(
    expect.objectContaining({
      promptMessage: 'Sign 3 transactions for example.org',
      requireConfirmation: true,
    })
  );
});

it('clears a real biometric vault after a locked signing flow (TASK-437 negative control)', async () => {
  const { SessionKeyVault } = require('@/services/secure/SessionKeyVault');
  const { AppLockSignal } = require('@/services/secure/appLockState');
  const realUnlock = jest.requireActual(
    '@/services/secure/biometricUnlock'
  ).unlockVaultWithBiometrics;
  AppLockSignal.setUnlocked(false);
  mockASS.isBiometricEnabled.mockResolvedValue(true);
  (AccountSecureStorage.getBiometricSecret as jest.Mock).mockResolvedValue({
    secret: 'fixture',
    secretSource: 'pin',
  });
  mockUnlock.mockImplementation(realUnlock);
  const controller = new TransactionAuthController();
  await initFlow(controller);
  await controller.authenticateWithBiometrics();
  expect(SessionKeyVault.isUnlocked()).toBe(false);
  expect(AppLockSignal.isUnlocked()).toBe(false);
});

it('unlocks review once, then signs via a grant without authenticating again (TASK-437)', async () => {
  const { reviewGrant } = require('../reviewGrant');
  const { AppLockSignal } = require('@/services/secure/appLockState');
  AppLockSignal.setUnlocked(false);
  mockASS.isBiometricEnabled.mockResolvedValue(true);
  (AccountSecureStorage.getBiometricSecret as jest.Mock).mockResolvedValue({
    secret: 'fixture',
    secretSource: 'pin',
  });
  mockUnlock.mockImplementation(
    jest.requireActual('@/services/secure/biometricUnlock')
      .unlockVaultWithBiometrics
  );
  expect(await reviewGrant.unlock('topic:437', { biometric: true })).toBe(true);
  const controller = new TransactionAuthController();
  await initFlow(controller);
  (controller as any).currentRequest.reviewGrantKey = 'topic:437';
  expect(await controller.authenticateWithReviewGrant('topic:437')).toBe(true);
  expect(AccountSecureStorage.getBiometricSecret).toHaveBeenCalledTimes(1);
  expect(AccountSecureStorage.verifyPin).not.toHaveBeenCalled();
  expect(mockSignTransaction).toHaveBeenCalledTimes(1);
  expect(await controller.authenticateWithReviewGrant('topic:437')).toBe(false);
  reviewGrant.revoke();
});

it('lets a failed Sign be retried inside the review sitting (TASK-437 Luna P3)', async () => {
  const { reviewGrant } = require('../reviewGrant');
  const { AppLockSignal } = require('@/services/secure/appLockState');
  AppLockSignal.setUnlocked(false);
  mockASS.isBiometricEnabled.mockResolvedValue(true);
  (AccountSecureStorage.getBiometricSecret as jest.Mock).mockResolvedValue({
    secret: 'fixture',
    secretSource: 'pin',
  });
  mockUnlock.mockImplementation(
    jest.requireActual('@/services/secure/biometricUnlock')
      .unlockVaultWithBiometrics
  );
  const signErr = new Error('node unavailable');
  mockSignTransaction.mockImplementationOnce(
    async (_req: any, callbacks: any) => {
      callbacks?.onError?.(signErr);
      callbacks?.onComplete?.({ success: false, error: signErr });
      return { success: false, error: signErr };
    }
  );
  expect(await reviewGrant.unlock('topic:retry', { biometric: true })).toBe(
    true
  );
  const controller = new TransactionAuthController();
  await initFlow(controller);
  (controller as any).currentRequest.reviewGrantKey = 'topic:retry';

  expect(await controller.authenticateWithReviewGrant('topic:retry')).toBe(
    true
  );
  await flush();
  // The failed attempt handed the Sign back: a fresh claim signs again,
  // with no second auth.
  (controller as any).currentState.state = 'authenticating';
  expect(await controller.authenticateWithReviewGrant('topic:retry')).toBe(
    true
  );
  expect(mockSignTransaction).toHaveBeenCalledTimes(2);
  expect(AccountSecureStorage.getBiometricSecret).toHaveBeenCalledTimes(1);
  reviewGrant.revoke();
});
