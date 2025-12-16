/**
 * Airgap Verification Flow Component
 *
 * Manages the verification step when rekeying TO an airgap signer.
 * Creates a zero-amount self-payment transaction that the airgap device signs
 * to prove it controls the target address. The signature is verified locally
 * WITHOUT submitting to the network.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { RemoteSignerAccountMetadata } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { TransactionService } from '@/services/transactions';
import { RemoteSignerService } from '@/services/remoteSigner';
import { RemoteSignerRequest, RemoteSignerResponse } from '@/types/remoteSigner';
import { AnimatedQRCode } from '@/components/remoteSigner/AnimatedQRCode';
import { AnimatedQRScanner } from '@/components/remoteSigner/AnimatedQRScanner';
import { verifySignedTransaction } from '@/utils/signatureVerification';

type VerificationState =
  | 'building'
  | 'displaying_qr'
  | 'scanning_response'
  | 'verifying'
  | 'success'
  | 'error';

interface AirgapVerificationFlowProps {
  /** The airgap signer account we want to verify */
  targetAccount: RemoteSignerAccountMetadata;
  /** Network to use for the verification transaction */
  networkId: NetworkId;
  /** Called when verification succeeds */
  onVerificationSuccess: () => void;
  /** Called when verification fails */
  onVerificationFailure: (error: string) => void;
  /** Called when user cancels the flow */
  onCancel: () => void;
}

/**
 * AirgapVerificationFlow - Verifies an airgap device can sign before rekeying
 *
 * Flow:
 * 1. Build verification transaction (self-payment, 0 amount)
 * 2. Display QR code for airgap device to scan
 * 3. User scans signed response from airgap device
 * 4. Verify signature locally (no network submission)
 * 5. Report success/failure
 */
