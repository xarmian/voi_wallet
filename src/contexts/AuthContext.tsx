import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
} from 'react';
import { AppState, Platform, AppStateStatus } from 'react-native';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import type { SecretSource } from '@/services/secure/SessionKeyVault';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';
import { enterLockedState } from '@/services/secure/sessionTeardown';
import { AppLockSignal } from '@/services/secure/appLockState';
import { SecurityUtils } from '@/utils/security';
import { DeepLinkService } from '@/services/deeplink';

// Helper to check if biometrics are available (web-safe)
const checkBiometricAvailability = async (): Promise<{
  hasHardware: boolean;
  isEnrolled: boolean;
}> => {
  if (Platform.OS === 'web') {
    // Biometrics not available on web
    return { hasHardware: false, isEnrolled: false };
  }
  try {
    const LocalAuthentication = require('expo-local-authentication');
    // hasHardwareAsync and isEnrolledAsync are independent native reads — run
    // them concurrently (F-03) instead of serially. A rejection in either still
    // rejects the Promise.all and is caught below (→ unavailable), unchanged.
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return { hasHardware, isEnrolled };
  } catch {
    return { hasHardware: false, isEnrolled: false };
  }
};

export interface AuthState {
  isLocked: boolean;
  isAuthenticated: boolean;
  sessionId: string | null;
  lastActivity: number;
  biometricEnabled: boolean;
  backgroundedAt: number | null;
  timeoutMinutes: number | 'never';
  hasPin: boolean;
  // Fail-closed recovery flag (TASK-213). True ONLY when the strict, lock-
  // determining secure-storage reads at boot STILL fail after bounded retry —
  // i.e. secure storage is genuinely unreadable. When true the app shows the
  // "secure storage unavailable" recovery screen (Retry re-runs the check) and
  // grants ZERO wallet access: it is neither the unlocked setup state nor the
  // normal PIN-lock. It is never set for genuine absence or a readable wallet.
  securityUnavailable: boolean;
}

export interface AuthContextType {
  authState: AuthState;
  unlock: (secret: string) => Promise<boolean>;
  unlockWithBiometrics: () => Promise<boolean>;
  lock: () => void;
  updateActivity: () => void;
  setupPin: (secret: string, source?: SecretSource) => Promise<void>;
  enableBiometrics: (enabled: boolean, secret?: string) => Promise<void>;
  recheckAuthState: () => Promise<void>;
  updateTimeoutSetting: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const DEFAULT_SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes default
const ACTIVITY_CHECK_INTERVAL = 30 * 1000; // 30 seconds
const BACKGROUND_GRACE_PERIOD = 60 * 1000; // 60 seconds

// TASK-213: bounded retry for the STRICT, lock-determining secure-storage reads
// at boot. A transient keychain/keystore unavailability (common at cold boot) is
// retried a few times with a short linear backoff before the app fails CLOSED to
// the recovery state — so a transient hiccup recovers silently and never strands
// a legitimate user, while a persistent failure never falls open to setup state.
const STRICT_READ_MAX_ATTEMPTS = 3;
const STRICT_READ_BACKOFF_MS = 200;

// Web-safe delay. Used only for the bounded strict-read backoff above.
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>({
    isLocked: true,
    isAuthenticated: false,
    sessionId: null,
    lastActivity: Date.now(),
    biometricEnabled: false,
    backgroundedAt: null,
    timeoutMinutes: 5,
    hasPin: false,
    securityUnavailable: false,
  });

  const activityTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const sessionTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const backgroundTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  // Synchronous, render-independent record of WHEN the app was backgrounded.
  // The AppState handler must decide lock-vs-unlock on foreground from a value
  // written the instant we background — NOT from React state, whose commit can
  // be skipped entirely if the OS suspends the JS runtime before the render
  // lands (that stale-null read was the lock-BYPASS this ref closes). authState
  // .backgroundedAt is kept in sync for any external observer, but THIS ref is
  // the source of truth for the grace-window decision.
  const backgroundedAtRef = useRef<number | null>(null);

