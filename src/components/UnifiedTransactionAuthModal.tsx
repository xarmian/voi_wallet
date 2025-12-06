import React, { useEffect, useState } from 'react';
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

// Cross-platform vibration helper
const vibrate = (duration: number) => {
  if (Platform.OS !== 'web') {
    const { Vibration } = require('react-native');
    Vibration.vibrate(duration);
  }
};
import {
  TransactionAuthController,
  TransactionAuthState_Interface,
  LedgerSigningStatus,
} from '@/services/auth/transactionAuthController';
import { UnifiedTransactionRequest } from '@/services/transactions/unifiedSigner';

interface UnifiedTransactionAuthModalProps {
  visible: boolean;
  controller: TransactionAuthController;
  request: UnifiedTransactionRequest | null;
  onComplete: (success: boolean, result?: any) => void;
  onCancel: () => void;
  title?: string;
  message?: string;
}

export default function UnifiedTransactionAuthModal({
  visible,
  controller,
  request,
  onComplete,
  onCancel,
  title = 'Transaction Authentication',
  message = 'Authenticate to complete this transaction',
}: UnifiedTransactionAuthModalProps) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [authState, setAuthState] = useState<TransactionAuthState_Interface>(controller.getState());
  const [pin, setPin] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [biometricAttempted, setBiometricAttempted] = useState(false);
  const [userCancelled, setUserCancelled] = useState(false);

  // Subscribe to controller state changes
  useEffect(() => {
    const unsubscribe = controller.subscribe(setAuthState);
    return unsubscribe;
  }, [controller]);

  // Initialize signing flow when modal becomes visible with a request (only once per open)
  // Do NOT restart after user rejection/error - only start on first open
  useEffect(() => {
    if (visible && request && authState.state === 'idle' && !initialized &&
        !userCancelled && (!authState.error && !authState.ledgerError)) { // Don't restart after errors or cancellation
      console.log('UnifiedTransactionAuthModal: initializeSigningFlow');
      controller.initializeSigningFlow(request);
      setInitialized(true);
    }
  }, [visible, request, controller, authState.state, initialized, userCancelled, authState.error, authState.ledgerError]);

  // Handle completion state - wait for result to be populated before calling onComplete
  useEffect(() => {
    if (authState.state === 'completed' && authState.result) {
      onComplete(true, authState.result);
    }
  }, [authState.state, authState.result, onComplete]);

  // Reset controller when modal is hidden (after parent closes it)
  // Use a ref to track previous visibility and only reset on transition from visible to hidden
  const wasVisibleRef = React.useRef(visible);
  useEffect(() => {
    if (wasVisibleRef.current && !visible) {
      // Modal was just hidden - reset controller
      controller.resetAfterDismiss();
    }
    wasVisibleRef.current = visible;
  }, [visible, controller]);

  // Auto-prompt for biometric auth when available (only once per open)
  useEffect(() => {
    if (visible && authState.state === 'authenticating' &&
        authState.biometricAvailable && !authState.isLocked && !biometricAttempted && !authState.isLedgerFlow) {
      setBiometricAttempted(true);
      handleBiometricAuth();
    }
  }, [visible, authState.state, authState.biometricAvailable, authState.isLocked, biometricAttempted, authState.isLedgerFlow]);

  // Reset guards when modal closes or controller resets
  useEffect(() => {
    if (!visible || authState.state === 'idle') {
      setInitialized(false);
      setBiometricAttempted(false);
      setUserCancelled(false);
    }
  }, [visible, authState.state]);

  const handleNumberPress = (number: string) => {
    if (authState.isLocked || pin.length >= 6 || authState.state !== 'authenticating') return;

    const newPin = pin + number;
    setPin(newPin);

    if (newPin.length === 6) {
      handlePinSubmit(newPin);
    }
  };

  const handleBackspace = () => {
    if (authState.isLocked || authState.state !== 'authenticating') return;
    setPin(pin.slice(0, -1));
  };

  const handlePinSubmit = async (enteredPin: string) => {
    try {
      const success = await controller.authenticateWithPin(enteredPin);
      if (!success) {
        setPin('');
        vibrate(500);
      }
    } catch (error) {
      console.error('PIN authentication error:', error);
      setPin('');
    }
  };

  const handleBiometricAuth = async () => {
    try {
      await controller.authenticateWithBiometrics();
    } catch (error) {
      console.error('Biometric authentication error:', error);
    }
  };

  const handleCancel = () => {
    controller.cancel();
    controller.resetAfterDismiss();
    setPin('');
    setInitialized(false);
    setBiometricAttempted(false);
    setUserCancelled(true); // Mark that user explicitly cancelled
    onCancel();
  };

  const handleLedgerRetry = () => {
    controller.retryLedgerConnection();
  };

  const errorMessageLower = (
    authState.error?.message || authState.ledgerError || ''
  ).toLowerCase();

  const isUserRejectedError =
    authState.state === 'error' &&
    (errorMessageLower.includes('cancelled by user') ||
      errorMessageLower.includes('rejected on ledger'));

  const getErrorTitle = () =>
    isUserRejectedError ? 'Transaction Cancelled' : 'Transaction Failed';

  const getErrorMessage = () => {
    if (isUserRejectedError) {
      return 'You rejected this transaction on your Ledger device.';
    }
    return authState.error?.message || authState.ledgerError || 'An unknown error occurred.';
  };

  useEffect(() => {
    if (
      authState.state === 'error' &&
      !isUserRejectedError &&
      (authState.error || authState.ledgerError)
    ) {
      const err =
        authState.error ||
        new Error(authState.ledgerError || 'Transaction failed');
      onComplete(false, { error: err });
      controller.resetAfterDismiss();
    }
  }, [authState.state, authState.error, authState.ledgerError, isUserRejectedError, onComplete, controller]);

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
                    disabled={authState.isLocked || authState.state !== 'authenticating'}
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
                  disabled={authState.isLocked || authState.state !== 'authenticating'}
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

  const getLedgerStatusDisplay = (status: LedgerSigningStatus) => {
    // Check if device is actually connected and powered on
    const deviceConnected = authState.ledgerDevice?.connected || false;

    switch (status) {
      case 'searching':
        return {
          icon: 'search' as const,
          title: 'Searching for Ledger',
          message: deviceConnected
            ? 'Please unlock your Ledger device and open the Algorand app...'
            : 'Looking for your Ledger device. Please unlock it and open the Algorand app...',
          color: theme.colors.primary,
        };
      case 'connecting':
        return {
          icon: 'link' as const,
          title: 'Connecting to Ledger',
          message: 'Connecting to your Ledger device. Please ensure it is unlocked and the Algorand app is open.',
          color: theme.colors.primary,
        };
      case 'app_required':
        return {
          icon: 'apps' as const,
          title: 'Open Algorand App',
          message: 'Please open the Algorand application on your Ledger device.',
          color: theme.colors.primary,
        };
      case 'ready':
        return {
          icon: 'checkmark-circle' as const,
          title: 'Ledger Ready',
          message: 'Your Ledger device is ready. Preparing transaction...',
          color: theme.colors.success,
        };
      case 'device_locked':
        return {
          icon: 'lock-closed' as const,
          title: 'Unlock Ledger',
          message: 'Please unlock your Ledger device to continue.',
          color: theme.colors.primary,
        };
      case 'waiting_confirmation':
        return {
          icon: 'checkmark-circle' as const,
          title: 'Confirm on Ledger',
          message: authState.signingProgress
            ? authState.signingProgress.message || 'Please review and approve the transaction on your Ledger device.'
            : 'Please review and approve the transaction on your Ledger device.',
          color: theme.colors.primary,
        };
      case 'error':
        return {
          icon: 'link' as const,
          title: 'Connecting to Ledger',
          message: authState.ledgerError || 'Trying to connect to your Ledger device. Please ensure it is connected, unlocked, and the Algorand app is open.',
          color: theme.colors.primary,
        };
      default:
        return {
          icon: 'hardware-chip' as const,
          title: 'Initializing Ledger',
          message: 'Preparing Ledger connection...',
          color: theme.colors.primary,
        };
    }
  };

  const renderContent = () => {
    switch (authState.state) {
      case 'authenticating':
        if (authState.isLedgerFlow) {
          // Always show Ledger status flow for Ledger accounts (never PIN/biometric)
          const ledgerDisplay = getLedgerStatusDisplay(authState.ledgerStatus);
          return (
            <View style={styles.ledgerContainer}>
              <Ionicons
                name={ledgerDisplay.icon}
                size={48}
                color={ledgerDisplay.color}
              />
              <Text style={[
                styles.ledgerTitle,
                authState.ledgerStatus === 'error' && styles.errorTitle
              ]}>
                {ledgerDisplay.title}
              </Text>
              <Text style={styles.ledgerMessage}>
                {ledgerDisplay.message}
              </Text>

              {authState.ledgerDevice && (
                <View style={styles.deviceStatusContainer}>
                  <View style={[
                    styles.deviceStatusIndicator,
                    authState.ledgerDevice.connected
                      ? styles.deviceConnected
                      : styles.deviceDisconnected
                  ]} />
                  <Text style={styles.deviceStatusText}>
                    {authState.ledgerDevice.connected
                      ? `${authState.ledgerDevice.name} connected`
                      : `${authState.ledgerDevice.name} detected`
                    }
                  </Text>
                </View>
              )}
              {(authState.ledgerStatus === 'searching' || authState.ledgerStatus === 'connecting' || authState.ledgerStatus === 'app_required' || authState.ledgerStatus === 'device_locked') && (
                <View style={styles.buttonContainer}>
                  <TouchableOpacity
                    style={[styles.button, styles.cancelButton]}
                    onPress={handleCancel}
                  >
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        }

        // Show PIN/biometric authentication (non-Ledger only)
        return (
          <>
            {renderPinDots()}

            {authState.biometricAvailable && !authState.isLocked && (
              <TouchableOpacity
                style={styles.biometricButton}
                onPress={handleBiometricAuth}
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

            {authState.isLocked && (
              <View style={styles.lockoutContainer}>
                <Text style={styles.lockoutText}>
                  Authentication temporarily locked due to too many failed attempts
                </Text>
              </View>
            )}
          </>
        );

      case 'signing':
        if (authState.isLedgerFlow) {
          const ledgerDisplay = getLedgerStatusDisplay(authState.ledgerStatus);
          return (
            <View style={styles.processingContainer}>
              {/* Show different activity indicator based on status */}
              {(authState.ledgerStatus === 'searching' || authState.ledgerStatus === 'connecting') ? (
                <ActivityIndicator size="large" color={ledgerDisplay.color as any} />
              ) : (
                <Ionicons
                  name={ledgerDisplay.icon}
                  size={48}
                  color={ledgerDisplay.color}
                />
              )}
              <Text style={[
                styles.processingTitle,
                authState.ledgerStatus === 'error' && styles.errorTitle
              ]}>
                {ledgerDisplay.title}
              </Text>
              <Text style={styles.processingMessage}>
                {ledgerDisplay.message}
              </Text>

              {authState.signingProgress && authState.ledgerStatus === 'waiting_confirmation' && (
                <View style={styles.progressContainer}>
                  <Text style={styles.progressText}>
                    Step {authState.signingProgress.currentStep} of {authState.signingProgress.totalSteps}
                  </Text>
                </View>
              )}
            </View>
          );
        }

        return (
          <View style={styles.processingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.processingTitle}>Signing Transaction</Text>
            <Text style={styles.processingMessage}>
              Please wait while your transaction is being signed...
            </Text>
          </View>
        );

      case 'processing':
        return (
          <View style={styles.processingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.processingTitle}>Processing Transaction</Text>
            <Text style={styles.processingMessage}>
              Please wait while your transaction is being processed...
            </Text>
          </View>
        );

      case 'completed':
        return (
          <View style={styles.successContainer}>
            <Ionicons
              name="checkmark-circle"
              size={48}
              color={theme.colors.success}
            />
            <Text style={styles.successTitle}>Transaction Complete</Text>
            <Text style={styles.successMessage}>
              Your transaction has been successfully processed.
            </Text>
          </View>
        );

      case 'error':
        return (
          <View style={styles.errorContainer}>
            <Ionicons
              name={isUserRejectedError ? 'close-circle' : 'alert-circle'}
              size={48}
              color={theme.colors.error}
            />
            <Text style={styles.errorTitle}>{getErrorTitle()}</Text>
            <Text style={styles.errorMessage}>{getErrorMessage()}</Text>
          </View>
        );

      default:
        return (
          <View style={styles.processingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.processingTitle}>Initializing</Text>
            <Text style={styles.processingMessage}>
              Preparing transaction authentication...
            </Text>
          </View>
        );
    }
  };

  const handleCloseAfterError = () => {
    setUserCancelled(true);
    controller.resetAfterDismiss();
    onCancel();
  };

  const renderButtons = () => {
    if (authState.state === 'processing' || authState.state === 'signing') {
      if (authState.isLedgerFlow && (authState.ledgerStatus === 'error' || authState.ledgerStatus === 'app_required')) {
        return (
          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={handleCancel}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            {authState.ledgerStatus === 'error' && (
              <TouchableOpacity
                style={[styles.button, styles.retryButton]}
                onPress={handleLedgerRetry}
              >
                <Text style={styles.retryButtonText}>Try Again</Text>
              </TouchableOpacity>
            )}
          </View>
        );
      }

      // No buttons during active processing
      return null;
    }

    if (authState.state === 'completed') {
      return null;
    }

    if (authState.state === 'error') {
      return (
        <View style={styles.buttonContainer}>
          <TouchableOpacity
            style={[styles.button, styles.cancelButton]}
            onPress={handleCloseAfterError}
          >
            <Text style={styles.cancelButtonText}>
              {isUserRejectedError ? 'Close' : 'Dismiss'}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }

    // Default cancel button for authentication states
    // Suppress when Ledger-specific cancel is already shown in content
    if (
      authState.state === 'authenticating' &&
      authState.isLedgerFlow &&
      (authState.ledgerStatus === 'searching' ||
        authState.ledgerStatus === 'connecting' ||
        authState.ledgerStatus === 'app_required' ||
        authState.ledgerStatus === 'device_locked')
    ) {
      return null;
    }

    return (
      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, styles.cancelButton]}
          onPress={handleCancel}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  };


  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        // Only allow closing if not processing
        if (authState.state !== 'processing' && authState.state !== 'signing') {
          setUserCancelled(true); // Mark as cancelled even if closed via system
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

          <View style={styles.content}>
            {renderContent()}
          </View>

          {renderButtons()}

          {authState.pinAttempts > 0 && authState.state === 'authenticating' && (
            <Text style={styles.attemptsText}>
              Failed attempts: {authState.pinAttempts}/{authState.maxPinAttempts}
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
      maxHeight: '90%',
      ...theme.shadows.lg,
    },
    header: {
      alignItems: 'center',
      marginBottom: theme.spacing.xl,
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
    content: {
      minHeight: 200,
      justifyContent: 'center',
    },

    // PIN Input
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

    // Biometric
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

    // Keypad
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

    // States
    processingContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
    },
    processingTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.primary,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    processingMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },

    // Ledger
    ledgerContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
    },
    ledgerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.primary,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    ledgerMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
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
    progressContainer: {
      marginTop: theme.spacing.md,
      padding: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
    },
    progressText: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },

    // Success
    successContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
    },
    successTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.success,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    successMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },

    // Error
    errorContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
    },
    errorTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.error,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    errorMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },

    // Lockout
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

    // Buttons
    buttonContainer: {
      marginTop: theme.spacing.lg,
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
    retryButton: {
      backgroundColor: theme.colors.primary,
    },
    retryButtonText: {
      color: theme.colors.buttonText,
      fontSize: 16,
      fontWeight: '600',
    },

    // Attempts
    attemptsText: {
      fontSize: 12,
      color: theme.colors.error,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
    },
  });