export function AirgapVerificationFlow({
  targetAccount,
  networkId,
  onVerificationSuccess,
  onVerificationFailure,
  onCancel,
}: AirgapVerificationFlowProps) {
  const { theme } = useTheme();

  const [state, setState] = useState<VerificationState>('building');
  const [error, setError] = useState<string | null>(null);
  const [requestPayload, setRequestPayload] = useState<string | null>(null);
  const [signingRequest, setSigningRequest] = useState<RemoteSignerRequest | null>(null);

  // Build verification transaction on mount
  useEffect(() => {
    let cancelled = false;

    const build = async () => {
      try {
        setState('building');
        setError(null);

        // Build a zero-amount self-payment transaction
        const verificationTxn = await TransactionService.buildVerificationTransaction({
          signerAddress: targetAccount.address,
          networkId,
        });

        if (cancelled) return;

        // Create a remote signer request
        const request = await RemoteSignerService.createSingleTxnRequest(
          verificationTxn.txn,
          targetAccount.address
        );

        if (cancelled) return;

        // Encode the request as JSON for QR display
        const payload = RemoteSignerService.encodePayload(request);

        setSigningRequest(request);
        setRequestPayload(payload);
        setState('displaying_qr');
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to build verification transaction';
        setError(message);
        setState('error');
      }
    };

    build();

    return () => {
      cancelled = true;
    };
  }, [targetAccount.address, networkId]);

  const buildVerificationTransaction = async () => {
    try {
      setState('building');
      setError(null);

      // Build a zero-amount self-payment transaction
      const verificationTxn = await TransactionService.buildVerificationTransaction({
        signerAddress: targetAccount.address,
        networkId,
      });

      // Create a remote signer request
      const request = await RemoteSignerService.createSingleTxnRequest(
        verificationTxn.txn,
        targetAccount.address
      );

      // Encode the request as JSON for QR display
      const payload = RemoteSignerService.encodePayload(request);

      setSigningRequest(request);
      setRequestPayload(payload);
      setState('displaying_qr');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to build verification transaction';
      setError(message);
      setState('error');
    }
  };

  const handleScanResponse = useCallback(() => {
    setState('scanning_response');
  }, []);

  const handleScannedData = useCallback(
    (data: string) => {
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

        // Validate response matches our request
        if (signingRequest) {
          const validation = RemoteSignerService.validateResponse(signerResponse, signingRequest);
          if (!validation.valid) {
            throw new Error(validation.error || 'Response does not match request');
          }
        }

        // Extract the signed transaction
        const signedTxns = RemoteSignerService.extractSignedTransactions(signerResponse);
        if (signedTxns.length === 0) {
          throw new Error('No signed transactions in response');
        }

        // SECURITY: Ensure exactly one transaction was returned
        // This prevents transaction group substitution attacks
        if (signedTxns.length !== 1) {
          throw new Error(`Expected 1 signed transaction, got ${signedTxns.length}`);
        }

        // Verify the signature locally
        const signedTxnBase64 = Buffer.from(signedTxns[0]).toString('base64');
        const verificationResult = verifySignedTransaction(
          signedTxnBase64,
          targetAccount.address
        );

        if (!verificationResult.valid) {
          throw new Error(verificationResult.error || 'Signature verification failed');
        }

        // Success! User will click Continue button to proceed
        setState('success');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to verify signature';
        setError(message);
        setState('error');
      }
    },
    [signingRequest, targetAccount.address, onVerificationSuccess]
  );

  const handleScanError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    setState('error');
  }, []);

  const handleRetry = useCallback(() => {
    setError(null);
    buildVerificationTransaction();
  }, [targetAccount.address, networkId]);

  const handleBackToQR = useCallback(() => {
    setState('displaying_qr');
    setError(null);
  }, []);

  const renderContent = () => {
    switch (state) {
      case 'building':
        return (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.statusText, { color: theme.colors.text }]}>
              Building verification transaction...
            </Text>
          </View>
        );

      case 'displaying_qr':
        return (
          <View style={styles.qrContent}>
            <View style={[styles.infoBox, { backgroundColor: theme.colors.infoLight }]}>
              <Ionicons name="information-circle" size={20} color={theme.colors.info} />
              <Text style={[styles.infoText, { color: theme.colors.info }]}>
                Scan this QR code with your airgap signer device to verify it can sign transactions.
              </Text>
            </View>

            {requestPayload && (
              <AnimatedQRCode
                data={requestPayload}
                size={200}
                showFrameCounter
                showControls
              />
            )}

            <View style={styles.instructions}>
              <Text style={[styles.instructionStep, { color: theme.colors.text }]}>
                1. Open your airgap signer app
              </Text>
              <Text style={[styles.instructionStep, { color: theme.colors.text }]}>
                2. Scan this QR code
              </Text>
              <Text style={[styles.instructionStep, { color: theme.colors.text }]}>
                3. Review and sign the verification transaction
              </Text>
              <Text style={[styles.instructionStep, { color: theme.colors.text }]}>
                4. Tap "Scan Signed Response" below
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: theme.colors.primary }]}
              onPress={handleScanResponse}
            >
              <Ionicons name="qr-code-outline" size={20} color={theme.colors.buttonText} />
              <Text style={[styles.primaryButtonText, { color: theme.colors.buttonText }]}>
                Scan Signed Response
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
              instructionsText="Scan the signed response QR from your airgap device"
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

      case 'success':
        return (
          <View style={styles.centeredContent}>
            <View style={[styles.successIcon, { backgroundColor: theme.colors.successLight }]}>
              <Ionicons name="checkmark-circle" size={64} color={theme.colors.success} />
            </View>
            <Text style={[styles.successTitle, { color: theme.colors.success }]}>
              Verification Successful
            </Text>
            <Text style={[styles.successSubtitle, { color: theme.colors.textSecondary }]}>
              The airgap device has been verified.
            </Text>
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: theme.colors.success, marginTop: 24 }]}
              onPress={onVerificationSuccess}
            >
              <Text style={[styles.primaryButtonText, { color: theme.colors.buttonText }]}>
                Continue
              </Text>
            </TouchableOpacity>
          </View>
        );

      case 'error':
        return (
          <View style={styles.centeredContent}>
            <View style={[styles.errorIcon, { backgroundColor: theme.colors.errorLight }]}>
              <Ionicons name="close-circle" size={64} color={theme.colors.error} />
            </View>
            <Text style={[styles.errorTitle, { color: theme.colors.error }]}>
              Verification Failed
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
                onPress={() => onVerificationFailure(error || 'Verification failed')}
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

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onCancel}
    >
      <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
          <TouchableOpacity
            style={styles.closeButton}
            onPress={onCancel}
            disabled={state === 'verifying' || state === 'success'}
          >
            <Ionicons
              name="close"
              size={24}
              color={
                state === 'verifying' || state === 'success'
                  ? theme.colors.disabled
                  : theme.colors.text
              }
            />
          </TouchableOpacity>

          <View style={styles.headerTitleContainer}>
            <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
              Verify Airgap Signer
            </Text>
            <Text style={[styles.headerSubtitle, { color: theme.colors.textSecondary }]}>
              {targetAccount.label || targetAccount.address.slice(0, 8) + '...'}
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
  headerSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  headerSpacer: {
    width: 40, // Match close button width for centering
  },
  content: {
    flex: 1,
    padding: 16,
  },
  centeredContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  statusText: {
    fontSize: 16,
    textAlign: 'center',
  },
  qrContent: {
    flex: 1,
    alignItems: 'center',
    gap: 20,
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: 8,
    gap: 8,
  },
  infoText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
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
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 12,
    gap: 8,
    marginTop: 8,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
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
    marginTop: 16,
  },
  backButtonText: {
    fontSize: 14,
    fontWeight: '500',
  },
  successIcon: {
    padding: 16,
    borderRadius: 50,
  },
  successTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  successSubtitle: {
    fontSize: 14,
    textAlign: 'center',
  },
  errorIcon: {
    padding: 16,
    borderRadius: 50,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '600',
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
  cancelButton: {
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 12,
    borderWidth: 1,
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
  },
});

export default AirgapVerificationFlow;
