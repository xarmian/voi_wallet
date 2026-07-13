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
import { clearSessionSecurity } from '@/services/secure/sessionTeardown';
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
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    return { hasHardware, isEnrolled };
  } catch {
    return { hasHardware: false, isEnrolled: false };
  }
};

// Helper to authenticate with biometrics (web-safe)
const authenticateWithBiometrics = async (
  promptMessage: string
): Promise<{ success: boolean }> => {
  if (Platform.OS === 'web') {
    return { success: false };
  }
  try {
    const LocalAuthentication = require('expo-local-authentication');
    return await LocalAuthentication.authenticateAsync({
      promptMessage,
      fallbackLabel: 'Use PIN',
      cancelLabel: 'Cancel',
    });
  } catch {
    return { success: false };
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
}

export interface AuthContextType {
  authState: AuthState;
  unlock: (pin: string) => Promise<boolean>;
  unlockWithBiometrics: () => Promise<boolean>;
  lock: () => void;
  updateActivity: () => void;
  setupPin: (pin: string) => Promise<void>;
  enableBiometrics: (enabled: boolean) => Promise<void>;
  recheckAuthState: () => Promise<void>;
  updateTimeoutSetting: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const DEFAULT_SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes default
const ACTIVITY_CHECK_INTERVAL = 30 * 1000; // 30 seconds
const BACKGROUND_GRACE_PERIOD = 60 * 1000; // 60 seconds

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
  });

  const activityTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const sessionTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const backgroundTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  // Always-fresh mirror of authState so the inactivity interval can read the
  // latest activity/auth flags and route through the single lock() (below)
  // rather than mutating state inline (needed so lock's session teardown runs).
  const authStateRef = useRef(authState);
  authStateRef.current = authState;

  useEffect(() => {
    checkInitialAuthState();
    setupAppStateListener();

    return () => {
      if (activityTimer.current) clearInterval(activityTimer.current);
      if (sessionTimer.current) clearTimeout(sessionTimer.current);
      if (backgroundTimer.current) clearTimeout(backgroundTimer.current);
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
      const wallet = await MultiAccountWalletService.getCurrentWallet();
      const hasPin = await AccountSecureStorage.hasPin();
      const { hasHardware, isEnrolled } = await checkBiometricAvailability();
      const biometricEnabled = await AccountSecureStorage.isBiometricEnabled();
      const biometricAvailable = hasHardware && isEnrolled;
      const timeoutMinutes = await AccountSecureStorage.getPinTimeout();

      if (!wallet || wallet.accounts.length === 0 || !hasPin) {
        // No wallet setup yet or no PIN set - allow access for setup
        setAuthState((prev) => ({
          ...prev,
          isLocked: false,
          isAuthenticated: true,
          biometricEnabled: biometricEnabled && biometricAvailable,
          backgroundedAt: null,
          timeoutMinutes,
          hasPin,
        }));
        return;
      }

      // Wallet exists and has PIN - require authentication
      setAuthState((prev) => ({
        ...prev,
        isLocked: true,
        isAuthenticated: false,
        biometricEnabled: biometricEnabled && biometricAvailable,
        backgroundedAt: null,
        timeoutMinutes,
        hasPin,
      }));
    } catch (error) {
      console.error('Failed to check initial auth state:', error);
    }
  };

  const setupAppStateListener = () => {
    // Skip AppState listener on web - it doesn't work correctly and can cause
    // unexpected lock behavior when switching tabs
    if (Platform.OS === 'web') {
      return () => {};
    }

    let previousAppState = AppState.currentState;

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      const now = Date.now();

      if (nextAppState === 'background') {
        // App is going to background - start grace period timer
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
        previousAppState === 'background'
      ) {
        // App is returning from background
        const backgroundedAt = authState.backgroundedAt;

        // Clear the background timer
        if (backgroundTimer.current) {
          clearTimeout(backgroundTimer.current);
          backgroundTimer.current = undefined;
        }

        // Check if grace period has expired
        if (backgroundedAt && now - backgroundedAt > BACKGROUND_GRACE_PERIOD) {
          // Grace period expired - lock the app
          lock();
        } else {
          // Within grace period - update activity and keep unlocked
          setAuthState((prev) => ({
            ...prev,
            backgroundedAt: null,
            lastActivity: now,
          }));
        }
      }

      previousAppState = nextAppState;
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

  const unlock = async (pin: string): Promise<boolean> => {
    try {
      if (!pin || pin.length !== 6) {
        return false;
      }

      const isValid = await AccountSecureStorage.verifyPin(pin);

      if (isValid) {
        // Populate the session vault with the verified secret (DOC-137 §6.3).
        // In PR3 keys are still Format A, so the vault is not yet load-bearing
        // for decryption (the device-key path handles it) — this establishes
        // the session secret the v2-blob path will use in PR4/PR5.
        SessionKeyVault.set(pin, 'pin');

        const sessionId = SecurityUtils.generateSessionId();
        setAuthState((prev) => ({
          ...prev,
          isLocked: false,
          isAuthenticated: true,
          sessionId,
          lastActivity: Date.now(),
        }));
        updateActivity();
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

      const result = await authenticateWithBiometrics('Unlock your wallet');

      if (result.success) {
        // NOTE (DOC-137 §3.3, PR3): the biometric-convenience secret item that
        // yields the user secret on biometric unlock lands in a later PR (the
        // writer/biometric milestone). Until then biometric unlock has no user
        // secret to populate the vault with, and — since keys are still Format A
        // — the device-key path decrypts without one, so this is behavior-
        // preserving. When the convenience item ships, read the secret here and
        // call SessionKeyVault.set(secret, secretSource).
        const sessionId = SecurityUtils.generateSessionId();
        setAuthState((prev) => ({
          ...prev,
          isLocked: false,
          isAuthenticated: true,
          sessionId,
          lastActivity: Date.now(),
        }));
        updateActivity();
        return true;
      }

      return false;
    } catch (error) {
      console.error('Failed to unlock with biometrics:', error);
      return false;
    }
  };

  const lock = () => {
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

    // The SINGLE session-security teardown for EVERY lock path (explicit,
    // inactivity-timeout, and background-grace all route through here): clear
    // the session vault (bumping its epoch — Codex P1-D), the legacy 60 s
    // plaintext-key cache, and the ~30 min messaging key cache (Codex P1-E).
    // Idempotent; safe to run even when no PIN is set (all caches are empty).
    clearSessionSecurity();
  };

  const setupPin = async (pin: string): Promise<void> => {
    if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      throw new Error('PIN must be 6 digits');
    }

    await AccountSecureStorage.storePin(pin);
    setAuthState((prev) => ({
      ...prev,
      hasPin: true,
    }));
  };

  const enableBiometrics = async (enabled: boolean): Promise<void> => {
    if (enabled) {
      const { hasHardware, isEnrolled } = await checkBiometricAvailability();

      if (!hasHardware || !isEnrolled) {
        throw new Error(
          'Biometric authentication not available or not enrolled'
        );
      }
    }

    await AccountSecureStorage.setBiometricEnabled(enabled);
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
