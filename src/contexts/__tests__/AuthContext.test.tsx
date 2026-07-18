/**
 * P0 unit tests for AuthContext (TASK-160).
 *
 * Covers the session-lock security surface:
 *  - initial locked/unlocked state derivation
 *  - PIN unlock and biometric unlock (success / failure / invalidation)
 *  - inactivity-timeout lock
 *  - background -> foreground app-state lock
 *  - unmount teardown: NO leaked AppState subscription, NO leaked timers
 *
 * DR-3 / CLAUDE.md: expo-local-authentication, AppState, and every secure-store
 * leaf are mocked. No real key/mnemonic material is ever fabricated or logged —
 * the vault/teardown/lock-signal modules are mocked as opaque effect sinks and
 * the tests only assert that the wiring calls them, never that they hold a key.
 *
 * TEST-ONLY: AuthContext and the crypto/secure source are never modified.
 */
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import { AuthProvider, useAuth } from '../AuthContext';

import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';
import { enterLockedState } from '@/services/secure/sessionTeardown';
import { AppLockSignal } from '@/services/secure/appLockState';
import * as LocalAuthentication from 'expo-local-authentication';

// --- Mocks: wallet + every secure-store leaf, vault, teardown, lock signal. ---
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: jest.fn(),
  },
}));

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    hasPin: jest.fn(),
    isBiometricEnabled: jest.fn(),
    getPinTimeout: jest.fn(),
    verifyPin: jest.fn(),
    getCredentialSource: jest.fn(),
    migrateAllAccountsToV2: jest.fn(),
    setupPin: jest.fn(),
    setBiometricSecret: jest.fn(),
    setBiometricEnabled: jest.fn(),
    clearBiometricSecret: jest.fn(),
  },
}));

jest.mock('@/services/secure/SessionKeyVault', () => ({
  SessionKeyVault: {
    set: jest.fn(),
    getSecret: jest.fn(() => null),
    getSecretSource: jest.fn(() => 'pin'),
  },
}));

jest.mock('@/services/secure/biometricUnlock', () => ({
  unlockVaultWithBiometrics: jest.fn(),
}));

jest.mock('@/services/secure/sessionTeardown', () => ({
  enterLockedState: jest.fn(),
}));

jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: { setUnlocked: jest.fn() },
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

// Typed handles to the mocked members we drive per-test.
const mockWallet = MultiAccountWalletService.getCurrentWallet as jest.Mock;
const mockHasPin = AccountSecureStorage.hasPin as jest.Mock;
const mockIsBiometricEnabled =
  AccountSecureStorage.isBiometricEnabled as jest.Mock;
const mockGetPinTimeout = AccountSecureStorage.getPinTimeout as jest.Mock;
const mockVerifyPin = AccountSecureStorage.verifyPin as jest.Mock;
const mockGetCredentialSource =
  AccountSecureStorage.getCredentialSource as jest.Mock;
const mockMigrate = AccountSecureStorage.migrateAllAccountsToV2 as jest.Mock;
const mockVaultSet = SessionKeyVault.set as jest.Mock;
const mockBiometricUnlock = unlockVaultWithBiometrics as jest.Mock;
const mockEnterLocked = enterLockedState as jest.Mock;
const mockSetUnlocked = AppLockSignal.setUnlocked as jest.Mock;

// A non-empty account list so checkInitialAuthState treats the wallet as
// "requires auth". Address is a throwaway label, never key material.
const WALLET_WITH_ACCOUNTS = {
  accounts: [{ address: 'ACCT-PLACEHOLDER' }],
} as never;

// Not a real secret — an arbitrary 6-char string only used to exercise the
// verifyPin branch (verifyPin itself is fully mocked; nothing derives a key).
const TEST_PIN = 'abc123';

// AppState listener capture.
let appStateHandler: ((s: AppStateStatus) => void) | undefined;
let appStateRemove: jest.Mock;
let addEventListenerSpy: jest.SpyInstance;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

// Flush the sequential awaits inside checkInitialAuthState (and any queued
// microtasks) under fake timers.
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
};

