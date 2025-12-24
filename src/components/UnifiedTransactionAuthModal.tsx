import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  ScrollView,
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
  RemoteSignerStatus,
} from '@/services/auth/transactionAuthController';
import { UnifiedTransactionRequest } from '@/services/transactions/unifiedSigner';
import { AnimatedQRCode, AnimatedQRScanner } from '@/components/remoteSigner';
import { RemoteSignerService } from '@/services/remoteSigner';
import { isRemoteSignerResponse, RemoteSignerResponse } from '@/types/remoteSigner';

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
  const [isVerifying, setIsVerifying] = useState(false);

  // Guard to prevent onComplete from being called multiple times per auth flow
  // This prevents double-submission when the onComplete prop reference changes during re-renders
  const hasCalledOnComplete = useRef(false);

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
  // The hasCalledOnComplete guard prevents double-calls when onComplete prop reference changes
  useEffect(() => {
    if (authState.state === 'completed' && authState.result && !hasCalledOnComplete.current) {
      hasCalledOnComplete.current = true;
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
      hasCalledOnComplete.current = false;
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
    setIsVerifying(true);
    try {
      const success = await controller.authenticateWithPin(enteredPin);
      if (!success) {
        setPin('');
        vibrate(500);
      }
    } catch (error) {
      console.error('PIN authentication error:', error);
      setPin('');
    } finally {
      setIsVerifying(false);
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

  // Remote signer handlers
  const handleRemoteSignerScanResponse = useCallback(() => {
    controller.startRemoteSignerScan();
  }, [controller]);

  const handleRemoteSignerScanned = useCallback(async (data: string) => {
    try {
      // Decode the scanned data
      const payload = RemoteSignerService.decodePayload(data);

      if (!isRemoteSignerResponse(payload)) {
        console.error('Scanned data is not a valid remote signer response');
        return;
      }

      await controller.processRemoteSignerResponse(payload as RemoteSignerResponse);
    } catch (error) {
      console.error('Failed to process remote signer response:', error);
    }
  }, [controller]);

  const handleRemoteSignerCancel = useCallback(() => {
    controller.cancelRemoteSignerFlow();
    handleCancel();
  }, [controller, handleCancel]);

  const getRemoteSignerStatusDisplay = (status: RemoteSignerStatus) => {
    switch (status) {
      case 'displaying_request':
        return {
          icon: 'qr-code' as const,
          title: 'Scan with Signer Device',
          message: 'Use your air-gapped signer device to scan this QR code and sign the transaction.',
          color: theme.colors.primary,
        };
      case 'waiting_signature':
        return {
          icon: 'scan' as const,
          title: 'Scan Signed Response',
          message: 'After signing on your signer device, scan the response QR code below.',
          color: theme.colors.primary,
        };
      case 'processing_response':
        return {
          icon: 'hourglass' as const,
          title: 'Processing',
          message: 'Verifying and submitting your signed transaction...',
          color: theme.colors.primary,
        };
      case 'error':
        return {
          icon: 'alert-circle' as const,
          title: 'Signing Error',
          message: authState.remoteSignerError || 'Failed to complete remote signing.',
          color: theme.colors.error,
        };
      default:
        return {
          icon: 'qr-code' as const,
          title: 'Remote Signer',
          message: 'Preparing remote signing request...',
          color: theme.colors.primary,
        };
    }
  };

  const errorMessageLower = (
    authState.error?.message || authState.ledgerError || ''
  ).toLowerCase();

  const isUserRejectedError =
    authState.state === 'error' &&
    (errorMessageLower.includes('cancelled by user') ||
      errorMessageLower.includes('rejected on ledger'));

  const isRequestMismatchError =
    authState.state === 'error' &&
    errorMessageLower.includes('does not match');

  const getErrorTitle = () => {
    if (isUserRejectedError) return 'Transaction Cancelled';
    if (isRequestMismatchError) return 'Wrong QR Code';
    return 'Transaction Failed';
  };

  const getErrorMessage = () => {
    if (isUserRejectedError) {
      return 'You rejected this transaction on your Ledger device.';
    }
    if (isRequestMismatchError) {
      return 'The signed QR code you scanned does not match the transaction you sent for signing. Please scan the correct response from your signer device.';
    }
    return authState.error?.message || authState.ledgerError || 'An unknown error occurred.';
  };

  useEffect(() => {
    if (
      authState.state === 'error' &&
      !isUserRejectedError &&
      (authState.error || authState.ledgerError) &&
      !hasCalledOnComplete.current
    ) {
      hasCalledOnComplete.current = true;
      const err =
        authState.error ||
        new Error(authState.ledgerError || 'Transaction failed');
      onComplete(false, { error: err });
      controller.resetAfterDismiss();
    }
  }, [authState.state, authState.error, authState.ledgerError, isUserRejectedError, onComplete, controller]);

  const renderPinDots = () => {
    return (
      <View style={styles.pinDots}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <View
            key={i}
            style={[
              styles.pinDot,
              i < pin.length && styles.pinDotFilled,
              { backgroundColor: i < pin.length ? theme.colors.primary : 'transparent' },
            ]}
          />
        ))}
      </View>
    );
  };

  const renderKeypad = () => {
    // Use SignerAuthModal-style keypad with integrated biometric button
    const rows = [
      ['1', '2', '3'],
      ['4', '5', '6'],
      ['7', '8', '9'],
      ['bio', '0', 'del'],
    ];

    return (
      <View style={styles.numberPad}>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={styles.numberRow}>
            {row.map((key) => {
              if (key === 'bio') {
                if (!authState.biometricAvailable) {
                  return <View key={key} style={styles.numberButton} />;
                }
                return (
                  <TouchableOpacity
                    key={key}
                    style={styles.numberButton}
                    onPress={handleBiometricAuth}
                    disabled={authState.isLocked || authState.state !== 'authenticating'}
                  >
                    <Ionicons
                      name="finger-print"
                      size={28}
                      color={authState.isLocked ? theme.colors.textMuted : theme.colors.primary}
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
                    disabled={authState.isLocked || authState.state !== 'authenticating'}
                  >
                    <Ionicons
                      name="backspace-outline"
                      size={24}
                      color={authState.isLocked ? theme.colors.textMuted : theme.colors.text}
                    />
                  </TouchableOpacity>
                );
              }

              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.numberButton, styles.numberButtonWithBg]}
                  onPress={() => handleNumberPress(key)}
                  disabled={authState.isLocked || authState.state !== 'authenticating'}
                >
                  <Text
                    style={[
                      styles.numberText,
                      authState.isLocked && styles.numberTextDisabled,
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

  // Render remote signer content
  const renderRemoteSignerContent = () => {
    const remoteDisplay = getRemoteSignerStatusDisplay(authState.remoteSignerStatus);

    // Show QR scanner when waiting for signature
    if (authState.remoteSignerStatus === 'waiting_signature') {
      return (
        <View style={styles.remoteSignerContainer}>
          <Text style={styles.remoteSignerTitle}>{remoteDisplay.title}</Text>
          <Text style={styles.remoteSignerMessage}>{remoteDisplay.message}</Text>
          <View style={styles.scannerContainer}>
            <AnimatedQRScanner
              onScan={handleRemoteSignerScanned}
              onError={(error) => console.error('Remote signer scan error:', error)}
              instructionsText="Scan the signed response from your signer device"
              showProgress={true}
              compact={true}
            />
          </View>
        </View>
      );
    }

    // Show processing state
    if (authState.remoteSignerStatus === 'processing_response') {
      return (
        <View style={styles.processingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.processingTitle}>{remoteDisplay.title}</Text>
          <Text style={styles.processingMessage}>{remoteDisplay.message}</Text>
        </View>
      );
    }

    // Show error state
    if (authState.remoteSignerStatus === 'error') {
      return (
        <View style={styles.errorContainer}>
          <Ionicons name="alert-circle" size={48} color={theme.colors.error} />
          <Text style={styles.errorTitle}>{remoteDisplay.title}</Text>
          <Text style={styles.errorMessage}>{remoteDisplay.message}</Text>
        </View>
      );
    }

    // Default: Show QR code for signer to scan (displaying_request)
    const qrData = authState.remoteSignerRequest
      ? RemoteSignerService.encodePayload(authState.remoteSignerRequest)
      : null;

    return (
      <View style={styles.remoteSignerContainer}>
        <Text style={styles.remoteSignerTitle}>{remoteDisplay.title}</Text>
        <Text style={styles.remoteSignerMessage}>{remoteDisplay.message}</Text>

        {qrData ? (
          <View style={styles.qrWrapper}>
            <AnimatedQRCode
              data={qrData}
              size={180}
              showControls={true}
              showFrameCounter={true}
            />
          </View>
        ) : (
          <View style={styles.loadingQR}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={styles.loadingQRText}>Preparing QR code...</Text>
          </View>
        )}

        {/* Instructions for the signer flow */}
        <View style={styles.remoteSignerInstructions}>
          <View style={styles.instructionStep}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>1</Text>
            </View>
            <Text style={styles.stepText}>Scan this QR with your signer device</Text>
          </View>
          <View style={styles.instructionStep}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>2</Text>
            </View>
            <Text style={styles.stepText}>Review and sign on the signer</Text>
          </View>
          <View style={styles.instructionStep}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>3</Text>
            </View>
            <Text style={styles.stepText}>Tap "Scan Response" below</Text>
          </View>
        </View>
      </View>
    );
  };

  const renderContent = () => {
    switch (authState.state) {
      case 'authenticating':
        // Remote signer flow - show QR immediately (no PIN required)
        if (authState.isRemoteSignerFlow) {
          return renderRemoteSignerContent();
        }

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

        // Standard PIN/biometric now uses bottom sheet, so this shouldn't be reached
        // Keep as fallback just in case
        return (
          <>
            {renderPinDots()}
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
        // Remote signer uses the same content rendering for signing state
        if (authState.isRemoteSignerFlow) {
          return renderRemoteSignerContent();
        }

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
    // Remote signer flow buttons
    if (authState.isRemoteSignerFlow) {
      // Show different buttons based on remote signer status
      if (authState.remoteSignerStatus === 'displaying_request') {
        return (
          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={handleRemoteSignerCancel}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.primaryButton]}
              onPress={handleRemoteSignerScanResponse}
            >
              <Ionicons name="scan-outline" size={18} color={theme.colors.buttonText} style={{ marginRight: 6 }} />
              <Text style={styles.primaryButtonText}>Scan Response</Text>
            </TouchableOpacity>
          </View>
        );
      }

      if (authState.remoteSignerStatus === 'waiting_signature') {
        return (
          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={handleRemoteSignerCancel}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        );
      }

      if (authState.remoteSignerStatus === 'error') {
        return (
          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={handleRemoteSignerCancel}
            >
              <Text style={styles.cancelButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        );
      }

      // No buttons during processing
      return null;
    }

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


  // Use bottom sheet style for standard PIN/biometric auth, centered modal for other flows
  const useBottomSheet = authState.state === 'authenticating' &&
    !authState.isLedgerFlow &&
    !authState.isRemoteSignerFlow;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={useBottomSheet ? 'slide' : 'fade'}
      onRequestClose={() => {
        // Only allow closing if not processing
        if (authState.state !== 'processing' && authState.state !== 'signing') {
          setUserCancelled(true); // Mark as cancelled even if closed via system
          handleCancel();
        }
      }}
    >
      <View style={useBottomSheet ? styles.bottomSheetOverlay : styles.overlay}>
        <View style={useBottomSheet ? styles.bottomSheetContainer : styles.modal}>
          {useBottomSheet ? (
            // Bottom sheet header for PIN entry
            <>
              <View style={styles.bottomSheetHeader}>
                <TouchableOpacity style={styles.bottomSheetCancelButton} onPress={handleCancel}>
                  <Text style={styles.bottomSheetCancelText}>Cancel</Text>
                </TouchableOpacity>
                <Text style={styles.bottomSheetTitle}>Authenticate</Text>
                <View style={styles.bottomSheetPlaceholder} />
              </View>
              <View style={styles.bottomSheetContent}>
                <View style={styles.bottomSheetIconContainer}>
                  <Ionicons
                    name="lock-closed-outline"
                    size={48}
                    color={theme.colors.primary}
                  />
                </View>
                <Text style={styles.bottomSheetMessage}>{message}</Text>
                {isVerifying && (
                  <ActivityIndicator
                    size="small"
                    color={theme.colors.primary}
                    style={styles.verifying}
                  />
                )}
                {authState.isLocked ? (
                  <Text style={styles.bottomSheetError}>
                    Too many attempts. Try again in 30 seconds.
                  </Text>
                ) : authState.pinAttempts > 0 ? (
                  <Text style={styles.bottomSheetError}>
                    Incorrect PIN. {authState.maxPinAttempts - authState.pinAttempts} attempts remaining.
                  </Text>
                ) : null}
                {renderPinDots()}
                {renderKeypad()}
              </View>
            </>
          ) : (
            // Original centered modal for Ledger, Remote Signer, and other states
            <>
              {!authState.isRemoteSignerFlow && (
                <View style={styles.header}>
                  <Ionicons
                    name="shield-checkmark"
                    size={32}
                    color={theme.colors.primary}
                  />
                  <Text style={styles.title}>{title}</Text>
                  <Text style={styles.message}>{message}</Text>
                </View>
              )}

              <ScrollView
                style={styles.content}
                contentContainerStyle={styles.contentContainer}
                showsVerticalScrollIndicator={true}
              >
                {renderContent()}
              </ScrollView>

              {renderButtons()}

              {authState.pinAttempts > 0 && authState.state === 'authenticating' && (
                <Text style={styles.attemptsText}>
                  Failed attempts: {authState.pinAttempts}/{authState.maxPinAttempts}
                </Text>
              )}
            </>
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
      flexGrow: 1,
      flexShrink: 1,
    },
    contentContainer: {
      minHeight: 200,
      justifyContent: 'center',
      paddingBottom: theme.spacing.md,
    },

    // Bottom sheet styles (for PIN entry)
    bottomSheetOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    bottomSheetContainer: {
      backgroundColor: theme.colors.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    },
    bottomSheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    bottomSheetCancelButton: {
      padding: 8,
    },
    bottomSheetCancelText: {
      fontSize: 16,
      color: theme.colors.primary,
    },
    bottomSheetTitle: {
      fontSize: 17,
      fontWeight: '600',
      color: theme.colors.text,
    },
    bottomSheetPlaceholder: {
      width: 60,
    },
    bottomSheetContent: {
      alignItems: 'center',
      paddingTop: 24,
      paddingHorizontal: 20,
    },
    bottomSheetIconContainer: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: theme.colors.primary + '15',
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 16,
    },
    bottomSheetMessage: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 24,
      textAlign: 'center',
    },
    bottomSheetError: {
      fontSize: 14,
      color: theme.colors.error,
      textAlign: 'center',
      marginBottom: 16,
    },
    verifying: {
      marginBottom: 8,
    },

    // PIN dots (shared style)
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

    // Number pad (SignerAuthModal style)
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
    primaryButton: {
      backgroundColor: theme.colors.primary,
      flexDirection: 'row',
      justifyContent: 'center',
    },
    primaryButtonText: {
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

    // Remote signer styles
    remoteSignerContainer: {
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
    },
    remoteSignerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
      textAlign: 'center',
    },
    remoteSignerMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
    },
    qrWrapper: {
      alignItems: 'center',
      marginVertical: theme.spacing.md,
    },
    loadingQR: {
      alignItems: 'center',
      justifyContent: 'center',
      height: 200,
      gap: theme.spacing.md,
    },
    loadingQRText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    remoteSignerInstructions: {
      width: '100%',
      marginTop: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
    },
    instructionStep: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
    },
    stepNumber: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: theme.colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.sm,
    },
    stepNumberText: {
      fontSize: 12,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    stepText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.text,
    },
    scannerContainer: {
      width: '100%',
      height: 450,
      borderRadius: theme.borderRadius.lg,
      overflow: 'hidden',
      marginVertical: theme.spacing.md,
    },
  });