  // Always-fresh mirror of authState so the inactivity interval can read the
  // latest activity/auth flags and route through the single lock() (below)
  // rather than mutating state inline (needed so lock's session teardown runs).
  const authStateRef = useRef(authState);
  authStateRef.current = authState;

  useEffect(() => {
    checkInitialAuthState();
    // Capture the subscription remover so the effect cleanup can tear the
    // AppState listener down — otherwise it leaks across every mount. The
    // remover is callable on both native (subscription.remove()) and web
    // (no-op) paths.
    const removeAppStateListener = setupAppStateListener();

    return () => {
      if (activityTimer.current) clearInterval(activityTimer.current);
      if (sessionTimer.current) clearTimeout(sessionTimer.current);
      if (backgroundTimer.current) clearTimeout(backgroundTimer.current);
      removeAppStateListener();
    };
  }, []);

  // Sync auth state to DeepLinkService for pending notification handling, and to
  // the AppLockSignal so non-React services (the messaging poll) can defer while
  // locked (DOC-137 §6.5 / Codex P1-E).
  useEffect(() => {
    const isUnlocked = authState.isAuthenticated && !authState.isLocked;
    console.log(
      `[AuthContext] Syncing unlock state: isAuthenticated=${authState.isAuthenticated}, isLocked=${authState.isLocked}, isUnlocked=${isUnlocked}`
    );
    DeepLinkService.getInstance().setUnlockState(isUnlocked);
    AppLockSignal.setUnlocked(isUnlocked);
  }, [authState.isAuthenticated, authState.isLocked]);

  useEffect(() => {
    // Update activity monitoring when timeout setting changes
    if (activityTimer.current) {
      clearInterval(activityTimer.current);
    }

    // Don't set up timeout monitoring if timeout is set to 'never'
    if (authState.timeoutMinutes === 'never') {
      return;
    }

    const timeoutMs = authState.timeoutMinutes * 60 * 1000;

    activityTimer.current = setInterval(() => {
      // Read the latest state from the ref (the interval closure is stale) and
      // route inactivity locking through the single lock() so its session
      // teardown (vault + 60 s cache + messaging cache) always runs.
      const currentState = authStateRef.current;

      // Don't lock if no PIN is set - user won't be able to unlock
      if (!currentState.hasPin || !currentState.isAuthenticated) {
        return;
      }

      const timeSinceLastActivity = Date.now() - currentState.lastActivity;
      if (timeSinceLastActivity > timeoutMs) {
        lock();
      }
    }, ACTIVITY_CHECK_INTERVAL);

    return () => {
      if (activityTimer.current) {
        clearInterval(activityTimer.current);
      }
    };
  }, [authState.timeoutMinutes]);