const mountAuth = async () => {
  // renderHook manages its own act(); wrapping it in an outer act() leaves the
  // renderer looking unmounted. Render directly, then flush the mount effects'
  // async checkInitialAuthState chain.
  const rendered = renderHook(() => useAuth(), { wrapper });
  await flush();
  return rendered;
};

beforeEach(() => {
  jest.useFakeTimers();

  appStateHandler = undefined;
  appStateRemove = jest.fn();
  addEventListenerSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(
      (_event: string, handler: (s: AppStateStatus) => void) => {
        appStateHandler = handler;
        return { remove: appStateRemove } as never;
      }
    );

  // Default baseline: a wallet that exists, has a PIN, 5-min timeout, biometrics
  // available + enabled. Individual tests override as needed.
  mockWallet.mockResolvedValue(WALLET_WITH_ACCOUNTS);
  mockHasPin.mockResolvedValue(true);
  mockIsBiometricEnabled.mockResolvedValue(true);
  mockGetPinTimeout.mockResolvedValue(5);
  mockVerifyPin.mockResolvedValue(true);
  mockGetCredentialSource.mockResolvedValue('pin');
  mockMigrate.mockResolvedValue(undefined);
  mockBiometricUnlock.mockResolvedValue({ status: 'unlocked' });
});

afterEach(() => {
  addEventListenerSpy.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('AuthContext — initial state', () => {
  it('starts LOCKED when a wallet with a PIN exists', async () => {
    const { result } = await mountAuth();

    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.hasPin).toBe(true);
    expect(result.current.authState.biometricEnabled).toBe(true);
    expect(result.current.authState.sessionId).toBeNull();
  });

  it('starts UNLOCKED (setup mode) when no wallet / no PIN exists', async () => {
    mockWallet.mockResolvedValue(null);
    mockHasPin.mockResolvedValue(false);

    const { result } = await mountAuth();

    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
    expect(result.current.authState.hasPin).toBe(false);
  });

  it('reports biometricEnabled=false when hardware is unavailable even if the flag is on', async () => {
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValueOnce(
      false
    );

    const { result } = await mountAuth();

    expect(result.current.authState.biometricEnabled).toBe(false);
  });
});

describe('AuthContext — PIN unlock', () => {
  it('unlocks with a valid PIN and populates the session vault + lock signal', async () => {
    const { result } = await mountAuth();

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.unlock(TEST_PIN);
    });

    expect(ok).toBe(true);
    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
    expect(result.current.authState.sessionId).toBe('test-session-id');
    expect(mockVaultSet).toHaveBeenCalledWith(TEST_PIN, 'pin');
    expect(mockSetUnlocked).toHaveBeenCalledWith(true);
  });

  it('rejects an invalid PIN and stays locked without touching the vault', async () => {
    mockVerifyPin.mockResolvedValue(false);
    const { result } = await mountAuth();

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.unlock(TEST_PIN);
    });

    expect(ok).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(mockVaultSet).not.toHaveBeenCalled();
  });

  it('rejects an empty secret without calling verifyPin', async () => {
    const { result } = await mountAuth();

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.unlock('');
    });

    expect(ok).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(mockVerifyPin).not.toHaveBeenCalled();
  });
});

describe('AuthContext — biometric unlock', () => {
  it('unlocks on biometric success', async () => {
    const { result } = await mountAuth();

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.unlockWithBiometrics();
    });

    expect(ok).toBe(true);
    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
    expect(mockSetUnlocked).toHaveBeenCalledWith(true);
  });

  it('stays locked when biometric auth is cancelled', async () => {
    mockBiometricUnlock.mockResolvedValue({ status: 'cancelled' });
    const { result } = await mountAuth();

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.unlockWithBiometrics();
    });

    expect(ok).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    // A cancel must NOT flip the lock signal to unlocked.
    expect(mockSetUnlocked).not.toHaveBeenCalledWith(true);
  });

  it('disables biometrics on an invalidation and stays locked (never asks for the mnemonic)', async () => {
    mockBiometricUnlock.mockResolvedValue({ status: 'invalidated' });
    const { result } = await mountAuth();

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.unlockWithBiometrics();
    });

    expect(ok).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.biometricEnabled).toBe(false);
  });

  it('refuses biometric unlock when biometrics are not enabled', async () => {
    mockIsBiometricEnabled.mockResolvedValue(false);
    const { result } = await mountAuth();

    let ok!: boolean;
    await act(async () => {
      ok = await result.current.unlockWithBiometrics();
    });

    expect(ok).toBe(false);
    expect(mockBiometricUnlock).not.toHaveBeenCalled();
    expect(result.current.authState.isLocked).toBe(true);
  });
});

