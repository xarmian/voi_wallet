/**
 * TransferToAirgapFlow Component
 *
 * Multi-step flow for transferring a STANDARD account to an airgap signer device.
 * The flow:
 * 1. Show disclaimer (recommending new keys on airgap device)
 * 2. Authenticate with PIN/biometric
 * 3. Display ARC-300 QR code with private key
 * 4. Scan verification response from airgap device
 * 5. Verify signature locally
 * 6. Confirm deletion (explicit user action)
 * 7. Convert account to REMOTE_SIGNER type
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { StandardAccountMetadata, RemoteSignerAccountMetadata } from '@/types/wallet';
import { RemoteSignerService } from '@/services/remoteSigner';
import { RemoteSignerResponse } from '@/types/remoteSigner';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { AnimatedQRCode } from '@/components/remoteSigner/AnimatedQRCode';
import { AnimatedQRScanner } from '@/components/remoteSigner/AnimatedQRScanner';
import { verifySignedTransaction } from '@/utils/signatureVerification';
import { generateArc0300AccountExportUri } from '@/utils/arc0300';
import { useCurrentNetwork } from '@/store/networkStore';

type TransferState =
  | 'disclaimer'
  | 'generating'
  | 'displaying_qr'
  | 'scanning_response'
  | 'verifying'
  | 'confirm_deletion'
  | 'converting'
  | 'success'
  | 'error';

interface TransferToAirgapFlowProps {
  /** The STANDARD account to transfer */
  account: StandardAccountMetadata;
  /** Called when transfer succeeds */
  onSuccess: (newAccount: RemoteSignerAccountMetadata) => void;
  /** Called when user cancels the flow */
  onCancel: () => void;
}

