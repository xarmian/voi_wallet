/**
 * Signature Display Screen (Signer Mode)
 *
 * This screen displays the signed transaction as a QR code
 * for the wallet device to scan. Authentication is handled
 * by the TransactionReviewScreen before navigating here.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useRemoteSignerStore } from '@/store/remoteSignerStore';
import { useWalletStore } from '@/store/walletStore';
import { RemoteSignerService } from '@/services/remoteSigner';
import { AccountSecureStorage } from '@/services/secure';
import {
  RemoteSignerRequest,
  RemoteSignerResponse,
} from '@/types/remoteSigner';
import { AccountType, AccountMetadata } from '@/types/wallet';
import { AnimatedQRCode } from '@/components/remoteSigner';
import algosdk from 'algosdk';

// Cross-platform alert helper
const showAlert = (
  title: string,
  message: string,
  buttons?: Array<{ text: string; onPress?: () => void; style?: string }>
) => {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 1) {
      const confirmed = window.confirm(`${title}\n\n${message}`);
      if (confirmed) {
        const confirmButton = buttons.find((b) => b.style !== 'cancel') || buttons[0];
        confirmButton?.onPress?.();
      } else {
        const cancelButton = buttons.find((b) => b.style === 'cancel');
        cancelButton?.onPress?.();
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

type RouteParams = {
  SignatureDisplay: {
    request: RemoteSignerRequest;
    pin?: string; // Optional PIN (undefined if biometric auth was used)
  };
};

type ScreenState = 'signing' | 'display' | 'error';

export default function SignatureDisplayScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation<any>();
  const route = useRoute<RouteProp<RouteParams, 'SignatureDisplay'>>();

  const { request, pin } = route.params;

  const accounts = useWalletStore((state) => state.wallet?.accounts ?? []);
  const setPendingRequest = useRemoteSignerStore((state) => state.setPendingRequest);
  const markRequestProcessed = useRemoteSignerStore((state) => state.markRequestProcessed);

  const [screenState, setScreenState] = useState<ScreenState>('signing');
  const [signingProgress, setSigningProgress] = useState({ current: 0, total: 0 });
  const [response, setResponse] = useState<RemoteSignerResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasStartedSigning, setHasStartedSigning] = useState(false);

  // Generate QR data from response
  const qrData = useMemo(() => {
    if (!response) return null;
    return RemoteSignerService.encodePayload(response);
  }, [response]);

  // Start signing when component mounts (auth already done in TransactionReviewScreen)
  useEffect(() => {
    if (hasStartedSigning) return;
    setHasStartedSigning(true);

    const signTransactions = async () => {
      setSigningProgress({ current: 0, total: request.txns.length });

      try {
        // Sign all transactions
        const signedTxns: Uint8Array[] = [];

        for (let i = 0; i < request.txns.length; i++) {
          setSigningProgress({ current: i + 1, total: request.txns.length });

          const txnData = request.txns[i];
          const txnBytes = Buffer.from(txnData.b, 'base64');
          const txn = algosdk.decodeUnsignedTransaction(txnBytes);

          // Get the signer address (use auth address if provided)
          const signerAddress = txnData.a || txnData.s;

          // Find the account with this address
          const account = accounts.find(
            (acc: AccountMetadata) => acc.address === signerAddress && acc.type === AccountType.STANDARD
          );

          if (!account) {
            throw new Error(`No signing key found for address: ${signerAddress}`);
          }

          // Get the private key
          // If PIN was provided (PIN auth), use it
          // If no PIN (biometric auth), getPrivateKey will use biometric-protected storage
          const privateKey = await AccountSecureStorage.getPrivateKey(account.id, pin);
          if (!privateKey) {
            throw new Error(`Could not retrieve private key for account: ${account.label || account.address}`);
          }

          // Sign the transaction
          const signedTxn = txn.signTxn(privateKey);
          signedTxns.push(signedTxn);

          // Clear private key from memory
          privateKey.fill(0);
        }

        // Create success response
        const successResponse = RemoteSignerService.createSuccessResponse(
          request.id,
          signedTxns
        );

        // Mark request as processed (prevents replay)
        markRequestProcessed(request.id);

        // Clear pending request
        setPendingRequest(null);

        setResponse(successResponse);
        setScreenState('display');
      } catch (error) {
        console.error('Signing failed:', error);
        setErrorMessage(error instanceof Error ? error.message : 'Signing failed');
        setScreenState('error');
      }
    };

    signTransactions();
  }, [hasStartedSigning, request, pin, accounts, markRequestProcessed, setPendingRequest]);

  const handleDone = () => {
    navigation.popToTop();
  };

  const handleRetry = () => {
    // Go back to TransactionReviewScreen to re-authenticate
    navigation.goBack();
  };

  // Render signing progress
  const renderSigning = () => (
    <View style={styles.signingContainer}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <Text style={styles.signingTitle}>Signing Transactions</Text>
      <View style={styles.progressBar}>
        <View
          style={[
            styles.progressFill,
            {
              width: `${(signingProgress.current / signingProgress.total) * 100}%`,
            },
          ]}
        />
      </View>
    </View>
  );

  // Render QR display
  const renderDisplay = () => (
    <ScrollView
      style={styles.displayContainer}
      contentContainerStyle={styles.displayContent}
    >
      <View style={styles.successHeader}>
        <Ionicons name="checkmark-circle" size={48} color={theme.colors.success} />
        <Text style={styles.successTitle}>Transaction Signed</Text>
        <Text style={styles.successSubtitle}>
          Scan this QR code with your wallet device to complete the transaction
        </Text>
      </View>

      {qrData && (
        <AnimatedQRCode
          data={qrData}
          size={220}
          showControls={true}
          showFrameCounter={true}
        />
      )}

      <View style={styles.responseInfo}>
        <Text style={styles.responseLabel}>Request ID</Text>
        <Text style={styles.responseValue}>{response?.id}</Text>

        <Text style={styles.responseLabel}>Transactions Signed</Text>
        <Text style={styles.responseValue}>{response?.sigs?.length || 0}</Text>

        {qrData && (
          <>
            <Text style={styles.responseLabel}>QR Data Size</Text>
            <Text style={styles.responseValue}>
              {qrData.length} bytes
            </Text>
          </>
        )}
      </View>

      <TouchableOpacity style={styles.doneButton} onPress={handleDone}>
        <Text style={styles.doneButtonText}>Done</Text>
      </TouchableOpacity>
    </ScrollView>
  );

  // Render error state
  const renderError = () => (
    <View style={styles.errorContainer}>
      <Ionicons name="alert-circle" size={48} color={theme.colors.error} />
      <Text style={styles.errorTitle}>Signing Failed</Text>
      <Text style={styles.errorMessage}>{errorMessage}</Text>

      <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
        <Text style={styles.retryButtonText}>Try Again</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.cancelButton}
        onPress={() => navigation.popToTop()}
      >
        <Text style={styles.cancelButtonText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => {
            if (screenState === 'display') {
              handleDone();
            } else {
              navigation.goBack();
            }
          }}
        >
          <Ionicons
            name={screenState === 'display' ? 'checkmark' : 'arrow-back'}
            size={24}
            color={theme.colors.text}
          />
        </TouchableOpacity>
        <Text style={styles.title}>
          {screenState === 'signing' && 'Signing...'}
          {screenState === 'display' && 'Scan Response'}
          {screenState === 'error' && 'Error'}
        </Text>
        <View style={styles.placeholder} />
      </View>

      {/* Content */}
      {screenState === 'signing' && renderSigning()}
      {screenState === 'display' && renderDisplay()}
      {screenState === 'error' && renderError()}
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.surface,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    backButton: {
      padding: theme.spacing.xs,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholder: {
      width: 32,
    },
    cancelButton: {
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
    },
    cancelButtonText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
    },
    // Signing Progress
    signingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.xl,
    },
    signingTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.lg,
    },
    signingProgress: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
    },
    progressBar: {
      width: '80%',
      height: 4,
      backgroundColor: theme.colors.border,
      borderRadius: 2,
      marginTop: theme.spacing.lg,
      overflow: 'hidden',
    },
    progressFill: {
      height: '100%',
      backgroundColor: theme.colors.primary,
    },
    // Display
    displayContainer: {
      flex: 1,
    },
    displayContent: {
      padding: theme.spacing.lg,
      alignItems: 'center',
    },
    successHeader: {
      alignItems: 'center',
      marginBottom: theme.spacing.xl,
    },
    successTitle: {
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.success,
      marginTop: theme.spacing.md,
    },
    successSubtitle: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
    },
    qrContainer: {
      backgroundColor: 'white',
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.xl,
    },
    animatedQRNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: `${theme.colors.warning}15`,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.xl,
    },
    animatedQRText: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.warning,
    },
    responseInfo: {
      width: '100%',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.xl,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    responseLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 2,
    },
    responseValue: {
      fontSize: 14,
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    doneButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.xl,
      borderRadius: theme.borderRadius.lg,
    },
    doneButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    // Error
    errorContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: theme.spacing.xl,
    },
    errorTitle: {
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.error,
      marginTop: theme.spacing.md,
    },
    errorMessage: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.xl,
    },
    retryButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.xl,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.md,
    },
    retryButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