  const checkInitialAuthState = async () => {
    try {
      // ── Non-lock-determining reads (display/config only) ───────────────────
      // Biometric availability, the biometric-enabled flag, and the PIN timeout
      // do NOT gate wallet access, so a failure here falls back to safe display
      // defaults (no biometrics, 5-min timeout) and NEVER drives the lock
      // decision. Only the STRICT reads below decide locked/unlocked/recovery.
      let biometricEnabled = false;
      let biometricAvailable = false;
      let timeoutMinutes: number | 'never' = 5;
      try {
        const [biometric, isBiometricEnabled, pinTimeout] = await Promise.all([
          checkBiometricAvailability(),
          AccountSecureStorage.isBiometricEnabled(),
          AccountSecureStorage.getPinTimeout(),
        ]);
        biometricAvailable = biometric.hasHardware && biometric.isEnrolled;
        biometricEnabled = isBiometricEnabled;
        timeoutMinutes = pinTimeout;
      } catch (error) {
        // Non-security-critical — this must NOT affect the fail-closed lock
        // decision, so keep the safe display defaults and continue.
        console.warn(
          'Non-critical auth-init reads failed; using display defaults',
          error
        );
      }

      // ── Lock-determining reads (STRICT, bounded retry, fail-closed) ─────────
      // TASK-213: the STRICT variants THROW on a genuine secure-storage read/
      // decrypt FAILURE and resolve falsy ONLY for genuine ABSENCE. That is what
      // lets boot fail CLOSED: a read failure can no longer masquerade as "no
      // wallet / no PIN" and slip into the unlocked setup state (the fail-OPEN
      // this closes). The prior code used the error-SWALLOWING getCurrentWallet()
      // / hasPin(), which resolved falsy on failure and dropped straight into the
      // `!hasPin` unlocked branch.
      //
      // Promise.all (NOT allSettled): a throw in EITHER strict read rejects the
      // pair so the loop can RETRY it. A retry happens ONLY on a read FAILURE —
      // a genuine ABSENCE resolves `false` and is never retried. The short
      // backoff tolerates transient cold-boot keychain/keystore unavailability.
      let lockState: { hasWallet: boolean; hasPin: boolean } | null = null;
      let lastError: unknown;
      for (let attempt = 1; attempt <= STRICT_READ_MAX_ATTEMPTS; attempt += 1) {
        try {
          const [hasWallet, hasPin] = await Promise.all([
            MultiAccountWalletService.hasWalletWithAccountsStrict(),
            AccountSecureStorage.hasPinStrict(),
          ]);
          lockState = { hasWallet, hasPin };
          break;
        } catch (error) {
          lastError = error;
          // Back off briefly, then retry. No delay after the final attempt.
          if (attempt < STRICT_READ_MAX_ATTEMPTS) {
            await delay(STRICT_READ_BACKOFF_MS * attempt);
          }
        }
      }

      if (!lockState) {
        // FAIL CLOSED (TASK-213): the strict lock-determining reads STILL failed
        // after retry, so secure storage is genuinely unreadable. Do NOT grant
        // setup access and do NOT show the normal PIN lock (which cannot recover
        // a broken store). Enter the recovery state — zero wallet access; its
        // Retry re-runs this check and recovers if storage becomes readable.
        console.error(
          'Secure storage unavailable at auth init after retries:',
          lastError
        );
        setAuthState((prev) => ({
          ...prev,
          isLocked: true,
          isAuthenticated: false,
          securityUnavailable: true,
          biometricEnabled: false,
          backgroundedAt: null,
        }));
        return;
      }

      const { hasWallet, hasPin } = lockState;

      if (!hasWallet || !hasPin) {
        // Genuine ABSENCE of a wallet or PIN — allow access for setup (UNCHANGED
        // behavior). securityUnavailable is cleared: a transient failure that
        // recovered on retry lands here and never shows the recovery screen.
        setAuthState((prev) => ({
          ...prev,
          isLocked: false,
          isAuthenticated: true,
          securityUnavailable: false,
          biometricEnabled: biometricEnabled && biometricAvailable,
          backgroundedAt: null,
          timeoutMinutes,
          hasPin,
        }));
        return;
      }

      // Wallet exists and has a PIN — require authentication (UNCHANGED).
      setAuthState((prev) => ({
        ...prev,
        isLocked: true,
        isAuthenticated: false,
        securityUnavailable: false,
        biometricEnabled: biometricEnabled && biometricAvailable,
        backgroundedAt: null,
        timeoutMinutes,
        hasPin,
      }));
    } catch (error) {
      // Defensive: any UNEXPECTED failure in the auth-init path fails CLOSED to
      // the recovery state rather than leaving the app indeterminate (possibly
      // unlocked). Retry re-runs this check.
      console.error(
        'Unexpected failure during auth init; failing closed:',
        error
      );
      setAuthState((prev) => ({
        ...prev,
        isLocked: true,
        isAuthenticated: false,
        securityUnavailable: true,
        biometricEnabled: false,
        backgroundedAt: null,
      }));
    }
  };

