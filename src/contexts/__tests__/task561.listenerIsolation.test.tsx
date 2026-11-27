/**
 * TASK-561: a throwing listener on AppLockSignal or SessionKeyVault must not cut
 * an unlock short.
 *
 * PIN unlock runs SessionKeyVault.set() then AppLockSignal.setUnlocked(true);
 * biometric unlock fills the vault inside unlockVaultWithBiometrics() and then
 * flips the signal. If a listener's throw escaped either notifier, unlock's catch
 * returned false before setAuthState, leaving React locked while the signal said
 * unlocked and the vault held the secret. After either unlock, all four views
 * must agree: unlock reports success, React auth state is unlocked, the signal
 * reads unlocked and the vault holds a secret.
 *
 * Harness: the mocks of AuthContext.test.tsx, except that SessionKeyVault and
 * AppLockSignal are the REAL modules (they are what is under test). The
 * biometric gate is mocked to fill the real vault, as the real
 * unlockVaultWithBiometrics does after its OS prompt. No real key material is
 * used: the secrets are placeholder strings and nothing derives a key.
 */
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import { AuthProvider, useAuth } from '../AuthContext';

import { MultiAccountWalletService } from '@/services/wallet';
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import { AccountSecureStorage } from '@/services/secure';
import { isWipeInFlight, wipeWalletData } from '@/services/wipe';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';
import { AppLockSignal } from '@/services/secure/appLockState';
import {
  isPinSetupPending,
  clearPinSetupPending,
} from '@/services/secure/pinSetupPending';

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: jest.fn(),
    hasWalletWithAccountsStrict: jest.fn(),
    hasKeyBearingAccountStrict: jest.fn(),
  },
}));

jest.mock('@/services/wallet/crossStoreReconcile', () => ({
  reconcileCrossStoreHalfState: jest.fn(),
}));

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    hasPin: jest.fn(),
    hasPinStrict: jest.fn(),
    isBiometricEnabled: jest.fn(),
    getPinTimeout: jest.fn(),
    verifyPin: jest.fn(),
    getCredentialSource: jest.fn(),
    migrateAllAccountsToV2: jest.fn(),
    setupPin: jest.fn(),
    setBiometricSecret: jest.fn(),
    setBiometricEnabled: jest.fn(),
    clearBiometricSecret: jest.fn(),
    readWipeIntentStrict: jest.fn(),
  },
}));

jest.mock('@/services/wipe', () => ({
  wipeWalletData: jest.fn(),
  isWipeInFlight: jest.fn(),
}));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: jest.fn(),
}));

jest.mock('@/services/secure/pinSetupPending', () => ({
  isPinSetupPending: jest.fn(),
  clearPinSetupPending: jest.fn(),
  isSetupResumeState: jest.requireActual('@/services/secure/pinSetupPending')
    .isSetupResumeState,
}));

jest.mock('@/services/walletconnect/queueReviewKeys', () => ({
  openReviewKeys: jest.fn(() => []),
}));

jest.mock('@/services/secure/biometricUnlock', () => ({
  unlockVaultWithBiometrics: jest.fn(),
}));

jest.mock('@/services/secure/sessionTeardown', () => ({
  enterLockedState: jest.fn(),
}));

jest.mock('@/utils/security', () => ({
  SecurityUtils: { generateSessionId: jest.fn(() => 'test-session-id') },
}));

jest.mock('@/services/deeplink', () => ({
  DeepLinkService: {
    getInstance: jest.fn(() => ({ setUnlockState: jest.fn() })),
  },
}));

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
}));

const mockWallet = MultiAccountWalletService.getCurrentWallet as jest.Mock;
const mockHasWalletStrict =
  MultiAccountWalletService.hasWalletWithAccountsStrict as jest.Mock;
const mockHasKeyBearing =
  MultiAccountWalletService.hasKeyBearingAccountStrict as jest.Mock;
const mockHasPinStrict = AccountSecureStorage.hasPinStrict as jest.Mock;
const mockHasPin = AccountSecureStorage.hasPin as jest.Mock;
const mockIsBiometricEnabled =
  AccountSecureStorage.isBiometricEnabled as jest.Mock;
const mockGetPinTimeout = AccountSecureStorage.getPinTimeout as jest.Mock;
const mockVerifyPin = AccountSecureStorage.verifyPin as jest.Mock;
const mockGetCredentialSource =
  AccountSecureStorage.getCredentialSource as jest.Mock;
const mockMigrate = AccountSecureStorage.migrateAllAccountsToV2 as jest.Mock;
const mockBiometricUnlock = unlockVaultWithBiometrics as jest.Mock;
const mockIsPinSetupPending = isPinSetupPending as jest.Mock;
const mockClearPinSetupPending = clearPinSetupPending as jest.Mock;
const mockReconcile = reconcileCrossStoreHalfState as jest.Mock;
const mockReadWipeIntent =
  AccountSecureStorage.readWipeIntentStrict as jest.Mock;
