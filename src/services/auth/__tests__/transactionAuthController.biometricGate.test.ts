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
    UnifiedTransactionSigner: { getInstance: () => ({ signTransaction }) },
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
jest.mock('@/services/remoteSigner', () => ({ RemoteSignerService: {} }));

import * as LocalAuthentication from 'expo-local-authentication';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { UnifiedTransactionSigner } from '@/services/transactions/unifiedSigner';
import { MultiAccountWalletService } from '@/services/wallet';
import { ledgerTransportService } from '@/services/ledger/transport';
import { AccountType } from '@/types/wallet';
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
