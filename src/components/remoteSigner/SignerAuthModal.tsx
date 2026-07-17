/**
 * SignerAuthModal - Authentication modal for signer device signing
 *
 * Shows PIN entry or biometric prompt to authorize signing.
 * Returns the PIN (for PIN auth) or undefined (for biometric auth) to the caller.
 * The caller can then use this to retrieve private keys and sign transactions.
 */

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as LocalAuthentication from 'expo-local-authentication';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { AccountSecureStorage } from '@/services/secure';
import type { SecretSource } from '@/services/secure/SessionKeyVault';
import { hapticNotify } from '@/utils/haptics';

interface SignerAuthModalProps {
  visible: boolean;
  /** Called when auth succeeds. pin is the entered PIN or undefined for biometric auth */
  onSuccess: (pin?: string) => void;
  /** Called when user cancels */
  onCancel: () => void;
  /** Number of transactions being signed */
  transactionCount?: number;
}

export default function SignerAuthModal({
  visible,
  onSuccess,
  onCancel,
  transactionCount = 1,
}: SignerAuthModalProps) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [pin, setPin] = useState('');
  // The stored credential kind decides the input: numeric keypad for a PIN, a
  // masked text field for a passphrase (PR7). Defaults to 'pin' until the read
  // resolves so existing PIN wallets show the keypad immediately.
  const [credentialSource, setCredentialSource] = useState<SecretSource>('pin');
  const isPassphrase = credentialSource === 'passphrase';
  const secretNoun = isPassphrase ? 'passphrase' : 'PIN';
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [pinAttempts, setPinAttempts] = useState(0);
  const [isLocked, setIsLocked] = useState(false);
  const [lockUntil, setLockUntil] = useState<number | null>(null);

  const MAX_ATTEMPTS = 5;
  const LOCKOUT_DURATION = 30000; // 30 seconds

  // Check biometric availability on mount
  useEffect(() => {
    const checkBiometric = async () => {
      try {
        const compatible = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        const biometricEnabled =
          await AccountSecureStorage.isBiometricEnabled();
        setBiometricAvailable(compatible && enrolled && biometricEnabled);
      } catch {
        setBiometricAvailable(false);
      }
    };

    if (visible) {
      checkBiometric();
      setPin('');
      setError(null);
      setPinAttempts(0);
      setIsLocked(false);
      setLockUntil(null);
    }
  }, [visible]);

  // Read the stored credential kind once on mount so the correct input renders.
  useEffect(() => {
    let cancelled = false;
    AccountSecureStorage.getCredentialSource()
      .then((source) => {
        if (!cancelled && source) {
          setCredentialSource(source);
        }
      })
      .catch(() => {
        // Keep the default ('pin') — the keypad still works for a PIN wallet, and
        // a passphrase wallet's verifyPin rejects a wrong-format entry safely.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-prompt for biometric auth when modal opens
  useEffect(() => {
    if (visible && biometricAvailable && !isVerifying) {
      handleBiometricAuth();
    }
  }, [visible, biometricAvailable]);

  // Handle lockout timer
  useEffect(() => {
    if (lockUntil) {
      const remaining = lockUntil - Date.now();
      if (remaining > 0) {
        const timer = setTimeout(() => {
          setIsLocked(false);
          setLockUntil(null);
          setPinAttempts(0);
        }, remaining);
        return () => clearTimeout(timer);
      } else {
        setIsLocked(false);
        setLockUntil(null);
        setPinAttempts(0);
      }
    }
  }, [lockUntil]);

  const handleNumberPress = (number: string) => {
    if (isLocked || pin.length >= 6 || isVerifying) return;

    const newPin = pin + number;
    setPin(newPin);
    setError(null);

    if (newPin.length === 6) {
      handlePinSubmit(newPin);
    }
  };

  const handleBackspace = () => {
    if (isLocked || isVerifying) return;
    setPin(pin.slice(0, -1));
    setError(null);
  };

  const handlePinSubmit = async (enteredPin: string) => {
    setIsVerifying(true);
    setError(null);

    try {
      const isValid = await AccountSecureStorage.verifyPin(enteredPin);

      if (isValid) {
        onSuccess(enteredPin);
      } else {
        const attempts = pinAttempts + 1;
        setPinAttempts(attempts);
        setPin('');
        hapticNotify('error');

        if (attempts >= MAX_ATTEMPTS) {
          setIsLocked(true);
          setLockUntil(Date.now() + LOCKOUT_DURATION);
          setError('Too many attempts. Try again in 30 seconds.');
        } else {
          setError(
            `Incorrect ${secretNoun}. ${MAX_ATTEMPTS - attempts} attempts remaining.`
          );
        }
      }
    } catch (error) {
      console.error('Secret verification error:', error);
      setError(`Failed to verify ${secretNoun}`);
      setPin('');
    } finally {
      setIsVerifying(false);
    }
  };

  // Passphrase submit — reuses the same handlePinSubmit()/verify path as the
  // keypad; it only differs in how the secret is entered (full string vs. digits).
  const handlePassphraseSubmit = () => {
    if (isLocked || isVerifying || pin.length === 0) return;
    handlePinSubmit(pin);
  };

  const handleBiometricAuth = async () => {
    if (isVerifying) return;
    setIsVerifying(true);
    setError(null);

    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Authenticate to sign transactions',
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
        requireConfirmation: false,
      });

      if (result.success) {
        onSuccess(undefined); // No PIN needed for biometric
      } else if (result.error === 'user_fallback') {
        // User chose to use PIN instead
        setError(null);
      } else if (result.error === 'user_cancel') {
        // User cancelled - don't show error
        setError(null);
      }
    } catch (error) {
      console.error('Biometric auth error:', error);
      setError('Biometric authentication failed');
    } finally {
      setIsVerifying(false);
    }
  };

  const getMessage = () => {
    if (transactionCount === 1) {
      return 'Sign 1 transaction';
    }
    return `Sign ${transactionCount} transactions`;
  };

  const renderPinDots = () => (
    <View style={styles.pinDots}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <View
          key={i}
          style={[
            styles.pinDot,
            i < pin.length && styles.pinDotFilled,
            {
              backgroundColor:
                i < pin.length ? theme.colors.primary : theme.colors.border,
            },
          ]}
        />
      ))}
    </View>
  );

  const renderPassphraseInput = () => {
    const submitDisabled = isLocked || isVerifying || pin.length === 0;
    return (
      <View style={styles.passphraseContainer}>
        <TextInput
          style={styles.passphraseInput}
          value={pin}
          onChangeText={(text) => {
            setPin(text);
            setError(null);
          }}
          placeholder="Enter your passphrase"
          placeholderTextColor={theme.colors.textMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isLocked && !isVerifying}
          onSubmitEditing={handlePassphraseSubmit}
          returnKeyType="go"
          autoFocus
        />
        <TouchableOpacity
          style={[
            styles.passphraseSubmit,
            submitDisabled && styles.passphraseSubmitDisabled,
          ]}
          onPress={handlePassphraseSubmit}
          disabled={submitDisabled}
        >
          <Text style={styles.passphraseSubmitText}>Unlock</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderNumberPad = () => (
    <View style={styles.numberPad}>
      {[
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9'],
        ['bio', '0', 'del'],
      ].map((row, rowIndex) => (
        <View key={rowIndex} style={styles.numberRow}>
          {row.map((key) => {
            if (key === 'bio') {
              if (!biometricAvailable) {
                return <View key={key} style={styles.numberButton} />;
              }
              return (
                <TouchableOpacity
                  key={key}
                  style={styles.numberButton}
                  onPress={handleBiometricAuth}
                  disabled={isVerifying || isLocked}
                >
                  <Ionicons
                    name="finger-print"
                    size={28}
                    color={
                      isLocked ? theme.colors.textMuted : theme.colors.primary
                    }
                  />
                </TouchableOpacity>
              );
            }

            if (key === 'del') {
              return (
                <TouchableOpacity
                  key={key}
                  style={styles.numberButton}
                  onPress={handleBackspace}
                  disabled={isVerifying || isLocked}
                >
                  <Ionicons
                    name="backspace-outline"
                    size={24}
                    color={
                      isLocked ? theme.colors.textMuted : theme.colors.text
                    }
                  />
                </TouchableOpacity>
              );
            }

            return (
              <TouchableOpacity
                key={key}
                style={[styles.numberButton, styles.numberButtonWithBg]}
                onPress={() => handleNumberPress(key)}
                disabled={isVerifying || isLocked}
              >
                <Text
                  style={[
                    styles.numberText,
                    (isVerifying || isLocked) && styles.numberTextDisabled,
                  ]}
                >
                  {key}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onCancel}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity style={styles.cancelButton} onPress={onCancel}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Authenticate</Text>
            <View style={styles.placeholder} />
          </View>

          {/* Content */}
          <View style={styles.content}>
            <View style={styles.iconContainer}>
              <Ionicons
                name="lock-closed-outline"
                size={48}
                color={theme.colors.primary}
              />
            </View>

            <Text style={styles.message}>{getMessage()}</Text>

            {isVerifying && (
              <ActivityIndicator
                size="small"
                color={theme.colors.primary}
                style={styles.verifying}
              />
            )}

            {!isPassphrase && renderPinDots()}

            {error && <Text style={styles.error}>{error}</Text>}

            {isPassphrase ? renderPassphraseInput() : renderNumberPad()}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    container: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    cancelButton: {
      padding: 8,
    },
    cancelText: {
      fontSize: 16,
      color: theme.colors.primary,
    },
    title: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholder: {
      width: 60,
    },
    content: {
      alignItems: 'center',
      paddingTop: 24,
      paddingHorizontal: 20,
    },
    iconContainer: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: theme.colors.primary + '15',
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 16,
    },
    message: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 24,
    },
    verifying: {
      marginBottom: 8,
    },
    pinDots: {
      flexDirection: 'row',
      gap: 12,
      marginBottom: 24,
    },
    pinDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    pinDotFilled: {
      borderWidth: 0,
    },
    passphraseContainer: {
      width: '100%',
      maxWidth: 300,
      marginBottom: 24,
      gap: theme.spacing.md,
    },
    passphraseInput: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      fontSize: 18,
      color: theme.colors.text,
      backgroundColor: theme.colors.card,
    },
    passphraseSubmit: {
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.lg,
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
    },
    passphraseSubmitDisabled: {
      opacity: 0.5,
    },
    passphraseSubmitText: {
      color: theme.colors.buttonText,
      fontSize: 16,
      fontWeight: '600',
    },
    error: {
      fontSize: 14,
      color: theme.colors.error,
      textAlign: 'center',
      marginBottom: 16,
    },
    numberPad: {
      width: '100%',
      maxWidth: 300,
      gap: 12,
    },
    numberRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    numberButton: {
      width: 80,
      height: 60,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: 12,
    },
    numberButtonWithBg: {
      backgroundColor: theme.colors.card,
    },
    numberText: {
      fontSize: 28,
      fontWeight: '500',
      color: theme.colors.text,
    },
    numberTextDisabled: {
      color: theme.colors.textMuted,
    },
  });
