/**
 * Sign Request Display Screen (Wallet Mode)
 *
 * This screen displays the transaction signing request as a QR code
 * for the signer device to scan. After the signer scans and signs,
 * the user can navigate to scan the signed response.
 */

import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useRemoteSignerStore } from '@/store/remoteSignerStore';
import { RemoteSignerService } from '@/services/remoteSigner';
import { RemoteSignerRequest } from '@/types/remoteSigner';
import { formatAddress } from '@/utils/address';
import { formatVoiBalance } from '@/utils/bigint';
import { AnimatedQRCode } from '@/components/remoteSigner';

type RouteParams = {
  SignRequestDisplay: {
    request: RemoteSignerRequest;
    onComplete?: (signedTxns: Uint8Array[]) => void;
  };
};

export default function SignRequestDisplayScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation<any>();
  const route = useRoute<RouteProp<RouteParams, 'SignRequestDisplay'>>();

  const { request, onComplete } = route.params;

  const createPendingSignatureRequest = useRemoteSignerStore(
    (state) => state.createPendingSignatureRequest
  );

  const [showTransactionDetails, setShowTransactionDetails] = useState(false);

  // Generate QR data
  const qrData = useMemo(() => {
    return RemoteSignerService.encodePayload(request);
  }, [request]);

  // Decode transactions for preview
  const decodedTransactions = useMemo(() => {
    return RemoteSignerService.decodeRequestTransactions(request);
  }, [request]);

  const handleScanResponse = () => {
    // Store the pending request with callback
    createPendingSignatureRequest(request, (response) => {
      if (response.ok && response.sigs && onComplete) {
        const signedTxns = RemoteSignerService.extractSignedTransactions(response);
        onComplete(signedTxns);
      }
    });

    // Navigate to signature scanner
    navigation.navigate('SignatureScanner', { requestId: request.id });
  };

  const handleCancel = () => {
    navigation.goBack();
  };

  const totalFee = decodedTransactions.reduce(
    (sum, txn) => sum + txn.fee,
    0n
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={handleCancel}>
          <Ionicons name="close" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Sign with Remote Signer</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Instructions */}
        <View style={styles.instructionsCard}>
          <View style={styles.stepRow}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>1</Text>
            </View>
            <Text style={styles.stepText}>
              Open the Voi app on your signer device
            </Text>
          </View>
          <View style={styles.stepRow}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>2</Text>
            </View>
            <Text style={styles.stepText}>
              Tap "Scan Request" and scan this QR code
            </Text>
          </View>
          <View style={styles.stepRow}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>3</Text>
            </View>
            <Text style={styles.stepText}>
              Review and sign on your signer device
            </Text>
          </View>
          <View style={styles.stepRow}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>4</Text>
            </View>
            <Text style={styles.stepText}>
              Tap "Scan Response" below to complete
            </Text>
          </View>
        </View>

        {/* QR Code - uses AnimatedQRCode for both static and animated */}
        <AnimatedQRCode
          data={qrData}
          size={200}
          showControls={true}
          showFrameCounter={true}
        />

        {/* Transaction Summary */}
        <View style={styles.summaryCard}>
          <TouchableOpacity
            style={styles.summaryHeader}
            onPress={() => setShowTransactionDetails(!showTransactionDetails)}
          >
            <View style={styles.summaryHeaderLeft}>
              <Ionicons
                name="document-text-outline"
                size={20}
                color={theme.colors.primary}
              />
              <Text style={styles.summaryTitle}>
                {decodedTransactions.length} Transaction
                {decodedTransactions.length > 1 ? 's' : ''}
              </Text>
            </View>
            <Ionicons
              name={showTransactionDetails ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={theme.colors.textSecondary}
            />
          </TouchableOpacity>

          {showTransactionDetails && (
            <View style={styles.transactionsList}>
              {decodedTransactions.map((txn, index) => (
                <View key={index} style={styles.transactionItem}>
                  <View style={styles.txnRow}>
                    <Text style={styles.txnLabel}>Type</Text>
                    <Text style={styles.txnValue}>{txn.type}</Text>
                  </View>
                  <View style={styles.txnRow}>
                    <Text style={styles.txnLabel}>From</Text>
                    <Text style={styles.txnValueMono}>
                      {formatAddress(txn.sender)}
                    </Text>
                  </View>
                  {txn.receiver && (
                    <View style={styles.txnRow}>
                      <Text style={styles.txnLabel}>To</Text>
                      <Text style={styles.txnValueMono}>
                        {formatAddress(txn.receiver)}
                      </Text>
                    </View>
                  )}
                  {txn.amount !== undefined && txn.amount > 0n && (
                    <View style={styles.txnRow}>
                      <Text style={styles.txnLabel}>Amount</Text>
                      <Text style={styles.txnValue}>
                        {formatVoiBalance(txn.amount)}{' '}
                        {txn.assetId ? `ASA #${txn.assetId}` : 'VOI'}
                      </Text>
                    </View>
                  )}
                  <View style={styles.txnRow}>
                    <Text style={styles.txnLabel}>Fee</Text>
                    <Text style={styles.txnValue}>
                      {formatVoiBalance(txn.fee)} VOI
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          <View style={styles.totalFeeRow}>
            <Text style={styles.totalFeeLabel}>Total Fee</Text>
            <Text style={styles.totalFeeValue}>
              {formatVoiBalance(totalFee)} VOI
            </Text>
          </View>
        </View>

        {/* Request Info */}
        <View style={styles.requestInfo}>
          <Text style={styles.requestInfoLabel}>Request ID</Text>
          <Text style={styles.requestInfoValue}>{request.id}</Text>
          <Text style={styles.requestInfoLabel}>Network</Text>
          <Text style={styles.requestInfoValue}>{request.net}</Text>
          <Text style={styles.requestInfoLabel}>QR Data Size</Text>
          <Text style={styles.requestInfoValue}>{qrData.length} bytes</Text>
        </View>
      </ScrollView>

      {/* Action Buttons */}
      <View style={styles.actionContainer}>
        <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.scanButton}
          onPress={handleScanResponse}
        >
          <Ionicons name="scan-outline" size={20} color={theme.colors.buttonText} />
          <Text style={styles.scanButtonText}>Scan Response</Text>
        </TouchableOpacity>
      </View>
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
    content: {
      flex: 1,
    },
    scrollContent: {
      padding: theme.spacing.lg,
      paddingBottom: 100,
    },
    instructionsCard: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
    },
    stepNumber: {
      width: 24,
      height: 24,
      borderRadius: 12,
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
      fontSize: 14,
      color: theme.colors.text,
    },
    qrContainer: {
      alignSelf: 'center',
      backgroundColor: 'white',
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.lg,
    },
    animatedQRNotice: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: `${theme.colors.warning}15`,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.lg,
    },
    animatedQRText: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.warning,
    },
    summaryCard: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    summaryHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    summaryHeaderLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    summaryTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    transactionsList: {
      marginTop: theme.spacing.md,
      paddingTop: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    transactionItem: {
      marginBottom: theme.spacing.md,
      paddingBottom: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    txnRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: theme.spacing.xs,
    },
    txnLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    txnValue: {
      fontSize: 14,
      color: theme.colors.text,
    },
    txnValueMono: {
      fontSize: 14,
      color: theme.colors.text,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    totalFeeRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
    },
    totalFeeLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    totalFeeValue: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    requestInfo: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    requestInfoLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 2,
    },
    requestInfoValue: {
      fontSize: 14,
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    actionContainer: {
      flexDirection: 'row',
      gap: theme.spacing.md,
      padding: theme.spacing.lg,
      backgroundColor: theme.colors.card,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    cancelButton: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    cancelButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textSecondary,
    },
    scanButton: {
      flex: 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.primary,
    },
    buttonDisabled: {
      backgroundColor: theme.colors.textMuted,
    },
    scanButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