describe('AuthContext — inactivity timeout lock', () => {
  it('locks the session and runs teardown after the inactivity window elapses', async () => {
    const { result } = await mountAuth();

    await act(async () => {
      await result.current.unlock(TEST_PIN);
    });
    expect(result.current.authState.isLocked).toBe(false);

    mockEnterLocked.mockClear();

    // Advance past the 5-minute timeout; the session timer + activity interval
    // both route inactivity through lock().
    await act(async () => {
      jest.advanceTimersByTime(5 * 60 * 1000 + 1000);
      await Promise.resolve();
    });

    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.sessionId).toBeNull();
    // Single teardown path must have fired (session vault / caches).
    expect(mockEnterLocked).toHaveBeenCalled();
  });

  it('does NOT lock while activity keeps getting refreshed', async () => {
    const { result } = await mountAuth();

    await act(async () => {
      await result.current.unlock(TEST_PIN);
    });

    // Repeatedly poke activity every 2 minutes across a 6-minute span.
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(2 * 60 * 1000);
        result.current.updateActivity();
        await Promise.resolve();
      });
    }

    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
  });
});

describe('AuthContext — background/foreground app-state lock', () => {
  it('locks after the background grace period expires', async () => {
    const { result } = await mountAuth();

    await act(async () => {
      await result.current.unlock(TEST_PIN);
    });
    expect(result.current.authState.isLocked).toBe(false);
    expect(appStateHandler).toBeDefined();

    // App backgrounds -> a 60s grace timer is armed.
    await act(async () => {
      appStateHandler!('background');
      await Promise.resolve();
    });

    mockEnterLocked.mockClear();

    // Grace period elapses without returning -> auto-lock.
    await act(async () => {
      jest.advanceTimersByTime(60 * 1000 + 1000);
      await Promise.resolve();
    });

    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(mockEnterLocked).toHaveBeenCalled();
  });

  it('stays unlocked when returning to foreground within the grace period', async () => {
    const { result } = await mountAuth();

    await act(async () => {
      await result.current.unlock(TEST_PIN);
    });

    await act(async () => {
      appStateHandler!('background');
      await Promise.resolve();
    });

    // Return well within the 60s grace window.
    await act(async () => {
      jest.advanceTimersByTime(10 * 1000);
      appStateHandler!('active');
      await Promise.resolve();
    });

    // And let more (formerly-grace) time pass to prove the timer was cancelled.
    await act(async () => {
      jest.advanceTimersByTime(60 * 1000);
      await Promise.resolve();
    });

    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
  });

  // KNOWN BUG (reported, source intentionally NOT fixed — TASK-160 is test-only).
  // Lock-BYPASS on a suspended app: the AppState 'change' handler is created once
  // in the mount effect and closes over a STALE `authState.backgroundedAt` (the
  // value at first render — null). The only thing that actually locks after
  // backgrounding is the 60s JS setTimeout. If the OS suspends the JS runtime
  // (common on real devices) that timer never fires; when the user returns after
  // the grace window the handler reads the stale null backgroundedAt, so the
  // `now - backgroundedAt > grace` branch is skipped and the wallet stays
  // UNLOCKED. Documented via it.failing; flip to a plain `it` once the handler
  // reads live state (e.g. via a ref) so a post-grace foreground return locks.
  it.failing(
    'locks on foreground return after the grace window when the background timer never fired (suspended app)',
    async () => {
      const { result } = await mountAuth();

      await act(async () => {
        await result.current.unlock(TEST_PIN);
      });
      expect(result.current.authState.isLocked).toBe(false);

      const t0 = Date.now();

      // App backgrounds; a 60s JS lock timer is armed.
      await act(async () => {
        appStateHandler!('background');
        await Promise.resolve();
      });

      // Model a SUSPENDED app: the JS runtime was frozen so the armed background
      // timer never ran, yet real wall-clock time advanced well past the grace
      // window. setSystemTime moves Date.now WITHOUT firing any pending timer.
      await act(async () => {
        jest.setSystemTime(t0 + 60 * 1000 + 5000);
        appStateHandler!('active');
        await Promise.resolve();
      });

      // SECURITY EXPECTATION: must be locked. Currently stays unlocked (bug).
      expect(result.current.authState.isLocked).toBe(true);
    }
  );
});

