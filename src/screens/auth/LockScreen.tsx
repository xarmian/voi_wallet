import React, { useState, useEffect } from 'react';
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
import { MultiAccountWalletService } from '@/services/wallet';

// Cross-platform alert helper
const showAlert = (title: string, message: string, buttons?: Array<{text: string, onPress?: () => void, style?: string}>) => {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const confirmed = window.confirm(`${title}\n\n${message}`);
      if (confirmed) {
        const confirmButton = buttons.find(b => b.style === 'destructive') || buttons[buttons.length - 1];
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

// Cross-platform vibration helper
const vibrate = (duration: number) => {
  if (Platform.OS !== 'web') {
    const { Vibration } = require('react-native');
    Vibration.vibrate(duration);
  }
};

export default function LockScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { authState, unlock, unlockWithBiometrics, recheckAuthState } =
    useAuth();
  const [pin, setPin] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [isLocked, setIsLocked] = useState(false);

  const MAX_ATTEMPTS = 5;
  const LOCKOUT_TIME = 30000; // 30 seconds

  useEffect(() => {
    if (authState.biometricEnabled) {
      promptBiometric();
    }
  }, [authState.biometricEnabled]);

  const promptBiometric = async () => {
    try {
      const success = await unlockWithBiometrics();
      if (!success) {
        // Biometric failed, user will need to use PIN
      }
    } catch (error) {
      console.error('Biometric authentication error:', error);
    }
  };

  const handleNumberPress = (number: string) => {
    if (isLocked || pin.length >= 6) return;

    const newPin = pin + number;
    setPin(newPin);

    if (newPin.length === 6) {
      verifyPin(newPin);
    }
  };

  const handleBackspace = () => {
    if (isLocked) return;
    setPin(pin.slice(0, -1));
  };

  const verifyPin = async (enteredPin: string) => {
    try {
      const success = await unlock(enteredPin);

      if (success) {
        setPin('');
        setAttempts(0);
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setPin('');
        vibrate(500);

        if (newAttempts >= MAX_ATTEMPTS) {
          setIsLocked(true);
          showAlert(
            'Too Many Attempts',
            `Wallet locked for ${LOCKOUT_TIME / 1000} seconds`
          );

          setTimeout(() => {
            setIsLocked(false);
            setAttempts(0);
          }, LOCKOUT_TIME);
        } else {
          showAlert(
            'Incorrect PIN',
            `${MAX_ATTEMPTS - newAttempts} attempts remaining`
          );
        }
      }
    } catch (error) {
      console.error('PIN verification error:', error);
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

      // Reset local state
      setPin('');
      setAttempts(0);
      setIsLocked(false);

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
                    disabled={isLocked}
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
                  disabled={isLocked}
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
          <Ionicons
            name="lock-closed"
            size={48}
            color={theme.colors.primary}
          />
          <Text style={styles.title}>Wallet Locked</Text>
          <Text style={styles.subtitle}>Enter your PIN to unlock</Text>
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

        {isLocked && (
          <View style={styles.lockoutContainer}>
            <Text style={styles.lockoutText}>
              Wallet temporarily locked due to too many failed attempts
            </Text>
          </View>
        )}

        {attempts >= 3 && (
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
