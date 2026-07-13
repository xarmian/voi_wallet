import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useAuth } from '@/contexts/AuthContext';
import { AccountSecureStorage } from '@/services/secure';
import type { PinThrottleState } from '@/services/secure';
import { MultiAccountWalletService } from '@/services/wallet';
import { hapticNotify } from '@/utils/haptics';
import { SECURITY_CONFIG, SECURITY_MESSAGES } from '@/config/security';

// Cross-platform alert helper
const showAlert = (
  title: string,
  message: string,
  buttons?: { text: string; onPress?: () => void; style?: string }[]
) => {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const confirmed = window.confirm(`${title}\n\n${message}`);
      if (confirmed) {
        const confirmButton =
          buttons.find((b) => b.style === 'destructive') ||
          buttons[buttons.length - 1];
        confirmButton?.onPress?.();
      }
    } else {
      window.alert(`${title}\n\n${message}`);
      buttons?.[0]?.onPress?.();
    }
  } else {
    const { Alert } = require('react-native');
    Alert.alert(title, message, buttons);
  }
};

// Format a remaining-lockout duration as M:SS for the live countdown.
const formatCountdown = (ms: number): string => {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

export default function LockScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { authState, unlock, unlockWithBiometrics, recheckAuthState } =
    useAuth();
  const [pin, setPin] = useState('');

  // Lockout state is now sourced from the PERSISTENT throttle in
  // AccountSecureStorage (DOC-137 §8 / TASK-26) instead of local React state, so
  // it survives an app relaunch. `nowTick` drives the live countdown.
  const [throttle, setThrottle] = useState<PinThrottleState>({
    lockedUntil: null,
    attemptsRemaining: SECURITY_CONFIG.PIN_ATTEMPT_LIMIT,
  });
  const [nowTick, setNowTick] = useState(() => Date.now());
  // Until the FIRST persisted-throttle read resolves we don't know whether the
  // wallet is locked out, so PIN entry stays disabled — the UI must never
  // momentarily look unlocked while the persisted state is actually locked
  // (Codex P2 hydration flicker).
  const [hydrated, setHydrated] = useState(false);

  const isLocked =
    throttle.lockedUntil !== null && nowTick < throttle.lockedUntil;
  const lockRemainingMs = isLocked
    ? Math.max(0, (throttle.lockedUntil ?? 0) - nowTick)
    : 0;
  // Gate all PIN input on both the lockout AND hydration.
  const inputDisabled = isLocked || !hydrated;

  const refreshThrottle = useCallback(async () => {
    try {
      const state = await AccountSecureStorage.getPinThrottleState();
      setThrottle(state);
    } catch (error) {
      console.error('Failed to read PIN throttle state:', error);
    } finally {
      // Hydrated regardless of success — on a read error the service still
      // fails closed, and we don't want to strand input disabled forever.
      setHydrated(true);
    }
  }, []);

  // Load persisted lockout on mount so a relaunch during a lockout stays locked.
  useEffect(() => {
    const loadThrottleState = async () => {
      await refreshThrottle();
    };
    loadThrottleState();
    // Defensive: if the throttle read hangs, don't strand PIN input disabled
    // forever. Flip hydrated after 3s regardless — the service is still the real
    // gate (verifyPin rejects a locked PIN), so failing the UI toward "enabled"
    // is safe.
    const hydrationTimeout = setTimeout(() => setHydrated(true), 3000);
    return () => clearTimeout(hydrationTimeout);
  }, [refreshThrottle]);

  // While locked, tick every second to drive the countdown and auto-unlock when
  // the window elapses (re-reading the persisted state to clear the lockout).
  useEffect(() => {
    if (throttle.lockedUntil === null) {
      return;
    }
    const interval = setInterval(() => {
      const t = Date.now();
      if (t >= (throttle.lockedUntil ?? 0)) {
        refreshThrottle();
      } else {
        setNowTick(t);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [throttle.lockedUntil, refreshThrottle]);

  useEffect(() => {
    if (authState.biometricEnabled) {
      promptBiometric();
    }
  }, [authState.biometricEnabled]);

  const promptBiometric = async () => {
    try {
      const success = await unlockWithBiometrics();
      if (success) {
        hapticNotify('success');
      }
      // On !success the user cancelled or biometrics failed; no error haptic —
      // a cancel is a normal path to the PIN pad and shouldn't buzz.
    } catch (error) {
      console.error('Biometric authentication error:', error);
    }
  };

  const handleNumberPress = (number: string) => {
    if (inputDisabled || pin.length >= 6) return;

    const newPin = pin + number;
    setPin(newPin);

    if (newPin.length === 6) {
      verifyPin(newPin);
    }
  };

  const handleBackspace = () => {
    if (inputDisabled) return;
    setPin(pin.slice(0, -1));
  };

  const verifyPin = async (enteredPin: string) => {
    try {
      // unlock() -> AccountSecureStorage.verifyPin() applies the persistent
      // throttle internally (and returns a plain boolean). We read the resulting
      // lockout/remaining-attempts back via the separate throttle-state query.
      const success = await unlock(enteredPin);
      setPin('');

      if (success) {
        hapticNotify('success');
        setThrottle({
          lockedUntil: null,
          attemptsRemaining: SECURITY_CONFIG.PIN_ATTEMPT_LIMIT,
        });
        return;
      }

      hapticNotify('error');
      // getPinThrottleState() returns lockedUntil=null once a lockout has
      // elapsed, so a non-null value here means "currently locked".
      const state = await AccountSecureStorage.getPinThrottleState();
      setThrottle(state);

      if (state.lockedUntil !== null) {
        showAlert('Too Many Attempts', SECURITY_MESSAGES.PIN_ATTEMPTS_EXCEEDED);
      } else if (state.attemptsRemaining > 0) {
        showAlert(
          'Incorrect PIN',
          `${state.attemptsRemaining} attempt${
            state.attemptsRemaining === 1 ? '' : 's'
          } remaining`
        );
      } else {
        showAlert('Incorrect PIN', SECURITY_MESSAGES.PIN_ATTEMPTS_EXCEEDED);
      }
    } catch (error) {
      console.error('PIN verification error:', error);
      hapticNotify('error');
      showAlert('Error', 'Failed to verify PIN');
    }
  };

  const handleReset = () => {
    showAlert(
      'Reset Application',
      'This will permanently delete all wallet data, accounts, and settings. This action cannot be undone.\n\nAre you sure you want to continue?',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: confirmReset,
        },
      ]
    );
  };

  const confirmReset = () => {
    showAlert(
      'Final Confirmation',
      'This is your last chance. All wallet data will be permanently deleted.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete Everything',
          style: 'destructive',
          onPress: performReset,
        },
      ]
    );
  };

  const performReset = async () => {
    try {
      // Clear all secure storage
      await AccountSecureStorage.clearAll();

      // Clear wallet data
      await MultiAccountWalletService.clearAllWallets();

      // Reset local state (clearAll() also wipes the persisted PIN throttle).
      setPin('');
      setThrottle({
        lockedUntil: null,
        attemptsRemaining: SECURITY_CONFIG.PIN_ATTEMPT_LIMIT,
      });

      // Force the AuthContext to re-check the initial state
      await recheckAuthState();

      showAlert(
        'Reset Complete',
        'All application data has been cleared. You can now set up a new wallet.',
        [
          {
            text: 'OK',
          },
        ]
      );
    } catch (error) {
      console.error('Reset error:', error);
      showAlert('Error', 'Failed to reset application. Please try again.');
    }
  };

  const renderPinDots = () => {
    return (
      <View style={styles.pinContainer}>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <View
            key={index}
            style={[
              styles.pinDot,
              index < pin.length ? styles.pinDotFilled : null,
            ]}
          />
        ))}
      </View>
    );
  };

  const renderKeypad = () => {
    const numbers = [
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'],
      ['', '0', 'backspace'],
    ];

    return (
      <View style={styles.keypad}>
        {numbers.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.keypadRow}>
            {row.map((item, itemIndex) => {
              if (item === '') {
                return <View key={itemIndex} style={styles.keypadButton} />;
              }

              if (item === 'backspace') {
                return (
                  <TouchableOpacity
                    key={itemIndex}
                    style={styles.keypadButton}
                    onPress={handleBackspace}
                    disabled={inputDisabled}
                  >
                    <Ionicons
                      name="backspace-outline"
                      size={24}
                      color={theme.colors.text}
                    />
                  </TouchableOpacity>
                );
              }

              return (
                <TouchableOpacity
                  key={itemIndex}
                  style={styles.keypadButton}
                  onPress={() => handleNumberPress(item)}
                  disabled={inputDisabled}
                >
                  <Text style={styles.keypadButtonText}>{item}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Ionicons name="lock-closed" size={48} color={theme.colors.primary} />
          <Text style={styles.title}>Wallet Locked</Text>
          <Text style={styles.subtitle}>
            {hydrated ? 'Enter your PIN to unlock' : 'Checking status…'}
          </Text>
        </View>

        {renderPinDots()}

        {authState.biometricEnabled && !isLocked && (
          <TouchableOpacity
            style={styles.biometricButton}
            onPress={promptBiometric}
          >
            <Ionicons
              name="finger-print"
              size={32}
              color={theme.colors.primary}
            />
            <Text style={styles.biometricText}>Use Biometric</Text>
          </TouchableOpacity>
        )}

        {renderKeypad()}

        {isLocked ? (
          <View style={styles.lockoutContainer}>
            <Text style={styles.lockoutText}>
              {SECURITY_MESSAGES.PIN_ATTEMPTS_EXCEEDED}
            </Text>
            <Text style={styles.lockoutCountdown}>
              Try again in {formatCountdown(lockRemainingMs)}
            </Text>
          </View>
        ) : (
          throttle.attemptsRemaining < SECURITY_CONFIG.PIN_ATTEMPT_LIMIT &&
          throttle.attemptsRemaining > 0 && (
            <View style={styles.lockoutContainer}>
              <Text style={styles.lockoutText}>
                {throttle.attemptsRemaining} attempt
                {throttle.attemptsRemaining === 1 ? '' : 's'} remaining
              </Text>
            </View>
          )
        )}

        {(isLocked || throttle.attemptsRemaining <= 2) && (
          <View style={styles.resetContainer}>
            <Text style={styles.resetHelpText}>
              Forgot your PIN? You can reset the application, but this will
              delete all data.
            </Text>
            <TouchableOpacity style={styles.resetButton} onPress={handleReset}>
              <Ionicons
                name="refresh-outline"
                size={20}
                color={theme.colors.error}
              />
              <Text style={styles.resetButtonText}>Reset Application</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    content: {
      flex: 1,
      paddingHorizontal: theme.spacing.lg,
      justifyContent: 'center',
    },
    header: {
      alignItems: 'center',
      marginBottom: theme.spacing.xxl * 2,
    },
    title: {
      fontSize: 24,
      fontWeight: 'bold',
      color: theme.colors.text,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    subtitle: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    pinContainer: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: theme.spacing.xxl,
      gap: theme.spacing.lg,
    },
    pinDot: {
      width: 16,
      height: 16,
      borderRadius: 8,
      borderWidth: 2,
      borderColor: theme.colors.border,
      backgroundColor: 'transparent',
    },
    pinDotFilled: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    biometricButton: {
      alignItems: 'center',
      marginBottom: theme.spacing.xxl,
      paddingVertical: theme.spacing.lg,
    },
    biometricText: {
      fontSize: 16,
      color: theme.colors.primary,
      marginTop: theme.spacing.sm,
      fontWeight: '500',
    },
    keypad: {
      alignItems: 'center',
    },
    keypadRow: {
      flexDirection: 'row',
      marginBottom: theme.spacing.lg,
    },
    keypadButton: {
      width: 70,
      height: 70,
      borderRadius: 35,
      backgroundColor: theme.colors.surface,
      marginHorizontal: theme.spacing.xl,
      justifyContent: 'center',
      alignItems: 'center',
      ...theme.shadows.md,
    },
    keypadButtonText: {
      fontSize: 24,
      fontWeight: '500',
      color: theme.colors.text,
    },
    lockoutContainer: {
      marginTop: theme.spacing.xxl,
      paddingHorizontal: theme.spacing.lg,
    },
    lockoutText: {
      fontSize: 14,
      color: theme.colors.error,
      textAlign: 'center',
      lineHeight: 20,
    },
    lockoutCountdown: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.error,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      fontVariant: ['tabular-nums'],
    },
    resetContainer: {
      marginTop: theme.spacing.xxl,
      paddingHorizontal: theme.spacing.lg,
      alignItems: 'center',
    },
    resetHelpText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginBottom: theme.spacing.lg,
      lineHeight: 16,
    },
    resetButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      backgroundColor:
        theme.mode === 'light' ? '#FFF5F5' : theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.mode === 'light' ? '#FFE5E5' : theme.colors.error,
    },
    resetButtonText: {
      fontSize: 14,
      color: theme.colors.error,
      marginLeft: theme.spacing.sm,
      fontWeight: '500',
    },
  });