export function TransferToAirgapFlow({
  account,
  onSuccess,
  onCancel,
}: TransferToAirgapFlowProps) {
  const { theme } = useTheme();
  const networkId = useCurrentNetwork();

  const [state, setState] = useState<TransferState>('disclaimer');
  const [error, setError] = useState<string | null>(null);
  const [privateKeyQrData, setPrivateKeyQrData] = useState<string | null>(null);
  const [verifiedSignerDeviceId, setVerifiedSignerDeviceId] = useState<string | null>(null);
  const [verifiedSignerDeviceName, setVerifiedSignerDeviceName] = useState<string | undefined>(undefined);

  // Handle disclaimer acceptance
  const handleAcceptDisclaimer = useCallback(async () => {
    setState('generating');

    try {
      // Retrieve the private key (will prompt for biometric/PIN authentication internally)
      const privateKey = await AccountSecureStorage.getPrivateKey(account.id);

      if (!privateKey) {
        throw new Error('Could not retrieve private key for this account');
      }

      // Generate ARC-300 URI
      const arc300Uri = generateArc0300AccountExportUri({
        privateKeyBytes: privateKey,
        name: account.label,
      });

      // For now we'll just use the raw URI - if it needs animation, AnimatedQRCode handles it
      setPrivateKeyQrData(arc300Uri);
      setState('displaying_qr');

      // Zero out the private key from memory
      privateKey.fill(0);

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to prepare transfer';
      // Check for authentication errors
      if (message.includes('Authentication') || message.includes('cancelled') || message.includes('PIN')) {
        setError('Authentication required to access private key. Please try again.');
      } else {
        setError(message);
      }
      setState('error');
    }
  }, [account]);

  // Handle scanning the verification response
  const handleScanResponse = useCallback(() => {
    setState('scanning_response');
  }, []);

  // Handle the scanned response from airgap device
  const handleScannedData = useCallback(
    async (data: string) => {
      setState('verifying');

      try {
        // Parse the response
        const response = RemoteSignerService.decodePayload(data);

        // Check if it's a valid response
        if (!RemoteSignerService.isResponse(response)) {
          throw new Error('Scanned data is not a valid signing response');
        }

        const signerResponse = response as RemoteSignerResponse;

        // Check if the signing was rejected
        if (!signerResponse.ok) {
          throw new Error(signerResponse.err?.m || 'Signing was rejected on the airgap device');
        }

        // Extract the signed transaction
        const signedTxns = RemoteSignerService.extractSignedTransactions(signerResponse);
        if (signedTxns.length === 0) {
          throw new Error('No signed transactions in response');
        }

        // Verify exactly one transaction
        if (signedTxns.length !== 1) {
          throw new Error(`Expected 1 signed transaction, got ${signedTxns.length}`);
        }

        // Verify the signature locally
        const signedTxnBase64 = Buffer.from(signedTxns[0]).toString('base64');
        const verificationResult = verifySignedTransaction(
          signedTxnBase64,
          account.address
        );

        if (!verificationResult.valid) {
          throw new Error(verificationResult.error || 'Signature verification failed');
        }

        // Extract signer device info from the response metadata if available
        // For now, we'll use a generated device ID since the response might not have it
        const signerDeviceId = `airgap-${Date.now()}`;
        setVerifiedSignerDeviceId(signerDeviceId);

        // Move to confirmation step
        setState('confirm_deletion');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to verify signature';
        setError(message);
        setState('error');
      }
    },
    [account.address]
  );

  // Handle user confirming deletion
  const handleConfirmDeletion = useCallback(async () => {
    if (!verifiedSignerDeviceId) {
      setError('No verified signer device');
      setState('error');
      return;
    }

    setState('converting');

    try {
      // Convert the account
      const newAccount = await MultiAccountWalletService.convertStandardToRemoteSigner(
        account.id,
        verifiedSignerDeviceId,
        verifiedSignerDeviceName
      );

      setState('success');

      // Small delay to show success state
      setTimeout(() => {
        onSuccess(newAccount);
      }, 1500);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to convert account';
      setError(message);
      setState('error');
    }
  }, [account.id, verifiedSignerDeviceId, verifiedSignerDeviceName, onSuccess]);

  // Handle scan error
  const handleScanError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    setState('error');
  }, []);

  // Handle retry
  const handleRetry = useCallback(() => {
    setError(null);
    setState('disclaimer');
  }, []);

  // Handle back to QR
  const handleBackToQR = useCallback(() => {
    setState('displaying_qr');
    setError(null);
  }, []);

  const renderContent = () => {
    switch (state) {
      case 'disclaimer':
        return (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.disclaimerContent}>
              <View style={[styles.warningIcon, { backgroundColor: `${theme.colors.warning}20` }]}>
                <Ionicons name="warning" size={48} color={theme.colors.warning} />
              </View>

              <Text style={[styles.disclaimerTitle, { color: theme.colors.text }]}>
                Transfer Account to Airgap Device
              </Text>

              <View style={[styles.warningBox, { backgroundColor: `${theme.colors.warning}15`, borderColor: theme.colors.warning }]}>
                <Ionicons name="shield-checkmark" size={24} color={theme.colors.warning} />
                <Text style={[styles.warningText, { color: theme.colors.warning }]}>
                  For maximum security, we recommend creating a new account on your airgap device while it's in airplane mode. This feature is provided for convenience only.
                </Text>
              </View>

              <View style={styles.disclaimerPoints}>
                <View style={styles.disclaimerPoint}>
                  <Ionicons name="key-outline" size={20} color={theme.colors.textSecondary} />
                  <Text style={[styles.pointText, { color: theme.colors.textSecondary }]}>
                    Your private key will be displayed as a QR code
                  </Text>
                </View>
                <View style={styles.disclaimerPoint}>
                  <Ionicons name="phone-portrait-outline" size={20} color={theme.colors.textSecondary} />
                  <Text style={[styles.pointText, { color: theme.colors.textSecondary }]}>
                    Scan the QR code with your airgap signer device
                  </Text>
                </View>
                <View style={styles.disclaimerPoint}>
                  <Ionicons name="checkmark-circle-outline" size={20} color={theme.colors.textSecondary} />
                  <Text style={[styles.pointText, { color: theme.colors.textSecondary }]}>
                    Verify the transfer with a signed confirmation
                  </Text>
                </View>
                <View style={styles.disclaimerPoint}>
                  <Ionicons name="trash-outline" size={20} color={theme.colors.textSecondary} />
                  <Text style={[styles.pointText, { color: theme.colors.textSecondary }]}>
                    The private key will be removed from this device
                  </Text>
                </View>
              </View>

              <View style={[styles.accountCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                <Text style={[styles.accountLabel, { color: theme.colors.textSecondary }]}>
                  Account to Transfer
                </Text>
                <Text style={[styles.accountName, { color: theme.colors.text }]}>
                  {account.label || 'Unnamed Account'}
                </Text>
                <Text style={[styles.accountAddress, { color: theme.colors.textMuted }]}>
                  {account.address.slice(0, 8)}...{account.address.slice(-8)}
                </Text>
              </View>

              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: theme.colors.warning }]}
                onPress={handleAcceptDisclaimer}
              >
                <Text style={[styles.primaryButtonText, { color: theme.colors.buttonText }]}>
                  I Understand, Continue
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        );

      case 'generating':
        return (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.statusText, { color: theme.colors.text }]}>
              Preparing transfer...
            </Text>
          </View>
        );

      case 'displaying_qr':
        return (
          <View style={styles.qrContent}>
            <View style={[styles.warningBanner, { backgroundColor: `${theme.colors.error}15` }]}>
              <Ionicons name="eye-off" size={20} color={theme.colors.error} />
              <Text style={[styles.warningBannerText, { color: theme.colors.error }]}>
                This QR code contains your private key. Keep it private!
              </Text>
            </View>

            {privateKeyQrData && (
              <View style={styles.qrWrapper}>
                <AnimatedQRCode
                  data={privateKeyQrData}
                  size={220}
                  showFrameCounter
                  showControls
                />
              </View>
            )}

            <View style={styles.instructions}>
              <Text style={[styles.instructionStep, { color: theme.colors.text }]}>
                1. Open the Voi app on your airgap device
              </Text>
              <Text style={[styles.instructionStep, { color: theme.colors.text }]}>
                2. Tap "Import from Online Wallet"
              </Text>
              <Text style={[styles.instructionStep, { color: theme.colors.text }]}>
                3. Scan this QR code
              </Text>
              <Text style={[styles.instructionStep, { color: theme.colors.text }]}>
                4. When ready, tap the button below to scan the confirmation
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: theme.colors.primary }]}
              onPress={handleScanResponse}
            >
              <Ionicons name="scan-outline" size={20} color={theme.colors.buttonText} />
              <Text style={[styles.primaryButtonText, { color: theme.colors.buttonText }]}>
                Scan Confirmation QR
              </Text>
            </TouchableOpacity>
          </View>
        );

      case 'scanning_response':
        return (
          <View style={styles.scannerContainer}>
            <AnimatedQRScanner
              onScan={handleScannedData}
              onError={handleScanError}
              instructionsText="Scan the confirmation QR from your airgap device"
              compact
            />
            <TouchableOpacity
              style={[styles.backButton, { backgroundColor: theme.colors.card }]}
              onPress={handleBackToQR}
            >
              <Ionicons name="arrow-back" size={20} color={theme.colors.text} />
              <Text style={[styles.backButtonText, { color: theme.colors.text }]}>
                Back to QR Code
              </Text>
            </TouchableOpacity>
          </View>
        );

      case 'verifying':
        return (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.statusText, { color: theme.colors.text }]}>
              Verifying signature...
            </Text>
          </View>
        );

      case 'confirm_deletion':
        return (
          <View style={styles.confirmContent}>
            <View style={[styles.successIcon, { backgroundColor: `${theme.colors.success}15` }]}>
              <Ionicons name="checkmark-circle" size={64} color={theme.colors.success} />
            </View>

            <Text style={[styles.confirmTitle, { color: theme.colors.text }]}>
              Verification Successful
            </Text>

            <Text style={[styles.confirmSubtitle, { color: theme.colors.textSecondary }]}>
              Your airgap device has received the account and can sign transactions.
            </Text>

            <View style={[styles.dangerBox, { backgroundColor: `${theme.colors.error}15`, borderColor: theme.colors.error }]}>
              <Ionicons name="warning" size={24} color={theme.colors.error} />
              <Text style={[styles.dangerText, { color: theme.colors.error }]}>
                Proceeding will permanently remove the private key from this device. This cannot be undone.
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.dangerButton, { backgroundColor: theme.colors.error }]}
              onPress={handleConfirmDeletion}
            >
              <Ionicons name="trash-outline" size={20} color={theme.colors.buttonText} />
              <Text style={[styles.primaryButtonText, { color: theme.colors.buttonText }]}>
                Remove Key and Complete Transfer
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.cancelButton, { borderColor: theme.colors.border }]}
              onPress={onCancel}
            >
              <Text style={[styles.cancelButtonText, { color: theme.colors.textSecondary }]}>
                Cancel
              </Text>
            </TouchableOpacity>
          </View>
        );

      case 'converting':
        return (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.statusText, { color: theme.colors.text }]}>
              Converting account...
            </Text>
          </View>
        );

      case 'success':
        return (
          <View style={styles.centeredContent}>
            <View style={[styles.successIcon, { backgroundColor: `${theme.colors.success}15` }]}>
              <Ionicons name="checkmark-circle" size={64} color={theme.colors.success} />
            </View>
            <Text style={[styles.successTitle, { color: theme.colors.success }]}>
              Transfer Complete
            </Text>
            <Text style={[styles.successSubtitle, { color: theme.colors.textSecondary }]}>
              This account now signs transactions via your airgap device.
            </Text>
          </View>
        );

      case 'error':
        return (
          <View style={styles.centeredContent}>
            <View style={[styles.errorIcon, { backgroundColor: `${theme.colors.error}15` }]}>
              <Ionicons name="close-circle" size={64} color={theme.colors.error} />
            </View>
            <Text style={[styles.errorTitle, { color: theme.colors.error }]}>
              Transfer Failed
            </Text>
            <Text style={[styles.errorMessage, { color: theme.colors.textSecondary }]}>
              {error || 'An unknown error occurred'}
            </Text>

            <View style={styles.errorActions}>
              <TouchableOpacity
                style={[styles.retryButton, { backgroundColor: theme.colors.primary }]}
                onPress={handleRetry}
              >
                <Ionicons name="refresh" size={20} color={theme.colors.buttonText} />
                <Text style={[styles.retryButtonText, { color: theme.colors.buttonText }]}>
                  Try Again
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.cancelButton, { borderColor: theme.colors.border }]}
                onPress={onCancel}
              >
                <Text style={[styles.cancelButtonText, { color: theme.colors.textSecondary }]}>
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        );

      default:
        return null;
    }
  };

  const canClose = !['generating', 'verifying', 'converting', 'success'].includes(state);

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={canClose ? onCancel : undefined}
    >
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onCancel}
            disabled={!canClose}
          >
            <Ionicons
              name="close"
              size={24}
              color={canClose ? theme.colors.text : theme.colors.textMuted}
            />
          </TouchableOpacity>

          <View style={styles.headerTitleContainer}>
            <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
              Transfer to Airgap
            </Text>
          </View>

          <View style={styles.headerSpacer} />
        </View>

        {/* Content */}
        <View style={styles.content}>{renderContent()}</View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  closeButton: {
    padding: 8,
  },
  headerTitleContainer: {
    flex: 1,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  headerSpacer: {
    width: 40,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  centeredContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
    padding: 16,
  },
  statusText: {
    fontSize: 16,
    textAlign: 'center',
  },

  // Disclaimer styles
  disclaimerContent: {
    alignItems: 'center',
    gap: 20,
  },
  warningIcon: {
    padding: 20,
    borderRadius: 50,
    marginBottom: 8,
  },
  disclaimerTitle: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  warningText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  disclaimerPoints: {
    alignSelf: 'stretch',
    gap: 12,
  },
  disclaimerPoint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pointText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
  },
  accountCard: {
    alignSelf: 'stretch',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  accountLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 4,
  },
  accountName: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
  },
  accountAddress: {
    fontSize: 13,
    fontFamily: 'monospace',
  },

  // QR display styles
  qrContent: {
    flex: 1,
    alignItems: 'center',
    padding: 16,
    gap: 16,
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    gap: 8,
    alignSelf: 'stretch',
  },
  warningBannerText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
  },
  qrWrapper: {
    padding: 16,
    backgroundColor: 'white',
    borderRadius: 16,
  },
  instructions: {
    alignSelf: 'stretch',
    gap: 8,
    paddingHorizontal: 8,
  },
  instructionStep: {
    fontSize: 14,
    lineHeight: 20,
  },

  // Scanner styles
  scannerContainer: {
    flex: 1,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    gap: 8,
    margin: 16,
  },
  backButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },

  // Confirmation styles
  confirmContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 16,
  },
  confirmTitle: {
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  confirmSubtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  dangerBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    marginTop: 8,
  },
  dangerText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  dangerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    gap: 8,
    alignSelf: 'stretch',
    marginTop: 8,
  },

  // Button styles
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 12,
    gap: 8,
    alignSelf: 'stretch',
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    borderWidth: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 15,
    fontWeight: '500',
  },

  // Success styles
  successIcon: {
    padding: 16,
    borderRadius: 50,
  },
  successTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  successSubtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },

  // Error styles
  errorIcon: {
    padding: 16,
    borderRadius: 50,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: '700',
  },
  errorMessage: {
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  errorActions: {
    flexDirection: 'column',
    gap: 12,
    marginTop: 16,
    alignSelf: 'stretch',
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 12,
    gap: 8,
  },
  retryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});

export default TransferToAirgapFlow;