const mockWipeWalletData = wipeWalletData as jest.Mock;
const mockIsWipeInFlight = isWipeInFlight as jest.Mock;

// Placeholder secrets: verifyPin is mocked, and nothing derives a key.
const TEST_PIN = 'abc123';
const BIOMETRIC_SECRET = 'bio-placeholder';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
};

const mountAuth = async () => {
  const rendered = await renderHook(() => useAuth(), { wrapper });
  await flush();
  return rendered;
};

const unsubscribers: (() => void)[] = [];
let addEventListenerSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  addEventListenerSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(
      (_event: string, _handler: (s: AppStateStatus) => void) =>
        ({ remove: () => {} }) as never
    );
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  // The real singletons outlive a test; start each one locked.
  SessionKeyVault.clear();
  AppLockSignal.setUnlocked(false);

  // A wallet with a PIN (boots LOCKED), biometrics available and enabled.
  mockHasWalletStrict.mockResolvedValue(true);
  mockHasPinStrict.mockResolvedValue(true);
  mockReconcile.mockResolvedValue({
    ran: true,
    orphanSecretsDeleted: [],
    phantomAccountsPruned: [],
    staleJournalDropped: [],
  });
  mockHasKeyBearing.mockResolvedValue(false);
  mockWallet.mockResolvedValue({
    accounts: [{ address: 'ACCT-PLACEHOLDER' }],
  } as never);
  mockHasPin.mockResolvedValue(true);
  mockIsBiometricEnabled.mockResolvedValue(true);
  mockGetPinTimeout.mockResolvedValue(5);
  mockVerifyPin.mockResolvedValue(true);
  mockGetCredentialSource.mockResolvedValue('pin');
  mockMigrate.mockResolvedValue(undefined);
  // Like the real gate after a successful OS prompt: fill the vault.
  mockBiometricUnlock.mockImplementation(async () => {
    SessionKeyVault.set(BIOMETRIC_SECRET, 'pin');
    return { status: 'unlocked' };
  });
  mockIsPinSetupPending.mockResolvedValue(false);
  mockClearPinSetupPending.mockResolvedValue(true);
  mockReadWipeIntent.mockResolvedValue(false);
  mockWipeWalletData.mockResolvedValue(undefined);
  mockIsWipeInFlight.mockReturnValue(false);
});

afterEach(() => {
  unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  SessionKeyVault.clear();
  AppLockSignal.setUnlocked(false);
  addEventListenerSpy.mockRestore();
  warnSpy.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

type Source = 'AppLockSignal' | 'SessionKeyVault';
type Method = 'PIN' | 'biometric';

const sources: Record<
  Source,
  {
    subscribe: (listener: () => void) => () => void;
    isUnlocked: () => boolean;
  }
> = {
  AppLockSignal: {
    subscribe: (listener) => AppLockSignal.subscribe(listener),
    isUnlocked: () => AppLockSignal.isUnlocked(),
  },
  SessionKeyVault: {
    subscribe: (listener) => SessionKeyVault.subscribe(listener),
    isUnlocked: () => SessionKeyVault.isUnlocked(),
  },
};

const cases: [Source, Method][] = [
  ['AppLockSignal', 'PIN'],
  ['AppLockSignal', 'biometric'],
  ['SessionKeyVault', 'PIN'],
  ['SessionKeyVault', 'biometric'],
];

describe('TASK-561 — a throwing listener does not cut an unlock short', () => {
  it.each(cases)(
    'a %s listener that throws on unlock: %s unlock still succeeds and every view agrees',
    async (source, method) => {
      const target = sources[source];
      // Throws only on the UNLOCKED notification (mount's locked sync is quiet).
      unsubscribers.push(
        target.subscribe(() => {
          if (target.isUnlocked()) {
            throw new Error(`${source} listener failed`);
          }
        })
      );
      // Subscribed after the throwing one: must still hear the unlock.
      const laterSawUnlocked = jest.fn();
      unsubscribers.push(
        target.subscribe(() => {
          if (target.isUnlocked()) laterSawUnlocked();
        })
      );

      const { result } = await mountAuth();
      expect(result.current.authState.isLocked).toBe(true);

      let ok!: boolean;
      await act(async () => {
        ok =
          method === 'PIN'
            ? await result.current.unlock(TEST_PIN)
            : await result.current.unlockWithBiometrics();
      });
      await flush();

      expect(ok).toBe(true);
      expect(result.current.authState.isLocked).toBe(false);
      expect(result.current.authState.isAuthenticated).toBe(true);
      expect(AppLockSignal.isUnlocked()).toBe(true);
      expect(SessionKeyVault.isUnlocked()).toBe(true);
      expect(SessionKeyVault.getSecret()).toBe(
        method === 'PIN' ? TEST_PIN : BIOMETRIC_SECRET
      );
      expect(laterSawUnlocked).toHaveBeenCalled();
    }
  );
});
