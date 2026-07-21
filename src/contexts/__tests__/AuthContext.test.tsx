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
import {
  isPinSetupPending,
  clearPinSetupPending,
} from '@/services/secure/pinSetupPending';
import * as LocalAuthentication from 'expo-local-authentication';

// --- Mocks: wallet + every secure-store leaf, vault, teardown, lock signal. ---
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: jest.fn(),
    // TASK-213: the STRICT, boot-only wallet-presence probe the auth-init path
    // now uses (throws on read FAILURE, resolves false only on genuine absence).
    hasWalletWithAccountsStrict: jest.fn(),
    // TASK-213 Codex round-4: does a persisted wallet hold ≥1 locally-key-bearing
    // (STANDARD) account? Used to close the Android swallow-to-null fail-open.
    hasKeyBearingAccountStrict: jest.fn(),
  },
}));

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    hasPin: jest.fn(),
    // TASK-213: the STRICT, boot-only PIN-presence probe (see wallet mock above).
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
  },
}));

// TASK-213 restore-before-PIN breadcrumb. Separate submodule path (NOT the
// mocked @/services/secure barrel), so it needs its own mock. Defaults are set in
// beforeEach: ABSENT breadcrumb + a no-op clear, so the key-bearing guard behaves
// EXACTLY as before unless a test opts into a restore-in-progress state.
jest.mock('@/services/secure/pinSetupPending', () => ({
  isPinSetupPending: jest.fn(),
  clearPinSetupPending: jest.fn(),
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
// STRICT boot probes (TASK-213) — these are what checkInitialAuthState reads now.
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
const mockVaultSet = SessionKeyVault.set as jest.Mock;
const mockBiometricUnlock = unlockVaultWithBiometrics as jest.Mock;
const mockEnterLocked = enterLockedState as jest.Mock;
const mockIsPinSetupPending = isPinSetupPending as jest.Mock;
const mockClearPinSetupPending = clearPinSetupPending as jest.Mock;
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

// TASK-213: the strict-read retry path awaits a real setTimeout backoff between
// attempts, which never resolves under fake timers on microtask flushing alone.
// This helper interleaves microtask flushes with fake-timer advances so the
// bounded retry loop (≤3 attempts, 200ms + 400ms backoffs) can run to
// completion — used by the recovery / transient-recovery tests.
const flushWithRetries = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
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

// Like mountAuth but pumps the fake-timer backoff so a mount whose strict reads
// FAIL (and therefore retry) settles into its final state (recovery or, for a
// transient failure, the recovered lock state).
const mountAuthWithRetries = async () => {
  const rendered = renderHook(() => useAuth(), { wrapper });
  await flushWithRetries();
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
  // available + enabled. Individual tests override as needed. The STRICT boot
  // probes (TASK-213) drive the lock decision now, so their baseline resolves to
  // a wallet-with-accounts + PIN (⇒ LOCKED). getCurrentWallet/hasPin are kept
  // mocked for any incidental callers but no longer gate the initial lock state.
  mockHasWalletStrict.mockResolvedValue(true);
  mockHasPinStrict.mockResolvedValue(true);
  // Default to NO key-bearing account so the Codex round-4 guard
  // (hasKeyBearingAccount && !hasPin ⇒ recovery) never fires unless a test opts
  // in — the guard only matters for the wallet+no-PIN cases, which the existing
  // suite treats as legit watch-only/absence states.
  mockHasKeyBearing.mockResolvedValue(false);
  mockWallet.mockResolvedValue(WALLET_WITH_ACCOUNTS);
  mockHasPin.mockResolvedValue(true);
  mockIsBiometricEnabled.mockResolvedValue(true);
  mockGetPinTimeout.mockResolvedValue(5);
  mockVerifyPin.mockResolvedValue(true);
  mockGetCredentialSource.mockResolvedValue('pin');
  mockMigrate.mockResolvedValue(undefined);
  mockBiometricUnlock.mockResolvedValue({ status: 'unlocked' });
  // TASK-213: default to NO restore-in-progress breadcrumb so the key-bearing
  // guard stays fail-closed (recovery) exactly as before; opt-in per test.
  mockIsPinSetupPending.mockResolvedValue(false);
  mockClearPinSetupPending.mockResolvedValue(true);
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
    mockHasWalletStrict.mockResolvedValue(false);
    mockHasPinStrict.mockResolvedValue(false);

    const { result } = await mountAuth();

    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
    expect(result.current.authState.hasPin).toBe(false);
    expect(result.current.authState.securityUnavailable).toBe(false);
  });

  it('reports biometricEnabled=false when hardware is unavailable even if the flag is on', async () => {
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValueOnce(
      false
    );

    const { result } = await mountAuth();

    expect(result.current.authState.biometricEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TASK-213: FAIL-CLOSED recovery on a secure-storage READ FAILURE at boot.
//
// checkInitialAuthState now reads the lock-determining state through the STRICT
// probes (MultiAccountWalletService.hasWalletWithAccountsStrict +
// AccountSecureStorage.hasPinStrict), which THROW on a genuine secure-storage
// read/decrypt FAILURE and resolve falsy ONLY for genuine ABSENCE. A read
// failure is therefore no longer indistinguishable from "no wallet / no PIN":
//   - a persistent strict-read FAILURE (after bounded retry) ⇒ RECOVERY state
//     (authState.securityUnavailable === true) — NOT unlocked setup, NOT the
//     normal PIN lock, ZERO wallet access;
//   - genuine ABSENCE ⇒ unlocked setup (UNCHANGED);
//   - genuine wallet+PIN ⇒ locked (UNCHANGED);
//   - a TRANSIENT failure that succeeds on retry ⇒ proceeds to its normal state
//     and NEVER shows the recovery screen.
// This closes the pre-existing fail-OPEN documented on the former F-03 tests.
// ---------------------------------------------------------------------------
describe('AuthContext — TASK-213 fail-closed recovery on storage read failure', () => {
  it('(a) enters RECOVERY (securityUnavailable) when the strict PIN read FAILS at boot — never unlocked, never normal-locked', async () => {
    // A wallet is present and the PIN read throws (keychain unreadable). The old
    // behavior swallowed this to `hasPin=false` and slipped into unlocked setup;
    // now the strict read throws, bounded retry exhausts, and we fail CLOSED.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockRejectedValue(new Error('keychain read failed'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = await mountAuthWithRetries();

    expect(result.current.authState.securityUnavailable).toBe(true);
    // Zero wallet access: not authenticated, and NOT the unlocked setup state.
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('(b) enters RECOVERY when the strict WALLET read FAILS at boot', async () => {
    mockHasWalletStrict.mockRejectedValue(
      new Error('wallet store unavailable')
    );
    mockHasPinStrict.mockResolvedValue(true);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = await mountAuthWithRetries();

    expect(result.current.authState.securityUnavailable).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);

    errorSpy.mockRestore();
  });

  it('(c) genuine ABSENCE (no wallet / no PIN) ⇒ unlocked setup, NOT recovery (unchanged)', async () => {
    mockHasWalletStrict.mockResolvedValue(false);
    mockHasPinStrict.mockResolvedValue(false);

    const { result } = await mountAuth();

    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
  });

  it('(c2) genuine wallet present but no PIN ⇒ unlocked setup, NOT recovery', async () => {
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(false);

    const { result } = await mountAuth();

    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
    expect(result.current.authState.hasPin).toBe(false);
    // Route derives from hasWallet — a wallet exists here ⇒ Main (not Onboarding).
    expect(result.current.authState.hasWallet).toBe(true);
    expect(result.current.authState.authChecked).toBe(true);
  });

  it('(d) genuine wallet+PIN ⇒ locked, NOT recovery (unchanged)', async () => {
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true);

    const { result } = await mountAuth();

    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.hasPin).toBe(true);
    expect(result.current.authState.hasWallet).toBe(true);
    expect(result.current.authState.authChecked).toBe(true);
  });

  it('(e) a TRANSIENT strict-read failure that SUCCEEDS on retry proceeds normally (LOCKED) — no recovery screen', async () => {
    // First attempt: the PIN read throws; the retry then succeeds. The app must
    // recover to its true state (wallet+PIN ⇒ LOCKED) and NEVER show recovery.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict
      .mockRejectedValueOnce(new Error('transient keychain unavailability'))
      .mockResolvedValue(true);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = await mountAuthWithRetries();

    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    // Retry actually happened (more than one strict-read attempt).
    expect(mockHasPinStrict.mock.calls.length).toBeGreaterThan(1);
    // A transient, recovered failure logs nothing at error level.
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('(e2) a TRANSIENT failure that recovers into genuine ABSENCE ⇒ unlocked setup, no recovery', async () => {
    mockHasWalletStrict
      .mockRejectedValueOnce(new Error('transient wallet-store hiccup'))
      .mockResolvedValue(false);
    mockHasPinStrict.mockResolvedValue(false);

    const { result } = await mountAuthWithRetries();

    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
  });

  it('(f) recovery Retry (recheckAuthState) re-runs the check and RECOVERS when storage becomes readable', async () => {
    // Boot into recovery via a persistent failure.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockRejectedValue(new Error('keychain unreadable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = await mountAuthWithRetries();
    expect(result.current.authState.securityUnavailable).toBe(true);

    // Storage becomes readable; the Retry button calls recheckAuthState.
    mockHasPinStrict.mockReset();
    mockHasPinStrict.mockResolvedValue(true);

    await act(async () => {
      await result.current.recheckAuthState();
    });
    await flushWithRetries();

    // Recovered: no longer securityUnavailable, and now correctly LOCKED
    // (wallet+PIN). The recovery state is never permanently stuck.
    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    // Codex round-2 guard: after recovery the AUTHORITATIVE hasWallet is correct
    // (true ⇒ the navigator derives route=Main, never a stale unguarded
    // Onboarding). The route is a single source of truth = this verdict.
    expect(result.current.authState.hasWallet).toBe(true);

    errorSpy.mockRestore();
  });

  it('(g) a HUNG strict read (never settles) TIMES OUT, retries, and fails CLOSED to recovery — never stuck behind the splash', async () => {
    // No-stuck regression (TASK-213 Codex round-4 P2): a strict read that never
    // resolves NOR rejects. Without a per-read timeout, checkInitialAuthState
    // would never reach a terminal setAuthState — authChecked stays false, the
    // navigator renders null under the splash forever, and the 10s watchdog only
    // hides the splash onto a BLANK screen. The timeout converts the hang into a
    // rejection the retry loop already handles, so boot fails CLOSED to recovery.
    mockHasWalletStrict.mockResolvedValue(true);
    // A promise that never settles, returned on every attempt.
    const neverSettles = new Promise<boolean>(() => {});
    mockHasPinStrict.mockReturnValue(neverSettles);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const rendered = renderHook(() => useAuth(), { wrapper });
    // Pump fake timers well past 3 attempts × (2000ms per-read timeout + backoff)
    // ≈ 6.6s worst case.
    await act(async () => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
      }
    });

    // Settled into recovery (NOT left indeterminate behind the splash).
    expect(rendered.result.current.authState.authChecked).toBe(true);
    expect(rendered.result.current.authState.securityUnavailable).toBe(true);
    expect(rendered.result.current.authState.isAuthenticated).toBe(false);
    expect(rendered.result.current.authState.isLocked).toBe(true);
    // Retried (the hang was surfaced as a failure on each attempt).
    expect(mockHasPinStrict.mock.calls.length).toBeGreaterThan(1);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('(h) a HUNG non-critical read (biometric/timeout) does NOT stall boot — falls back to defaults and still computes the lock verdict', async () => {
    // The non-critical biometric/isBiometricEnabled/getPinTimeout reads are on the
    // render-gating path now; a hang there must not strand boot. It times out to
    // the safe display defaults and the strict lock verdict still resolves.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true);
    mockGetPinTimeout.mockReturnValue(new Promise<number>(() => {})); // hangs
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const rendered = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
      }
    });

    // Boot still reached a verdict (LOCKED wallet+PIN), NOT recovery, with the
    // default 5-min timeout after the non-critical read timed out.
    expect(rendered.result.current.authState.authChecked).toBe(true);
    expect(rendered.result.current.authState.securityUnavailable).toBe(false);
    expect(rendered.result.current.authState.isLocked).toBe(true);
    expect(rendered.result.current.authState.timeoutMinutes).toBe(5);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('(i) Android swallow-to-null closure: a KEY-BEARING account + absent PIN ⇒ RECOVERY, never unlocked setup', async () => {
    // Codex round-4 P1: a pre-sentinel Android install whose keystore breaks on
    // its first post-upgrade boot has no presence sentinel, so hasPinStrict reads
    // the swallowed-to-null PIN as genuine ABSENCE (false). But a locally-key-
    // bearing (STANDARD) account CANNOT exist without a PIN, so this state is
    // impossible-genuine and must be a read failure ⇒ fail CLOSED to recovery
    // (NOT the unlocked setup branch that would offer to set a NEW PIN).
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(false); // swallowed-to-null on Android
    mockHasKeyBearing.mockResolvedValue(true); // durable, keystore-independent
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = await mountAuth();

    expect(result.current.authState.securityUnavailable).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('(i2) a PIN-less wallet with NO key-bearing account (watch-only) ⇒ unlocked setup, NOT recovery', async () => {
    // The guard must NOT over-fire: a genuinely PIN-less watch-only wallet is a
    // legitimate boot state and must still reach the setup branch.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(false);
    mockHasKeyBearing.mockResolvedValue(false);

    const { result } = await mountAuth();

    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
    expect(result.current.authState.hasPin).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TASK-213 restore-before-PIN: the pin_setup_pending breadcrumb disambiguates
  // "key-bearing account + no readable PIN" between a genuine keystore break
  // (fail CLOSED to recovery) and a restore that persisted STANDARD accounts
  // before the PIN (route to SecuritySetup RESUME). The breadcrumb must NEVER
  // reopen the Android fail-open: a real, readable PIN self-heals any stale
  // breadcrumb, and an absent breadcrumb still routes a genuine break to recovery.
  // -------------------------------------------------------------------------
  it('(j) restore-before-PIN: key-bearing + no PIN + breadcrumb SET ⇒ resume SecuritySetup, NOT recovery/unlocked', async () => {
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(false); // no PIN yet (restore not finished)
    mockHasKeyBearing.mockResolvedValue(true); // restore persisted STANDARD accounts
    mockIsPinSetupPending.mockResolvedValue(true); // durable breadcrumb present

    const { result } = await mountAuth();

    // Routes to SecuritySetup resume — never the recovery screen (whose Reset
    // would wipe the just-restored wallet).
    expect(result.current.authState.pinSetupResume).toBe(true);
    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.authChecked).toBe(true);
    // AND still grants ZERO wallet access before the PIN is set (defense in depth:
    // the navigator routes to SecuritySetup, and Main stays lock-guarded).
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.hasWallet).toBe(true);
    expect(result.current.authState.hasPin).toBe(false);
  });

  it('(j2) genuine keystore break: key-bearing + no PIN + NO breadcrumb ⇒ RECOVERY (fail-closed, unchanged)', async () => {
    // The exact Android swallow-to-null scenario, breadcrumb ABSENT (default). Must
    // stay fail-closed — the breadcrumb fix must not weaken this.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(false);
    mockHasKeyBearing.mockResolvedValue(true);
    mockIsPinSetupPending.mockResolvedValue(false);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = await mountAuth();

    expect(result.current.authState.securityUnavailable).toBe(true);
    expect(result.current.authState.pinSetupResume).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(false);

    errorSpy.mockRestore();
  });

  it('(k) anti-fail-open: a STALE breadcrumb + key-bearing wallet WITH a readable PIN ⇒ LOCKED (not resume), breadcrumb self-healed', async () => {
    // The dangerous case: a PIN was set (setupPin should have cleared it) but a
    // stale breadcrumb lingers. A readable PIN means the guard does NOT fire and
    // the self-heal clears the stale breadcrumb — so a LATER keystore break can
    // never later route to SecuritySetup over this protected wallet.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true); // PIN is readable
    mockHasKeyBearing.mockResolvedValue(true);
    mockIsPinSetupPending.mockResolvedValue(true); // stale breadcrumb

    const { result } = await mountAuth();

    // Normal locked boot — NOT resume, NOT recovery.
    expect(result.current.authState.pinSetupResume).toBe(false);
    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.hasPin).toBe(true);
    // Self-heal fired: the stale breadcrumb was cleared on this readable-PIN boot.
    expect(mockClearPinSetupPending).toHaveBeenCalled();
  });

  it('(k2) self-heal on a normal wallet+PIN boot: a stale breadcrumb is cleared even without a key-bearing account', async () => {
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true);
    mockHasKeyBearing.mockResolvedValue(false);
    mockIsPinSetupPending.mockResolvedValue(true);

    const { result } = await mountAuth();

    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.pinSetupResume).toBe(false);
    expect(mockClearPinSetupPending).toHaveBeenCalled();
  });

  it('(l) breadcrumb does NOT perturb genuine absence: no wallet + breadcrumb SET ⇒ unlocked setup, not resume', async () => {
    // The guard requires a key-bearing account; a breadcrumb alone must never
    // force the resume/recovery path on a genuinely empty install.
    mockHasWalletStrict.mockResolvedValue(false);
    mockHasPinStrict.mockResolvedValue(false);
    mockHasKeyBearing.mockResolvedValue(false);
    mockIsPinSetupPending.mockResolvedValue(true);

    const { result } = await mountAuth();

    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.pinSetupResume).toBe(false);
    expect(result.current.authState.isLocked).toBe(false);
    expect(result.current.authState.isAuthenticated).toBe(true);
  });

  it('(m) a HUNG breadcrumb read does NOT stall boot — times out and fails CLOSED to recovery', async () => {
    // No-stuck (Codex round-5 finding 2): isPinSetupPending is on the boot path in
    // the key-bearing guard. A read that never settles must NOT leave boot awaiting
    // forever (authChecked false behind the splash). withTimeout converts the hang
    // into `false` ⇒ the guard falls through to RECOVERY (fail-closed), never a
    // wrongful resume and never a stall.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(false);
    mockHasKeyBearing.mockResolvedValue(true);
    mockIsPinSetupPending.mockReturnValue(new Promise<boolean>(() => {})); // hangs
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const rendered = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
      }
    });

    expect(rendered.result.current.authState.authChecked).toBe(true);
    expect(rendered.result.current.authState.securityUnavailable).toBe(true);
    expect(rendered.result.current.authState.pinSetupResume).toBe(false);
    expect(rendered.result.current.authState.isAuthenticated).toBe(false);

    errorSpy.mockRestore();
  });

  it('(n) a HUNG self-heal clear does NOT stall boot — the verdict still settles (LOCKED)', async () => {
    // The readable-PIN self-heal clear is AWAITED (durable) but bounded, so a
    // wedged removeItem cannot strand boot. It times out and the lock verdict
    // still resolves.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true);
    mockHasKeyBearing.mockResolvedValue(false);
    mockIsPinSetupPending.mockResolvedValue(true);
    mockClearPinSetupPending.mockReturnValue(new Promise<void>(() => {})); // hangs

    const rendered = renderHook(() => useAuth(), { wrapper });
    await act(async () => {
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve();
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
      }
    });

    expect(rendered.result.current.authState.authChecked).toBe(true);
    expect(rendered.result.current.authState.isLocked).toBe(true);
    expect(rendered.result.current.authState.securityUnavailable).toBe(false);
  });

  it('never RETRIES a genuine absence — a false-resolving strict read reads exactly once', async () => {
    // Absence must NOT be retried (only failures are). One attempt, no backoff.
    mockHasWalletStrict.mockResolvedValue(false);
    mockHasPinStrict.mockResolvedValue(false);

    await mountAuth();

    expect(mockHasWalletStrict).toHaveBeenCalledTimes(1);
    expect(mockHasPinStrict).toHaveBeenCalledTimes(1);
  });

  it('computes LOCKED for a passphrase-protected wallet launch (timeout=never)', async () => {
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true);
    mockGetPinTimeout.mockResolvedValue('never');

    const { result } = await mountAuth();

    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.hasPin).toBe(true);
    expect(result.current.authState.timeoutMinutes).toBe('never');
    expect(result.current.authState.securityUnavailable).toBe(false);
  });

  it('stays LOCKED (not recovery) when a NON-critical read (pin-timeout) fails for a wallet+PIN', async () => {
    // getPinTimeout is display/config only: its failure must fall back to the
    // 5-min default and NOT drive the lock/recovery decision.
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true);
    mockGetPinTimeout.mockRejectedValue(new Error('timeout read failed'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = await mountAuth();

    expect(result.current.authState.securityUnavailable).toBe(false);
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.timeoutMinutes).toBe(5);

    warnSpy.mockRestore();
  });

  it('computes LOCKED on a biometric-invalidated launch (enrollment gone) — never unlocks, biometrics disabled', async () => {
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true);
    mockIsBiometricEnabled.mockResolvedValue(true);
    (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValueOnce(
      false
    );

    const { result } = await mountAuth();

    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.biometricEnabled).toBe(false);
    expect(result.current.authState.securityUnavailable).toBe(false);
  });

  it('computes LOCKED even when the biometric availability probe THROWS (wallet+PIN)', async () => {
    mockHasWalletStrict.mockResolvedValue(true);
    mockHasPinStrict.mockResolvedValue(true);
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockRejectedValueOnce(
      new Error('native biometric probe failed')
    );
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = await mountAuth();

    // The biometric probe throw is swallowed to "unavailable"; it does NOT
    // trigger recovery (only the strict lock-determining reads can).
    expect(result.current.authState.isLocked).toBe(true);
    expect(result.current.authState.isAuthenticated).toBe(false);
    expect(result.current.authState.biometricEnabled).toBe(false);
    expect(result.current.authState.securityUnavailable).toBe(false);

    warnSpy.mockRestore();
  });

  // Parity table: the strict probe chain computes the SAME locked/unlocked
  // decision as `!hasWallet || !hasPin` ⇒ unlocked setup, and never recovery.
  const parityCases: {
    name: string;
    hasWallet: boolean;
    hasPin: boolean;
    expectedLocked: boolean;
  }[] = [
    {
      name: 'wallet + PIN',
      hasWallet: true,
      hasPin: true,
      expectedLocked: true,
    },
    {
      name: 'wallet + no PIN',
      hasWallet: true,
      hasPin: false,
      expectedLocked: false,
    },
    {
      name: 'no wallet + PIN',
      hasWallet: false,
      hasPin: true,
      expectedLocked: false,
    },
    {
      name: 'no wallet + no PIN',
      hasWallet: false,
      hasPin: false,
      expectedLocked: false,
    },
  ];

  it.each(parityCases)(
    'parity: $name ⇒ locked=$expectedLocked, recovery=false',
    async ({ hasWallet, hasPin, expectedLocked }) => {
      mockHasWalletStrict.mockResolvedValue(hasWallet);
      mockHasPinStrict.mockResolvedValue(hasPin);

      const { result } = await mountAuth();

      const unlockedSetup = !hasWallet || !hasPin;
      expect(unlockedSetup).toBe(!expectedLocked);

      expect(result.current.authState.isLocked).toBe(expectedLocked);
      expect(result.current.authState.isAuthenticated).toBe(!expectedLocked);
      expect(result.current.authState.securityUnavailable).toBe(false);
    }
  );
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
