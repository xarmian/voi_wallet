import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  simpleLedgerManager,
  LedgerConnectionState,
  LedgerError,
  LedgerStateChange,
} from '@/services/ledger/simpleLedgerManager';

export interface UnifiedLedgerSigningModalProps {
  visible: boolean;
  onCancel: () => void;
  onSuccess: () => void;
  onError: (error: Error) => void;
  title?: string;
  message?: string;
  deviceId?: string;
  // Progress tracking for multi-transaction signing
  signingProgress?: {
    current: number;
    total: number;
    message?: string;
  };
}

type ModalState =
  | 'connecting'        // Finding and connecting to device
  | 'verifying'         // Checking device is unlocked and has right app
  | 'ready'             // Device ready for signing
  | 'signing'           // Transaction signing in progress
  | 'error'             // Error occurred
  | 'success';          // Operation completed successfully

interface UIState {
  modalState: ModalState;
  ledgerState: LedgerConnectionState;
  errorInfo?: {
    type: LedgerError;
    message: string;
    retryable: boolean;
    userAction?: string;
  };
  canRetry: boolean;
  showTroubleshooting: boolean;
}

const UnifiedLedgerSigningModal: React.FC<UnifiedLedgerSigningModalProps> = ({
  visible,
  onCancel,
  onSuccess,
  onError,
  title = 'Sign with Ledger',
  message = 'Use your Ledger device to sign this transaction',
  deviceId,
  signingProgress,
}) => {
  const { theme } = useTheme();
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);

  const [uiState, setUIState] = useState<UIState>({
    modalState: 'connecting',
    ledgerState: 'disconnected',
    canRetry: false,
    showTroubleshooting: false,
  });

  const [autoRetryCount, setAutoRetryCount] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);

  // Subscribe to ledger state changes
  useEffect(() => {
    if (!visible) return;

    const unsubscribe = simpleLedgerManager.onStateChange(handleLedgerStateChange);
    return unsubscribe;
  }, [visible]);

  // Auto-start connection when modal becomes visible
  useEffect(() => {
    if (visible) {
      startConnection();
    } else {
      // Reset state when modal closes
      setUIState({
        modalState: 'connecting',
        ledgerState: 'disconnected',
        canRetry: false,
        showTroubleshooting: false,
      });
      setAutoRetryCount(0);
      setIsRetrying(false);
    }
  }, [visible]);

  const handleLedgerStateChange = useCallback((stateChange: LedgerStateChange) => {
    setUIState(prevState => {
      const newState = { ...prevState };
      newState.ledgerState = stateChange.state;

      switch (stateChange.state) {
        case 'discovering':
          newState.modalState = 'connecting';
          newState.canRetry = false;
          break;

        case 'connecting':
          newState.modalState = 'connecting';
          newState.canRetry = false;
          break;

        case 'ready':
          newState.modalState = 'ready';
          newState.canRetry = false;
          newState.errorInfo = undefined;
          // Automatically start device verification
          setTimeout(() => verifyDeviceReady(), 500);
          break;

        case 'signing':
          newState.modalState = 'signing';
          newState.canRetry = false;
          break;

        case 'error':
          newState.modalState = 'error';
          newState.errorInfo = stateChange.error;
          newState.canRetry = stateChange.error?.retryable || false;

          // Auto-retry for certain errors
          if (shouldAutoRetry(stateChange.error?.type)) {
            setTimeout(() => handleAutoRetry(stateChange.error?.type), 2000);
          }
          break;

        case 'disconnected':
          if (newState.modalState === 'signing') {
            // Device disconnected during signing - this is recoverable
            newState.modalState = 'error';
            newState.errorInfo = {
              type: 'connection_failed',
              message: 'Device disconnected during signing',
              retryable: true,
              userAction: 'Please reconnect your device and try again',
            };
            newState.canRetry = true;
          }
          break;
      }

      return newState;
    });
  }, []);

  const startConnection = async () => {
    try {
      setUIState(prev => ({ ...prev, modalState: 'connecting' }));
      await simpleLedgerManager.connect(deviceId);
    } catch (error) {
      console.error('Connection failed:', error);
      // Error will be handled by state change listener
    }
  };

  const verifyDeviceReady = async () => {
    try {
      setUIState(prev => ({ ...prev, modalState: 'verifying' }));
      const isReady = await simpleLedgerManager.verifyDeviceReady();

      if (isReady) {
        setUIState(prev => ({ ...prev, modalState: 'ready' }));
        onSuccess();
      }
      // If not ready, error will be set by the manager
    } catch (error) {
      console.error('Device verification failed:', error);
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const shouldAutoRetry = (errorType?: LedgerError): boolean => {
    if (!errorType || autoRetryCount >= 3) return false;

    switch (errorType) {
      case 'device_locked':
      case 'app_not_open':
      case 'connection_failed':
        return true;
      default:
        return false;
    }
  };

  const handleAutoRetry = async (errorType?: LedgerError) => {
    if (isRetrying || autoRetryCount >= 3) return;

    setIsRetrying(true);
    setAutoRetryCount(prev => prev + 1);

    try {
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (errorType === 'device_locked' || errorType === 'app_not_open') {
        // For these errors, just verify again
        await verifyDeviceReady();
      } else {
        // For connection errors, reconnect
        await simpleLedgerManager.retry();
      }
    } catch (error) {
      console.error('Auto-retry failed:', error);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleManualRetry = async () => {
    setIsRetrying(true);
    setAutoRetryCount(0); // Reset auto-retry count for manual retries

    try {
      await simpleLedgerManager.retry();
    } catch (error) {
      console.error('Manual retry failed:', error);
    } finally {
      setIsRetrying(false);
    }
  };

  const getStatusDisplay = () => {
    switch (uiState.modalState) {
      case 'connecting':
        return {
          icon: 'search' as const,
          title: 'Finding Ledger Device',
          message: 'Looking for your Ledger device. Please ensure it\'s connected and unlocked.',
          color: colors.primary,
          showProgress: true,
        };

      case 'verifying':
        return {
          icon: 'shield-checkmark' as const,
          title: 'Verifying Device',
          message: 'Checking that your Ledger is unlocked and the Algorand app is open.',
          color: colors.primary,
          showProgress: true,
        };

      case 'ready':
        return {
          icon: 'checkmark-circle' as const,
          title: 'Device Ready',
          message: 'Your Ledger device is ready for signing.',
          color: colors.success,
          showProgress: false,
        };

      case 'signing':
        const progressMessage = signingProgress
          ? `Signing transaction ${signingProgress.current} of ${signingProgress.total}`
          : 'Please approve the transaction on your Ledger device';

        return {
          icon: 'checkmark-circle' as const,
          title: 'Confirm on Ledger',
          message: progressMessage,
          color: colors.primary,
          showProgress: true,
        };

      case 'error':
        return {
          icon: 'alert-circle' as const,
          title: getErrorTitle(uiState.errorInfo?.type),
          message: uiState.errorInfo?.message || 'An error occurred',
          color: colors.error,
          showProgress: false,
        };

      case 'success':
        return {
          icon: 'checkmark-circle' as const,
          title: 'Transaction Signed',
          message: 'Transaction has been successfully signed.',
          color: colors.success,
          showProgress: false,
        };

      default:
        return {
          icon: 'hardware-chip' as const,
          title: 'Initializing',
          message: 'Preparing Ledger connection...',
          color: colors.primary,
          showProgress: true,
        };
    }
  };

  const getErrorTitle = (errorType?: LedgerError): string => {
    switch (errorType) {
      case 'device_locked':
        return 'Unlock Your Ledger';
      case 'app_not_open':
        return 'Open Algorand App';
      case 'device_not_found':
        return 'Connect Your Ledger';
      case 'connection_failed':
        return 'Connection Failed';
      case 'permission_denied':
        return 'Permissions Required';
      default:
        return 'Error';
    }
  };

  const renderActionButtons = () => {
    const buttons: JSX.Element[] = [];

    // Always show cancel button
    buttons.push(
      <TouchableOpacity
        key="cancel"
        style={[styles.button, styles.cancelButton]}
        onPress={onCancel}
      >
        <Text style={styles.cancelButtonText}>Cancel</Text>
      </TouchableOpacity>
    );

    // Show retry button for retryable errors
    if (uiState.canRetry && uiState.modalState === 'error') {
      buttons.push(
        <TouchableOpacity
          key="retry"
          style={[styles.button, styles.retryButton]}
          onPress={handleManualRetry}
          disabled={isRetrying}
        >
          {isRetrying ? (
            <ActivityIndicator size="small" color={colors.buttonText} />
          ) : (
            <Text style={styles.retryButtonText}>Try Again</Text>
          )}
        </TouchableOpacity>
      );
    }

    // Show troubleshooting toggle for errors
    if (uiState.modalState === 'error') {
      buttons.push(
        <TouchableOpacity
          key="help"
          style={[styles.button, styles.helpButton]}
          onPress={() => setUIState(prev => ({
            ...prev,
            showTroubleshooting: !prev.showTroubleshooting
          }))}
        >
          <Text style={styles.helpButtonText}>
            {uiState.showTroubleshooting ? 'Hide Help' : 'Need Help?'}
          </Text>
        </TouchableOpacity>
      );
    }

    return (
      <View style={styles.buttonContainer}>
        {buttons}
      </View>
    );
  };

  const renderTroubleshootingSteps = () => {
    if (!uiState.showTroubleshooting || uiState.modalState !== 'error') {
      return null;
    }

    const steps = getTroubleshootingSteps(uiState.errorInfo?.type);

    return (
      <View style={styles.troubleshootingContainer}>
        <Text style={styles.troubleshootingTitle}>Troubleshooting Steps:</Text>
        {steps.map((step, index) => (
          <View key={index} style={styles.troubleshootingStep}>
            <Text style={styles.stepNumber}>{index + 1}.</Text>
            <Text style={styles.stepText}>{step}</Text>
          </View>
        ))}
      </View>
    );
  };

  const getTroubleshootingSteps = (errorType?: LedgerError): string[] => {
    switch (errorType) {
      case 'device_locked':
        return [
          'Press both buttons on your Ledger device to wake it up',
          'Enter your PIN to unlock the device',
          'Wait for the main menu to appear',
          'Try again'
        ];

      case 'app_not_open':
        return [
          'Navigate to the Algorand app on your Ledger device',
          'Press both buttons to open the app',
          'Wait for "Application is ready" message',
          'Try again'
        ];

      case 'device_not_found':
        return [
          'Check that your Ledger device is connected via USB or Bluetooth',
          'Make sure the device is powered on and unlocked',
          'For Bluetooth: Check that Bluetooth is enabled on your phone',
          'Try disconnecting and reconnecting the device'
        ];

      case 'connection_failed':
        return [
          'Check the connection between your device and Ledger',
          'Make sure no other apps are using the Ledger device',
          'Try restarting the Ledger device',
          'For Bluetooth: Try turning Bluetooth off and on'
        ];

      case 'permission_denied':
        return [
          'Open your device Settings app',
          'Find this app in the app list',
          'Enable Bluetooth permissions',
          'Restart this app and try again'
        ];

      default:
        return [
          'Check that your Ledger device is connected and unlocked',
          'Make sure the Algorand app is open on your Ledger',
          'Try restarting your Ledger device',
          'If the problem persists, restart this app'
        ];
    }
  };

  const statusDisplay = getStatusDisplay();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Text style={styles.message}>{message}</Text>
          </View>

          <View style={styles.statusContainer}>
            {statusDisplay.showProgress ? (
              <ActivityIndicator size="large" color={statusDisplay.color} />
            ) : (
              <Ionicons
                name={statusDisplay.icon}
                size={48}
                color={statusDisplay.color}
              />
            )}

            <Text style={[
              styles.statusTitle,
              { color: statusDisplay.color }
            ]}>
              {statusDisplay.title}
            </Text>

            <Text style={styles.statusMessage}>
              {statusDisplay.message}
            </Text>

            {uiState.errorInfo?.userAction && (
              <Text style={styles.userActionText}>
                {uiState.errorInfo.userAction}
              </Text>
            )}

            {signingProgress && uiState.modalState === 'signing' && (
              <View style={styles.progressContainer}>
                <Text style={styles.progressText}>
                  {signingProgress.message || `Step ${signingProgress.current} of ${signingProgress.total}`}
                </Text>
              </View>
            )}

            {autoRetryCount > 0 && isRetrying && (
              <Text style={styles.retryText}>
                Auto-retrying... (attempt {autoRetryCount}/3)
              </Text>
            )}
          </View>

          {renderTroubleshootingSteps()}
          {renderActionButtons()}
        </View>
      </View>
    </Modal>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: theme.colors.overlay,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.lg,
    },
    modal: {
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.xl,
      width: '100%',
      maxWidth: 420,
      maxHeight: '90%',
      ...theme.shadows.lg,
    },
    header: {
      alignItems: 'center',
      marginBottom: theme.spacing.xl,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.text,
      textAlign: 'center',
      marginBottom: theme.spacing.sm,
    },
    message: {
      fontSize: 15,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    statusContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
      minHeight: 200,
      justifyContent: 'center',
    },
    statusTitle: {
      fontSize: 18,
      fontWeight: '600',
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    statusMessage: {
      fontSize: 15,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: theme.spacing.sm,
    },
    userActionText: {
      fontSize: 14,
      color: theme.colors.primary,
      textAlign: 'center',
      fontWeight: '500',
      marginTop: theme.spacing.sm,
    },
    progressContainer: {
      marginTop: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
    },
    progressText: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    retryText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      fontStyle: 'italic',
    },
    troubleshootingContainer: {
      marginVertical: theme.spacing.lg,
      padding: theme.spacing.lg,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
    },
    troubleshootingTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    troubleshootingStep: {
      flexDirection: 'row',
      marginBottom: theme.spacing.sm,
      alignItems: 'flex-start',
    },
    stepNumber: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginRight: theme.spacing.sm,
      width: 20,
    },
    stepText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      flex: 1,
      lineHeight: 18,
    },
    buttonContainer: {
      flexDirection: 'row',
      gap: theme.spacing.md,
      marginTop: theme.spacing.lg,
    },
    button: {
      flex: 1,
      paddingVertical: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
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
    helpButton: {
      backgroundColor: theme.colors.background,
      borderWidth: 1,
      borderColor: theme.colors.primary,
      flex: 0.8,
    },
    helpButtonText: {
      color: theme.colors.primary,
      fontSize: 14,
      fontWeight: '500',
    },
  });

export default UnifiedLedgerSigningModal;