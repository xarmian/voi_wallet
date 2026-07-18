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
    // The unlock MUST route through the biometric gate + vault-population path,
    // not just flip flags — otherwise a regression could "unlock" without ever
    // authenticating or loading the session vault.
    expect(mockBiometricUnlock).toHaveBeenCalledWith('Unlock your wallet');
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
    // Went through the biometric gate, and a cancel must NOT flip the lock
    // signal to unlocked.
    expect(mockBiometricUnlock).toHaveBeenCalledWith('Unlock your wallet');
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
    // The gate ran and the lock signal was never flipped to unlocked.
    expect(mockBiometricUnlock).toHaveBeenCalledWith('Unlock your wallet');
    expect(mockSetUnlocked).not.toHaveBeenCalledWith(true);
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

  // FIXED (TASK-165): Lock-BYPASS on a suspended app. The AppState 'change'
  // handler used to close over a STALE `authState.backgroundedAt` (null from the
  // first render); the only thing that locked after backgrounding was the 60s JS
  // setTimeout. If the OS suspended the JS runtime (common on real devices) that
  // timer never fired, and on a post-grace foreground return the handler read the
  // stale null so the `now - backgroundedAt > grace` branch was skipped and the
  // wallet stayed UNLOCKED. The handler now reads a synchronous `backgroundedAtRef`
  // written the instant we background (render-independent), so a post-grace
  // foreground return locks even when the timer never fired.
  it('locks on foreground return after the grace window when the background timer never fired (suspended app)', async () => {
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
  });

  // FIXED (TASK-165, Codex diff-review P1): iOS returns to the foreground via
  // background -> inactive -> active. The foreground decision must NOT gate on
  // `previousAppState === 'background'` — an intervening 'inactive' would make
  // the 'active' event skip the expiry check, re-opening the suspend bypass on
  // iOS. Gating on the synchronous `backgroundedAtRef` instead means any
  // 'active' with a pending background marker is evaluated.
  it('locks on an iOS background -> inactive -> active return after the grace window', async () => {
    const { result } = await mountAuth();

    await act(async () => {
      await result.current.unlock(TEST_PIN);
    });
    expect(result.current.authState.isLocked).toBe(false);

    const t0 = Date.now();

    await act(async () => {
      appStateHandler!('background');
      await Promise.resolve();
    });

    // Suspended past the grace window, then the iOS wake sequence: an 'inactive'
    // event precedes 'active'. The armed 60s timer never fired (JS was frozen).
    await act(async () => {
      jest.setSystemTime(t0 + 60 * 1000 + 5000);
      appStateHandler!('inactive');
      appStateHandler!('active');
      await Promise.resolve();
    });

    expect(result.current.authState.isLocked).toBe(true);
  });

  // FIXED (TASK-165, Codex diff-review P2): the grace window is measured from
  // the FIRST background event. A duplicate 'background' (iOS emits several)
  // must NOT reset the timestamp/timer, or an attacker/flaky OS could extend an
  // already-backgrounded unlocked session indefinitely.
  it('does not extend the grace window when a duplicate background event fires', async () => {
    const { result } = await mountAuth();

    await act(async () => {
      await result.current.unlock(TEST_PIN);
    });
    expect(result.current.authState.isLocked).toBe(false);

    const t0 = Date.now();

    // First background starts the 60s window.
    await act(async () => {
      appStateHandler!('background');
      await Promise.resolve();
    });

    // A second background at 59s must be ignored (no timestamp/timer reset).
    await act(async () => {
      jest.setSystemTime(t0 + 59 * 1000);
      appStateHandler!('background');
      await Promise.resolve();
    });

    // Foreground at 61s — past grace measured from the FIRST background. If the
    // duplicate had reset the marker, elapsed would read 2s and stay unlocked.
    await act(async () => {
      jest.setSystemTime(t0 + 61 * 1000);
      appStateHandler!('active');
      await Promise.resolve();
    });

    expect(result.current.authState.isLocked).toBe(true);
  });
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

  // FIXED (TASK-165): the mount useEffect used to call setupAppStateListener()
  // and discard its returned `() => subscription.remove()` cleanup — its own
  // cleanup only cleared timers, so the AppState subscription leaked on every
  // unmount. The effect now captures the remover and invokes it in its teardown.
  it('removes the AppState subscription on unmount (LEAK: remove() never called)', async () => {
    const rendered = await mountAuth();

    expect(appStateRemove).not.toHaveBeenCalled();

    await act(async () => {
      rendered.unmount();
    });

    // Currently receives 0 calls — the subscription is leaked.
    expect(appStateRemove).toHaveBeenCalledTimes(1);
  });

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