  const setupAppStateListener = () => {
    // Skip AppState listener on web - it doesn't work correctly and can cause
    // unexpected lock behavior when switching tabs
    if (Platform.OS === 'web') {
      return () => {};
    }

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      const now = Date.now();

      if (nextAppState === 'background') {
        // Ignore duplicate background events while a background is already
        // pending: iOS can emit several, and resetting the timestamp/timer on a
        // later one would extend an already-backgrounded session past the grace
        // window (e.g. a second 'background' at 59s → ~119s of unlocked grace).
        // The FIRST background starts the window; subsequent ones are no-ops.
        if (backgroundedAtRef.current !== null) {
          return;
        }

        // App is going to background - start grace period timer.
        // Record the background timestamp SYNCHRONOUSLY in the ref (before the
        // async setAuthState) so a foreground return can compute the true
        // elapsed time even if the OS suspends JS before React commits.
        backgroundedAtRef.current = now;
        setAuthState((prev) => ({
          ...prev,
          backgroundedAt: now,
        }));

        // Clear any existing background timer
        if (backgroundTimer.current) {
          clearTimeout(backgroundTimer.current);
        }

        // Set timer to lock after grace period
        backgroundTimer.current = setTimeout(() => {
          lock();
        }, BACKGROUND_GRACE_PERIOD);
      } else if (
        nextAppState === 'active' &&
        backgroundedAtRef.current !== null
      ) {
        // Returning to foreground after a background. Gate on the ref being set
        // (NOT previousAppState === 'background'): iOS returns via
        // background -> inactive -> active, and an intervening 'inactive' would
        // otherwise make the subsequent 'active' skip the expiry check entirely
        // — re-opening the suspend bypass and leaving the ref/timer dangling.
        // Read the synchronous ref (not the closed-over React state, stale for a
        // listener created once at mount) so a return AFTER the grace window
        // locks even when the 60s JS timer never fired because JS was suspended.
        const backgroundedAt = backgroundedAtRef.current;

        // Clear the background timer
        if (backgroundTimer.current) {
          clearTimeout(backgroundTimer.current);
          backgroundTimer.current = undefined;
        }

        // Check if grace period has expired
        if (now - backgroundedAt > BACKGROUND_GRACE_PERIOD) {
          // Grace period expired - lock the app (lock() clears the ref)
          lock();
        } else {
          // Within grace period - update activity and keep unlocked
          backgroundedAtRef.current = null;
          setAuthState((prev) => ({
            ...prev,
            backgroundedAt: null,
            lastActivity: now,
          }));
        }
      }
    };

    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange
    );
    return () => subscription?.remove();
  };

  const updateActivity = () => {
    const now = Date.now();
    setAuthState((prev) => ({
      ...prev,
      lastActivity: now,
    }));

    // Clear existing session timer
    if (sessionTimer.current) {
      clearTimeout(sessionTimer.current);
    }

    // Don't set a new timer if timeout is 'never'
    if (authState.timeoutMinutes === 'never') {
      return;
    }

    const timeoutMs = authState.timeoutMinutes * 60 * 1000;

    sessionTimer.current = setTimeout(() => {
      lock();
    }, timeoutMs);
  };

  const unlock = async (secret: string): Promise<boolean> => {
    try {
      // PR7: accept a PIN or a passphrase — verifyPin validates the format
      // against the STORED credential kind, so no 6-digit gate here (that would
      // reject a passphrase). An empty secret can never be valid.
      if (!secret) {
        return false;
      }

      const isValid = await AccountSecureStorage.verifyPin(secret);

      if (isValid) {
        // Populate the session vault with the verified secret AND its kind
        // (DOC-137 §6.3), read from the stored credential so a passphrase session
        // is tagged 'passphrase'. The vault is load-bearing for v2 reads.
        const source =
          (await AccountSecureStorage.getCredentialSource()) ?? 'pin';
        SessionKeyVault.set(secret, source);
        // Flip the lock signal to UNLOCKED synchronously (mirrors lock()) so the
        // messaging poll/cache-write guard resumes immediately, not only after
        // the React effect below runs.
        AppLockSignal.setUnlocked(true);

        const sessionId = SecurityUtils.generateSessionId();
        setAuthState((prev) => ({
          ...prev,
          isLocked: false,
          isAuthenticated: true,
          sessionId,
          lastActivity: Date.now(),
        }));
        updateActivity();
        // Fire-and-forget post-unlock migration sweep (DOC-137 §4.5 trigger 2,
        // PR5): upgrade idle device-key (Format A) accounts to the user-secret
        // v2 wrap under the just-verified secret. Sequential + vault-fresh per
        // account; NEVER blocks the unlock, all failures swallowed internally.
        void AccountSecureStorage.migrateAllAccountsToV2();
        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to unlock with PIN:', error);
      return false;
    }
  };

  const unlockWithBiometrics = async (): Promise<boolean> => {
    try {
      if (!authState.biometricEnabled) {
        return false;
      }

      // Read the biometric-convenience secret behind the OS biometric gate and,
      // on success, populate the SessionKeyVault (DOC-137 §3.3, PR6). The single
      // getItemWithAuth inside is BOTH the biometric prompt AND the
      // vault-populating read — no separate LocalAuthentication prompt (that
      // would double-prompt). This is THE fix that makes a biometric-unlocked
      // session hold the vault secret, so future v2 keys read under pin=undefined
      // (prerequisite for PR4).
      const outcome = await unlockVaultWithBiometrics('Unlock your wallet');

      if (outcome.status === 'unlocked') {
        // Flip the lock signal to UNLOCKED synchronously (mirrors the PIN path
        // and lock()) so the messaging poll/cache-write guard resumes at once.
        AppLockSignal.setUnlocked(true);

        const sessionId = SecurityUtils.generateSessionId();
        setAuthState((prev) => ({
          ...prev,
          isLocked: false,
          isAuthenticated: true,
          sessionId,
          lastActivity: Date.now(),
        }));
        updateActivity();
        // Fire-and-forget post-unlock migration sweep (DOC-137 §4.5 trigger 2,
        // PR5): the vault was just populated from the biometric-convenience
        // secret, so idle Format-A accounts can be upgraded to v2 under it. NEVER
        // blocks the unlock; failures swallowed internally.
        void AccountSecureStorage.migrateAllAccountsToV2();
        return true;
      }

      if (outcome.status === 'invalidated') {
        // THE INVARIANT (DOC-137 §3.4): a biometric / enrollment-change
        // invalidation NEVER requires the mnemonic. The convenience item is gone
        // and its enabled flag has already been cleared in storage; reflect that
        // in React state so the LockScreen stops prompting biometrics and the
        // user falls back to PIN/passphrase entry — never the mnemonic.
        setAuthState((prev) => ({ ...prev, biometricEnabled: false }));
      }

      // 'cancelled' (user cancelled / OS auth failed) or 'invalidated': not
      // unlocked. Biometrics stays enabled on a cancel so the user can retry.
      return false;
    } catch (error) {
      console.error('Failed to unlock with biometrics:', error);
      return false;
    }
  };

  const lock = () => {
    // A no-PIN wallet cannot lock (the user could not unlock again), so it is
    // left untouched — including its always-unlocked AppLockSignal.
    if (authStateRef.current.hasPin) {
      // FIRST action, synchronous, before the React state update: flip the lock
      // signal to LOCKED and run the SINGLE session-security teardown for EVERY
      // lock path (explicit, inactivity-timeout, background-grace all route
      // here) — session vault (epoch bump, Codex P1-D), the legacy 60 s cache,
      // and the ~30 min messaging cache (Codex P1-E). Doing this synchronously
      // (not via the effect below) closes the post-lock re-cache race: an
      // in-flight key derivation resolving during teardown sees the locked
      // signal and refuses to repopulate the messaging cache.
      enterLockedState();
    }

    setAuthState((prev) => {
      // Don't lock if user hasn't set up a PIN - they won't be able to unlock
      if (!prev.hasPin) {
        return prev;
      }

      return {
        ...prev,
        isLocked: true,
        isAuthenticated: false,
        sessionId: null,
        backgroundedAt: null,
      };
    });

    if (sessionTimer.current) {
      clearTimeout(sessionTimer.current);
    }

    if (backgroundTimer.current) {
      clearTimeout(backgroundTimer.current);
      backgroundTimer.current = undefined;
    }

    // Keep the synchronous background marker in lockstep with the state reset
    // above so a subsequent foreground return can't re-read a stale timestamp.
    backgroundedAtRef.current = null;
  };

  const setupPin = async (
    secret: string,
    source: SecretSource = 'pin'
  ): Promise<void> => {
    // PR7: format is validated per-kind inside AccountSecureStorage.setupPin
    // (validateSecret): PIN = 6 digits, passphrase = min length. Empty is never
    // valid.
    if (!secret) {
      throw new Error('A PIN or passphrase is required');
    }

    // Use the atomic first-secret setup flow (DOC-137 §5.4), NOT a bare hash
    // persist: it re-wraps any pre-existing device-key accounts under the new
    // secret (verify-before-delete) so first-time setup can never strand keys.
    await AccountSecureStorage.setupPin(secret, source);
    setAuthState((prev) => ({
      ...prev,
      hasPin: true,
    }));
  };

  const enableBiometrics = async (
    enabled: boolean,
    secret?: string
  ): Promise<void> => {
    if (enabled) {
      const { hasHardware, isEnrolled } = await checkBiometricAvailability();

      if (!hasHardware || !isEnrolled) {
        throw new Error(
          'Biometric authentication not available or not enrolled'
        );
      }

      // Enable flow (DOC-137 §3.3): capture the user secret behind the write-time
      // auth gate, then set the enabled flag. Biometrics NEVER captures a secret
      // it was not explicitly given: use an explicitly-supplied secret (verified
      // here) or the secret the user already entered to unlock THIS session (the
      // SessionKeyVault, populated + verified at unlock). A key-bearing wallet
      // with no available secret refuses rather than storing nothing.
      const hasPin = await AccountSecureStorage.hasPin();
      if (hasPin) {
        let secretToStore = secret;
        let source: SecretSource = 'pin';

        if (secretToStore != null) {
          const ok = await AccountSecureStorage.verifyPin(secretToStore);
          if (!ok) {
            throw new Error('Incorrect PIN');
          }
        } else {
          // The session secret is already verified (it unlocked this session).
          secretToStore = SessionKeyVault.getSecret() ?? undefined;
          source = SessionKeyVault.getSecretSource();
          if (secretToStore == null) {
            throw new Error(
              'Unlock with your PIN before enabling biometric unlock'
            );
          }
        }

        await AccountSecureStorage.setBiometricSecret(
          secretToStore,
          source,
          'Enable biometric unlock'
        );
      }

      await AccountSecureStorage.setBiometricEnabled(true);
    } else {
      // Disable: drop the auth-gated convenience secret, then clear the flag.
      await AccountSecureStorage.clearBiometricSecret();
      await AccountSecureStorage.setBiometricEnabled(false);
    }

    setAuthState((prev) => ({
      ...prev,
      biometricEnabled: enabled,
    }));
  };

  const recheckAuthState = async () => {
    await checkInitialAuthState();
  };

  const updateTimeoutSetting = async () => {
    try {
      const timeoutMinutes = await AccountSecureStorage.getPinTimeout();
      setAuthState((prev) => ({
        ...prev,
        timeoutMinutes,
      }));
    } catch (error) {
      console.error('Failed to update timeout setting:', error);
    }
  };

  const contextValue: AuthContextType = {
    authState,
    unlock,
    unlockWithBiometrics,
    lock,
    updateActivity,
    setupPin,
    enableBiometrics,
    recheckAuthState,
    updateTimeoutSetting,
  };

  return (
    <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
