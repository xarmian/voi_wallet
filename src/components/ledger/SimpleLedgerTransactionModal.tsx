import React, { useCallback, useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useThemeColors } from '@/hooks/useThemedStyles';
import {
  SimpleLedgerAuthController,
  SimpleLedgerAuthStateData,
} from '@/services/auth/simpleLedgerAuthController';
import { UnifiedTransactionRequest } from '@/services/transactions/unifiedSigner';
import UnifiedLedgerSigningModal from './UnifiedLedgerSigningModal';

interface SimpleLedgerTransactionModalProps {
  visible: boolean;
  request: UnifiedTransactionRequest | null;
  onComplete: (success: boolean, result?: any) => void;
  onCancel: () => void;
  title?: string;
  message?: string;
}

/**
 * Simplified Ledger Transaction Modal
 * Replaces the complex UnifiedTransactionAuthModal with a much simpler implementation
 * Combines PIN/biometric auth with Ledger signing in a clean, unified experience
 */
export default function SimpleLedgerTransactionModal({
  visible,
  request,
  onComplete,
  onCancel,
  title = 'Sign Transaction',
  message = 'Use your Ledger device to sign this transaction',
}: SimpleLedgerTransactionModalProps) {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const [controller] = useState(() => new SimpleLedgerAuthController());
  const [authState, setAuthState] = useState<SimpleLedgerAuthStateData>(controller.getState());
  const [showLedgerModal, setShowLedgerModal] = useState(false);

  // Subscribe to controller state changes
  useEffect(() => {
    const unsubscribe = controller.subscribe(setAuthState);
    return unsubscribe;
  }, [controller]);

  // Handle state changes
  useEffect(() => {
    switch (authState.state) {
      case 'connecting':
      case 'verifying':
      case 'ready':
      case 'signing':
        setShowLedgerModal(true);
        break;

      case 'completed':
        if (authState.result) {
          onComplete(true, authState.result);
        }
        break;

      case 'error':
        // Keep Ledger modal open for retryable errors
        if (!authState.error?.retryable) {
          setShowLedgerModal(false);
          onComplete(false, { error: new Error(authState.error?.message || 'Unknown error') });
        }
        break;

      case 'idle':
        setShowLedgerModal(false);
        break;
    }
  }, [authState.state, authState.result, authState.error, onComplete]);

  // Initialize signing flow when modal becomes visible with a request
  useEffect(() => {
    if (visible && request && authState.state === 'idle') {
      controller.initializeSigningFlow(request);
    }
  }, [visible, request, controller, authState.state]);

  // Clean up when modal closes
  useEffect(() => {
    if (!visible) {
      controller.cancel();
      setShowLedgerModal(false);
    }
  }, [visible, controller]);

  const handleCancel = useCallback(() => {
    controller.cancel();
    setShowLedgerModal(false);
    onCancel();
  }, [controller, onCancel]);

  const handleLedgerSuccess = useCallback(() => {
    // Success will be handled by state change listener
  }, []);

  const handleLedgerError = useCallback((error: Error) => {
    console.error('Ledger signing error:', error);
    // Error will be handled by state change listener
  }, []);

  const getSigningProgress = () => {
    if (authState.signingProgress) {
      return {
        current: authState.signingProgress.current,
        total: authState.signingProgress.total,
        message: authState.signingProgress.message,
      };
    }
    return undefined;
  };

  // If we're not showing the main modal, don't render anything
  if (!visible) {
    return null;
  }

  return (
    <>
      {/* Main transaction modal - mostly hidden, just for structure */}
      <Modal
        visible={visible && !showLedgerModal}
        transparent
        animationType="fade"
        onRequestClose={handleCancel}
      >
        <View style={styles.overlay}>
          <View style={styles.modal}>
            <View style={styles.content}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.title}>Preparing Transaction</Text>
              <Text style={styles.message}>Setting up Ledger signing...</Text>
            </View>

            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={handleCancel}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Ledger signing modal */}
      <UnifiedLedgerSigningModal
        visible={showLedgerModal}
        title={title}
        message={message}
        onCancel={handleCancel}
        onSuccess={handleLedgerSuccess}
        onError={handleLedgerError}
        signingProgress={getSigningProgress()}
      />
    </>
  );
}

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
      maxWidth: 400,
      ...theme.shadows.lg,
    },
    content: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
      minHeight: 150,
      justifyContent: 'center',
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    message: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    button: {
      paddingVertical: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: theme.spacing.lg,
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
  });