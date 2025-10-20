import React from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { LedgerDeviceInfo } from '@/services/ledger/transport';
import { Theme } from '@/constants/themes';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';

export interface SigningPromptProps {
  visible: boolean;
  device?: LedgerDeviceInfo | null;
  onConnectDevice?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  isAwaitingConfirmation?: boolean;
  isError?: boolean;
  title?: string;
  message?: string;
  errorMessage?: string;
  showConnectDeviceButton?: boolean;
  showRetryButton?: boolean;
}

const SigningPrompt: React.FC<SigningPromptProps> = ({
  visible,
  device,
  onConnectDevice,
  onCancel,
  onRetry,
  isAwaitingConfirmation = false,
  isError = false,
  title = 'Confirm on Ledger',
  message = 'Follow the instructions on your Ledger device to review and approve the transaction.',
  errorMessage,
  showConnectDeviceButton = false,
  showRetryButton = false,
}) => {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const connectionLabel = device
    ? device.connected
      ? 'Ledger device connected'
      : 'Ledger device detected – connecting...'
    : 'Waiting for Ledger device...';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel ?? (() => {})}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          <Text style={[styles.title, isError && styles.errorTitle]}>{title}</Text>
          <Text style={styles.message}>{message}</Text>

          {isError && errorMessage ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorText}>{errorMessage}</Text>
            </View>
          ) : (
            <View style={styles.statusContainer}>
              <View
                style={[
                  styles.statusIndicator,
                  device?.connected
                    ? styles.statusConnected
                    : styles.statusDisconnected,
                ]}
              />
              <Text style={styles.statusText}>{connectionLabel}</Text>
            </View>
          )}

          {isAwaitingConfirmation && !isError ? (
            <View style={styles.waitingContainer}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.waitingText}>
                Waiting for confirmation on Ledger...
              </Text>
            </View>
          ) : null}

          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={onCancel ?? (() => {})}
            >
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>

            {showRetryButton && onRetry ? (
              <TouchableOpacity
                style={[styles.button, styles.primaryButton]}
                onPress={onRetry}
              >
                <Text style={styles.primaryButtonText}>Try Again</Text>
              </TouchableOpacity>
            ) : showConnectDeviceButton && onConnectDevice ? (
              <TouchableOpacity
                style={[styles.button, styles.primaryButton]}
                onPress={onConnectDevice}
              >
                <Text style={styles.primaryButtonText}>
                  {device?.connected ? 'Reconnect' : 'Connect Device'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
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
    container: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.xl,
      gap: theme.spacing.lg,
      ...theme.shadows.lg,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.text,
      textAlign: 'center',
    },
    message: {
      fontSize: 15,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    statusContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
    },
    statusIndicator: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    statusConnected: {
      backgroundColor: theme.colors.success,
    },
    statusDisconnected: {
      backgroundColor: theme.colors.warning,
    },
    statusText: {
      fontSize: 14,
      color: theme.colors.text,
    },
    waitingContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
    },
    waitingText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    buttonRow: {
      flexDirection: 'row',
      gap: theme.spacing.md,
    },
    button: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: theme.borderRadius.lg,
      paddingVertical: theme.spacing.md,
    },
    primaryButton: {
      backgroundColor: theme.colors.primary,
    },
    primaryButtonText: {
      color: theme.colors.buttonText,
      fontWeight: '600',
    },
    secondaryButton: {
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    secondaryButtonText: {
      color: theme.colors.text,
      fontWeight: '600',
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    errorTitle: {
      color: theme.colors.error,
    },
    errorContainer: {
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255, 59, 48, 0.1)'
          : 'rgba(255, 69, 58, 0.22)',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginVertical: theme.spacing.sm,
    },
    errorText: {
      color: theme.colors.error,
      fontSize: 14,
      textAlign: 'center',
      lineHeight: 18,
    },
  });

export default SigningPrompt;
