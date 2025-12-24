import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useAuth } from '@/contexts/AuthContext';
import { AccountSecureStorage } from '@/services/secure';
import { LedgerDeviceInfo } from '@/services/ledger/transport';

// Cross-platform alert helper
const showAlert = (title: string, message: string, buttons?: Array<{text: string, onPress?: () => void}>) => {
  if (Platform.OS === 'web') {
    window.alert(`${title}\n\n${message}`);
    buttons?.[0]?.onPress?.();
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

type LedgerStatus =
  | 'searching'
  | 'waiting_for_connection'
  | 'waiting_for_app'
  | 'waiting_for_confirmation'
  | 'error';

interface UnifiedAuthModalProps {
  visible: boolean;
  onSuccess: (pin?: string) => void;
  onCancel: () => void;
  title?: string;
  message?: string;
  purpose?:
    | 'sign_transaction'
    | 'export_keys'
    | 'delete_account'
    | 'access_private_key';
  biometricEnabled?: boolean;
  isProcessing?: boolean;
  isLedgerFlow?: boolean;
  ledgerStatus?: LedgerStatus;
  ledgerDevice?: LedgerDeviceInfo | null;
  onLedgerRetry?: () => void;
}

export default function UnifiedAuthModal({
  visible,
  onSuccess,
  onCancel,
  title = 'Authentication Required',
  message = 'Please authenticate to continue',
  purpose = 'sign_transaction',
  biometricEnabled,
  isProcessing = false,
  isLedgerFlow = false,
  ledgerStatus = 'searching',
  ledgerDevice = null,
  onLedgerRetry,
}: UnifiedAuthModalProps) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const { authState } = useAuth();
  const [pin, setPin] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [isLocked, setIsLocked] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [biometricAttempted, setBiometricAttempted] = useState(false);
  const [biometricAuthenticated, setBiometricAuthenticated] = useState(false);

  const MAX_ATTEMPTS = 5;
  const LOCKOUT_TIME = 30000; // 30 seconds

  // Determine if biometrics should be used
  const shouldUseBiometrics = biometricEnabled ?? authState.biometricEnabled;

  // Debug: Track processing state changes
  useEffect(() => {
    console.log('UnifiedAuthModal: isProcessing changed to:', isProcessing);
  }, [isProcessing]);

  useEffect(() => {
    if (visible && shouldUseBiometrics && !biometricAttempted) {
      promptBiometric();
    }
  }, [visible, shouldUseBiometrics, biometricAttempted]);

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setPin('');
      setAttempts(0);
      setIsLocked(false);
      setBiometricAttempted(false);
      setBiometricAuthenticated(false);
    }
  }, [visible]);

  const getAuthMessage = (authPurpose: string): string => {
    switch (authPurpose) {
      case 'sign_transaction':
        return 'Authenticate to sign transaction';
      case 'export_keys':
        return 'Authenticate to export private keys';
      case 'delete_account':
        return 'Authenticate to delete account';
      case 'access_private_key':
        return 'Authenticate to access private key';
      default:
        return 'Authenticate to continue';
    }
  };

  const getLedgerStatusMessage = (status: LedgerStatus): { title: string; message: string; icon: string } => {
    switch (status) {
      case 'searching':
        return {
          title: 'Looking for Ledger Device',
          message: 'Searching for your Ledger device...',
          icon: 'search'
        };
      case 'waiting_for_connection':
        return {
          title: 'Connect Your Ledger',
          message: 'Please connect your Ledger device and unlock it.',
          icon: 'link'
        };
      case 'waiting_for_app':
        return {
          title: 'Open Algorand App',
          message: 'Please open the Algorand application on your Ledger device.',
          icon: 'apps'
        };
      case 'waiting_for_confirmation':
        return {
          title: 'Confirm on Ledger',
          message: 'Review and approve the transaction on your Ledger device.',
          icon: 'checkmark-circle'
        };
      case 'error':
        return {
          title: 'Connection Failed',
          message: 'Unable to connect to your Ledger device.',
          icon: 'warning'
        };
      default:
        return {
          title: 'Processing Transaction',
          message: 'Please wait while your transaction is being processed...',
          icon: 'time'
        };
    }
  };

  const promptBiometric = async () => {
    setBiometricAttempted(true);
    setIsAuthenticating(true);

    // Biometric auth not available on web
    if (Platform.OS === 'web') {
      console.log('Biometric authentication not available on web, falling back to PIN');
      setIsAuthenticating(false);
      return;
    }

    try {
      const LocalAuthentication = require('expo-local-authentication');
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        console.log(
          'Biometric authentication not available, falling back to PIN'
        );
        setIsAuthenticating(false);
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: getAuthMessage(purpose),
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
        requireConfirmation: false,
      });

      if (result.success) {
        setIsAuthenticating(false);
        setBiometricAuthenticated(true);
      } else {
        console.log(
          'Biometric authentication failed or cancelled, showing PIN input'
        );
        setIsAuthenticating(false);
      }
    } catch (error) {
      console.error('Biometric authentication error:', error);
      setIsAuthenticating(false);
    }
  };

  const handleNumberPress = (number: string) => {
    if (isLocked || pin.length >= 6 || isAuthenticating) return;

    const newPin = pin + number;
    setPin(newPin);

    if (newPin.length === 6) {
      verifyPin(newPin);
    }
  };

  const handleBackspace = () => {
    if (isLocked || isAuthenticating) return;
    setPin(pin.slice(0, -1));
  };

  const verifyPin = async (enteredPin: string) => {
    setIsAuthenticating(true);

    try {
      const isValid = await AccountSecureStorage.verifyPin(enteredPin);

      if (isValid) {
        setPin('');
        setAttempts(0);
        setIsAuthenticating(false);
        onSuccess(enteredPin);
      } else {
        const newAttempts = attempts + 1;
        setAttempts(newAttempts);
        setPin('');
        vibrate(500);

        if (newAttempts >= MAX_ATTEMPTS) {
          setIsLocked(true);
          showAlert(
            'Too Many Attempts',
            `Authentication locked for ${LOCKOUT_TIME / 1000} seconds`
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
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleBiometricConfirm = () => {
    console.log(
      'handleBiometricConfirm called, onSuccess is:',
      typeof onSuccess
    );
    console.log('About to call onSuccess...');
    try {
      // If parent is managing processing state, call onSuccess immediately
      // This will trigger parent to set isProcessing=true
      onSuccess(); // No PIN needed for biometric auth
      console.log('onSuccess called successfully');
    } catch (error) {
      console.error('Error calling onSuccess:', error);
    }
  };

  const handleBiometricCancel = () => {
    // Cancel the entire authentication process, don't go back to PIN
    handleCancel();
  };

  const handleCancel = () => {
    setPin('');
    setAttempts(0);
    setBiometricAttempted(false);
    setBiometricAuthenticated(false);
    onCancel();
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
                    disabled={isLocked || isAuthenticating}
                  >
                    <Ionicons
                      name="backspace-outline"
                      size={20}
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
                  disabled={isLocked || isAuthenticating}
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
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        // Don't allow closing during processing
        if (!isProcessing) {
          handleCancel();
        }
      }}
    >
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <View style={styles.header}>
            <Ionicons
              name="shield-checkmark"
              size={32}
              color={theme.colors.primary}
            />
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.message}>{message}</Text>
          </View>

          {isAuthenticating ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={styles.loadingText}>Authenticating...</Text>
            </View>
          ) : isProcessing ? (
            <View style={styles.processingContainer}>
              {isLedgerFlow ? (
                <>
                  <Ionicons
                    name={getLedgerStatusMessage(ledgerStatus).icon as any}
                    size={48}
                    color={ledgerStatus === 'error' ? theme.colors.error : theme.colors.primary}
                  />
                  <Text style={[
                    styles.processingTitle,
                    ledgerStatus === 'error' && styles.errorTitle
                  ]}>
                    {getLedgerStatusMessage(ledgerStatus).title}
                  </Text>
                  <Text style={styles.processingMessage}>
                    {getLedgerStatusMessage(ledgerStatus).message}
                  </Text>
                  {ledgerDevice && (
                    <View style={styles.deviceStatusContainer}>
                      <View style={[
                        styles.deviceStatusIndicator,
                        ledgerDevice.connected ? styles.deviceConnected : styles.deviceDisconnected
                      ]} />
                      <Text style={styles.deviceStatusText}>
                        {ledgerDevice.connected ? `${ledgerDevice.name} connected` : `${ledgerDevice.name} detected`}
                      </Text>
                    </View>
                  )}
                </>
              ) : (
                <>
                  <ActivityIndicator size="large" color={theme.colors.primary} />
                  <Text style={styles.processingTitle}>Processing Transaction</Text>
                  <Text style={styles.processingMessage}>
                    Please wait while your transaction is being processed...
                  </Text>
                </>
              )}
            </View>
          ) : biometricAuthenticated ? (
            <View style={styles.confirmationContainer}>
              <Ionicons
                name="checkmark-circle"
                size={48}
                color={theme.colors.success}
              />
              <Text style={styles.confirmationTitle}>
                Authentication Successful
              </Text>
              <Text style={styles.confirmationMessage}>
                Tap "Confirm" to proceed with the transaction
              </Text>
            </View>
          ) : (
            <>
              {renderPinDots()}

              {shouldUseBiometrics && !isLocked && (
                <TouchableOpacity
                  style={styles.biometricButton}
                  onPress={promptBiometric}
                  disabled={isAuthenticating}
                >
                  <Ionicons
                    name="finger-print"
                    size={24}
                    color={theme.colors.primary}
                  />
                  <Text style={styles.biometricText}>Use Biometric</Text>
                </TouchableOpacity>
              )}

              {renderKeypad()}

              {isLocked && (
                <View style={styles.lockoutContainer}>
                  <Text style={styles.lockoutText}>
                    Authentication temporarily locked due to too many failed
                    attempts
                  </Text>
                </View>
              )}
            </>
          )}

          <View style={styles.buttonContainer}>
            {isProcessing ? (
              isLedgerFlow && ledgerStatus === 'error' ? (
                // Show retry and cancel buttons for Ledger errors
                <>
                  <TouchableOpacity
                    style={[styles.button, styles.cancelButton]}
                    onPress={onCancel}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.button, styles.confirmButton]}
                    onPress={onLedgerRetry || (() => {})}
                    disabled={!onLedgerRetry}
                  >
                    <Text style={styles.confirmButtonText}>Try Again</Text>
                  </TouchableOpacity>
                </>
              ) : (
                // No buttons during normal processing - user must wait
                <View style={styles.processingButtons}>
                  <Text style={styles.processingButtonText}>
                    {isLedgerFlow ? 'Waiting for Ledger...' : 'Please wait...'}
                  </Text>
                </View>
              )
            ) : biometricAuthenticated ? (
              <>
                <TouchableOpacity
                  style={[styles.button, styles.cancelButton]}
                  onPress={handleBiometricCancel}
                  disabled={isAuthenticating}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.button, styles.confirmButton]}
                  onPress={handleBiometricConfirm}
                  disabled={isAuthenticating}
                >
                  <Text style={styles.confirmButtonText}>Confirm</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity
                style={[styles.button, styles.cancelButton]}
                onPress={handleCancel}
                disabled={isAuthenticating}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
            )}
          </View>

          {attempts > 0 && (
            <Text style={styles.attemptsText}>
              Failed attempts: {attempts}/{MAX_ATTEMPTS}
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: theme.colors.overlay,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    modal: {
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      width: '100%',
      maxWidth: 400,
      maxHeight: '80%',
      ...theme.shadows.lg,
    },
    header: {
      alignItems: 'center',
      marginBottom: theme.spacing.xxl,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    message: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    loadingContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xxl,
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.primary,
      marginTop: theme.spacing.md,
    },
    pinContainer: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    pinDot: {
      width: 12,
      height: 12,
      borderRadius: 6,
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
      marginBottom: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    biometricText: {
      fontSize: 14,
      color: theme.colors.primary,
      marginTop: 6,
      fontWeight: '500',
    },
    keypad: {
      alignItems: 'center',
      marginBottom: theme.spacing.lg,
    },
    keypadRow: {
      flexDirection: 'row',
      marginBottom: theme.spacing.lg,
    },
    keypadButton: {
      width: 50,
      height: 50,
      borderRadius: 25,
      backgroundColor: theme.colors.surface,
      marginHorizontal: theme.spacing.lg,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    keypadButtonText: {
      fontSize: 18,
      fontWeight: '500',
      color: theme.colors.text,
    },
    lockoutContainer: {
      marginBottom: theme.spacing.lg,
      paddingHorizontal: theme.spacing.sm,
    },
    lockoutText: {
      fontSize: 12,
      color: theme.colors.error,
      textAlign: 'center',
      lineHeight: 16,
    },
    confirmationContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xxl,
    },
    confirmationTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.success,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    confirmationMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    processingContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xxl,
    },
    processingTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.primary,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    processingMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    processingButtons: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.md,
    },
    processingButtonText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      fontStyle: 'italic',
    },
    buttonContainer: {
      marginTop: theme.spacing.sm,
      flexDirection: 'row',
      gap: theme.spacing.md,
    },
    button: {
      flex: 1,
      paddingVertical: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    cancelButtonText: {
      color: theme.colors.textSecondary,
      fontSize: 16,
      fontWeight: '600',
    },
    confirmButton: {
      backgroundColor: theme.colors.primary,
    },
    confirmButtonText: {
      color: theme.colors.buttonText,
      fontSize: 16,
      fontWeight: '600',
    },
    attemptsText: {
      fontSize: 12,
      color: theme.colors.error,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
    },
    errorTitle: {
      color: theme.colors.error,
    },
    deviceStatusContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      marginTop: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
    },
    deviceStatusIndicator: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    deviceConnected: {
      backgroundColor: theme.colors.success,
    },
    deviceDisconnected: {
      backgroundColor: theme.colors.warning,
    },
    deviceStatusText: {
      fontSize: 12,
      color: theme.colors.textSecondary,
    },
  });