describe('AuthContext — unmount teardown (no leaks)', () => {
  it('clears its activity interval and session timeout on unmount', async () => {
    const rendered = await mountAuth();

    await act(async () => {
      await rendered.result.current.unlock(TEST_PIN);
    });

    // Sanity: an unlocked session has live timers (activity interval + session
    // timeout) — otherwise the cleanup assertion below would be vacuous.
    // (Absolute getTimerCount()===0 is NOT asserted: React's own scheduler
    // leaves framework timers behind on unmount that AuthContext neither owns
    // nor should clear.)
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

    await act(async () => {
      rendered.unmount();
    });

    // The mount-effect cleanup clears the activity interval and the session
    // timeout it owns — the concrete no-leak guarantee for its own handles.
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  // KNOWN BUG (reported, source intentionally NOT fixed — TASK-160 is test-only):
  // the mount useEffect calls setupAppStateListener(), which RETURNS a
  // `() => subscription.remove()` cleanup, but the effect discards that return
  // value — its own cleanup only clears timers. So AppState.addEventListener's
  // subscription is never removed on unmount and leaks. This test documents the
  // leak via it.failing; flip to a plain `it` once AuthContext wires the
  // subscription cleanup (e.g. store the remover in a ref and call it in the
  // effect teardown).
  it.failing(
    'removes the AppState subscription on unmount (LEAK: remove() never called)',
    async () => {
      const rendered = await mountAuth();

      expect(appStateRemove).not.toHaveBeenCalled();

      await act(async () => {
        rendered.unmount();
      });

      // Currently receives 0 calls — the subscription is leaked.
      expect(appStateRemove).toHaveBeenCalledTimes(1);
    }
  );

  it('does not fire a lock after unmount even once the timeout window passes', async () => {
    const rendered = await mountAuth();

    await act(async () => {
      await rendered.result.current.unlock(TEST_PIN);
    });

    await act(async () => {
      rendered.unmount();
    });

    mockEnterLocked.mockClear();

    // Advancing past the timeout must NOT trigger teardown — the timers are gone.
    await act(async () => {
      jest.advanceTimersByTime(10 * 60 * 1000);
      await Promise.resolve();
    });

    expect(mockEnterLocked).not.toHaveBeenCalled();
  });

  it('does not fire the armed background-grace lock after unmount', async () => {
    const rendered = await mountAuth();

    await act(async () => {
      await rendered.result.current.unlock(TEST_PIN);
    });

    // Background the app so the 60s grace timer is ARMED before we unmount —
    // this is the timer the mount-effect cleanup must clear (regression guard:
    // dropping the backgroundTimer cleanup would let it fire post-unmount).
    await act(async () => {
      appStateHandler!('background');
      await Promise.resolve();
    });

    await act(async () => {
      rendered.unmount();
    });

    mockEnterLocked.mockClear();

    // Grace window elapses after unmount — the cleared timer must never fire.
    await act(async () => {
      jest.advanceTimersByTime(60 * 1000 + 5000);
      await Promise.resolve();
    });

    expect(mockEnterLocked).not.toHaveBeenCalled();
  });
});
