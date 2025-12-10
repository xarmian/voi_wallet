/**
 * Transaction Review Screen (Signer Mode)
 *
 * This screen displays transaction details for the user to review
 * before signing on the air-gapped signer device.
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import SignerAuthModal from '@/components/remoteSigner/SignerAuthModal';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';
import { useRemoteSignerStore } from '@/store/remoteSignerStore';
import { RemoteSignerService } from '@/services/remoteSigner';
import {
  RemoteSignerRequest,
  DecodedTransactionInfo,
  TransactionDisplayType,
} from '@/types/remoteSigner';
import { formatAddress } from '@/utils/address';
import { formatVoiBalance } from '@/utils/bigint';

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
  TransactionReview: {
    request: RemoteSignerRequest;
  };
};

const TRANSACTION_TYPE_LABELS: Record<TransactionDisplayType, string> = {
  payment: 'Payment',
  asset_transfer: 'Asset Transfer',
  app_call: 'Application Call',
  asset_config: 'Asset Configuration',
  asset_freeze: 'Asset Freeze',
  key_registration: 'Key Registration',
  state_proof: 'State Proof',
  unknown: 'Transaction',
};

const TRANSACTION_TYPE_ICONS: Record<TransactionDisplayType, string> = {
  payment: 'arrow-forward-circle-outline',
  asset_transfer: 'swap-horizontal-outline',
  app_call: 'code-slash-outline',
  asset_config: 'settings-outline',
  asset_freeze: 'snow-outline',
  key_registration: 'key-outline',
  state_proof: 'document-text-outline',
  unknown: 'help-circle-outline',
};

export default function TransactionReviewScreen() {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation<any>();
  const route = useRoute<RouteProp<RouteParams, 'TransactionReview'>>();

  const { request } = route.params;

  const setPendingRequest = useRemoteSignerStore((state) => state.setPendingRequest);
  const markRequestProcessed = useRemoteSignerStore((state) => state.markRequestProcessed);

  const [currentTxnIndex, setCurrentTxnIndex] = useState(0);
  const [showFullDetails, setShowFullDetails] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

  // Decode all transactions
  const decodedTransactions = useMemo(() => {
    return RemoteSignerService.decodeRequestTransactions(request);
  }, [request]);

  const currentTxn = decodedTransactions[currentTxnIndex];
  const totalTxns = decodedTransactions.length;
  const isGroup = totalTxns > 1;

  const handleReject = () => {
    showAlert(
      'Reject Transaction?',
      'Are you sure you want to reject this signing request?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: () => {
            setPendingRequest(null);
            navigation.goBack();
          },
        },
      ]
    );
  };

  const handleSign = () => {
    // Show auth modal for PIN/biometric authentication
    setShowAuthModal(true);
  };

  const handleAuthSuccess = useCallback((pin?: string) => {
    setShowAuthModal(false);
    setIsSigning(true);

    // Navigate to signature display with the request and optional PIN
    // The SignatureDisplayScreen will handle actual signing with the PIN
    navigation.navigate('SignatureDisplay', {
      request,
      pin, // Pass PIN for signing (undefined if biometric was used)
    });
  }, [navigation, request]);

  const handleAuthCancel = useCallback(() => {
    setShowAuthModal(false);
  }, []);

  const renderTransactionSummary = (txn: DecodedTransactionInfo, index: number) => {
    const typeLabel = TRANSACTION_TYPE_LABELS[txn.type];
    const typeIcon = TRANSACTION_TYPE_ICONS[txn.type];

    return (
      <View key={index} style={styles.txnSummaryCard}>
        <View style={styles.txnHeader}>
          <View style={styles.txnTypeContainer}>
            <Ionicons
              name={typeIcon as any}
              size={24}
              color={theme.colors.primary}
            />
            <Text style={styles.txnTypeLabel}>{typeLabel}</Text>
          </View>
          {isGroup && (
            <Text style={styles.txnIndex}>
              {index + 1} of {totalTxns}
            </Text>
          )}
        </View>

        {/* Amount (for payments/transfers) */}
        {txn.amount !== undefined && txn.amount > 0n && (
          <View style={styles.amountContainer}>
            <Text style={styles.amountValue}>
              {formatVoiBalance(txn.amount)}
            </Text>
            <Text style={styles.amountUnit}>
              {txn.assetId ? `ASA #${txn.assetId}` : 'VOI'}
            </Text>
          </View>
        )}

        {/* Key Details */}
        <View style={styles.detailsGrid}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>From</Text>
            <Text style={styles.detailValue}>{formatAddress(txn.sender)}</Text>
          </View>

          {txn.receiver && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>To</Text>
              <Text style={styles.detailValue}>{formatAddress(txn.receiver)}</Text>
            </View>
          )}

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Fee</Text>
            <Text style={styles.detailValue}>
              {formatVoiBalance(txn.fee)} VOI
            </Text>
          </View>

          {txn.appId && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>App ID</Text>
              <Text style={styles.detailValue}>{txn.appId}</Text>
            </View>
          )}
        </View>

        {/* Warning indicators */}
        {txn.rekeyTo && (
          <View style={styles.warningBanner}>
            <Ionicons name="warning" size={20} color={theme.colors.warning} />
            <Text style={styles.warningText}>
              This transaction rekeys the account to {formatAddress(txn.rekeyTo)}
            </Text>
          </View>
        )}

        {txn.closeRemainderTo && (
          <View style={styles.warningBanner}>
            <Ionicons name="warning" size={20} color={theme.colors.error} />
            <Text style={styles.warningText}>
              This transaction closes the account to {formatAddress(txn.closeRemainderTo)}
            </Text>
          </View>
        )}
      </View>
    );
  };

  const renderFullDetails = (txn: DecodedTransactionInfo) => (
    <View style={styles.fullDetailsContainer}>
      <Text style={styles.fullDetailsTitle}>Full Transaction Details</Text>

      <View style={styles.fullDetailRow}>
        <Text style={styles.fullDetailLabel}>Sender</Text>
        <Text style={styles.fullDetailValueMono}>{txn.sender}</Text>
      </View>

      {txn.receiver && (
        <View style={styles.fullDetailRow}>
          <Text style={styles.fullDetailLabel}>Receiver</Text>
          <Text style={styles.fullDetailValueMono}>{txn.receiver}</Text>
        </View>
      )}

      {txn.amount !== undefined && (
        <View style={styles.fullDetailRow}>
          <Text style={styles.fullDetailLabel}>Amount</Text>
          <Text style={styles.fullDetailValue}>{txn.amount.toString()}</Text>
        </View>
      )}

      <View style={styles.fullDetailRow}>
        <Text style={styles.fullDetailLabel}>Fee</Text>
        <Text style={styles.fullDetailValue}>{txn.fee.toString()}</Text>
      </View>

      <View style={styles.fullDetailRow}>
        <Text style={styles.fullDetailLabel}>First Valid</Text>
        <Text style={styles.fullDetailValue}>{txn.firstValid.toString()}</Text>
      </View>

      <View style={styles.fullDetailRow}>
        <Text style={styles.fullDetailLabel}>Last Valid</Text>
        <Text style={styles.fullDetailValue}>{txn.lastValid.toString()}</Text>
      </View>

      {txn.genesisId && (
        <View style={styles.fullDetailRow}>
          <Text style={styles.fullDetailLabel}>Genesis ID</Text>
          <Text style={styles.fullDetailValue}>{txn.genesisId}</Text>
        </View>
      )}

      {txn.note && (
        <View style={styles.fullDetailRow}>
          <Text style={styles.fullDetailLabel}>Note</Text>
          <Text style={styles.fullDetailValueMono}>{txn.note}</Text>
        </View>
      )}

      {txn.assetId && (
        <View style={styles.fullDetailRow}>
          <Text style={styles.fullDetailLabel}>Asset ID</Text>
          <Text style={styles.fullDetailValue}>{txn.assetId}</Text>
        </View>
      )}

      {txn.appId && (
        <View style={styles.fullDetailRow}>
          <Text style={styles.fullDetailLabel}>Application ID</Text>
          <Text style={styles.fullDetailValue}>{txn.appId}</Text>
        </View>
      )}

      {txn.rekeyTo && (
        <View style={styles.fullDetailRow}>
          <Text style={styles.fullDetailLabel}>Rekey To</Text>
          <Text style={styles.fullDetailValueMono}>{txn.rekeyTo}</Text>
        </View>
      )}

      {txn.closeRemainderTo && (
        <View style={styles.fullDetailRow}>
          <Text style={styles.fullDetailLabel}>Close To</Text>
          <Text style={styles.fullDetailValueMono}>{txn.closeRemainderTo}</Text>
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={handleReject}>
          <Ionicons name="close" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Review Transaction</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Request Info */}
        {request.meta?.app && (
          <View style={styles.dappInfo}>
            <Ionicons
              name="globe-outline"
              size={16}
              color={theme.colors.textSecondary}
            />
            <Text style={styles.dappName}>From: {request.meta.app}</Text>
          </View>
        )}

        {/* Network Badge */}
        <View style={styles.networkBadge}>
          <Text style={styles.networkText}>Network: {request.net}</Text>
        </View>

        {/* Transaction Group Summary */}
        {isGroup && (
          <View style={styles.groupSummary}>
            <Ionicons
              name="layers-outline"
              size={20}
              color={theme.colors.primary}
            />
            <Text style={styles.groupText}>
              Atomic Group: {totalTxns} transactions
            </Text>
          </View>
        )}

        {/* Transaction Cards */}
        {isGroup ? (
          // Show all transactions in group
          decodedTransactions.map((txn, index) =>
            renderTransactionSummary(txn, index)
          )
        ) : (
          // Show single transaction
          renderTransactionSummary(currentTxn, 0)
        )}

        {/* Toggle Full Details */}
        <TouchableOpacity
          style={styles.toggleDetailsButton}
          onPress={() => setShowFullDetails(!showFullDetails)}
        >
          <Text style={styles.toggleDetailsText}>
            {showFullDetails ? 'Hide' : 'Show'} Full Details
          </Text>
          <Ionicons
            name={showFullDetails ? 'chevron-up' : 'chevron-down'}
            size={20}
            color={theme.colors.primary}
          />
        </TouchableOpacity>

        {/* Full Details (expandable) */}
        {showFullDetails &&
          decodedTransactions.map((txn, index) => (
            <View key={`full-${index}`}>
              {isGroup && (
                <Text style={styles.fullDetailsTxnHeader}>
                  Transaction {index + 1}
                </Text>
              )}
              {renderFullDetails(txn)}
            </View>
          ))}
      </ScrollView>

      {/* Action Buttons */}
      <View style={styles.actionContainer}>
        <TouchableOpacity
          style={styles.rejectButton}
          onPress={handleReject}
          disabled={isSigning}
        >
          <Ionicons name="close-circle-outline" size={20} color={theme.colors.error} />
          <Text style={styles.rejectButtonText}>Reject</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.signButton, isSigning && styles.buttonDisabled]}
          onPress={handleSign}
          disabled={isSigning}
        >
          {isSigning ? (
            <ActivityIndicator size="small" color={theme.colors.buttonText} />
          ) : (
            <>
              <Ionicons
                name="checkmark-circle-outline"
                size={20}
                color={theme.colors.buttonText}
              />
              <Text style={styles.signButtonText}>
                Sign {isGroup ? `All ${totalTxns}` : ''}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Authentication Modal */}
      <SignerAuthModal
        visible={showAuthModal}
        onSuccess={handleAuthSuccess}
        onCancel={handleAuthCancel}
        transactionCount={totalTxns}
      />
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
    dappInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      marginBottom: theme.spacing.sm,
    },
    dappName: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    networkBadge: {
      backgroundColor: `${theme.colors.primary}15`,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
      alignSelf: 'flex-start',
      marginBottom: theme.spacing.md,
    },
    networkText: {
      fontSize: 12,
      color: theme.colors.primary,
      fontWeight: '500',
    },
    groupSummary: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.card,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    groupText: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
    },
    txnSummaryCard: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    txnHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    txnTypeContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    txnTypeLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    txnIndex: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
      borderRadius: theme.borderRadius.sm,
    },
    amountContainer: {
      alignItems: 'center',
      marginBottom: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    amountValue: {
      fontSize: 28,
      fontWeight: '700',
      color: theme.colors.text,
    },
    amountUnit: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    detailsGrid: {
      gap: theme.spacing.sm,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    detailLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    detailValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: `${theme.colors.warning}15`,
      padding: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      marginTop: theme.spacing.md,
    },
    warningText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.warning,
    },
    toggleDetailsButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.md,
    },
    toggleDetailsText: {
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '500',
    },
    fullDetailsContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    fullDetailsTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    fullDetailsTxnHeader: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: theme.spacing.sm,
      marginTop: theme.spacing.sm,
    },
    fullDetailRow: {
      marginBottom: theme.spacing.sm,
    },
    fullDetailLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginBottom: 2,
    },
    fullDetailValue: {
      fontSize: 14,
      color: theme.colors.text,
    },
    fullDetailValueMono: {
      fontSize: 12,
      color: theme.colors.text,
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
    rejectButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.error,
    },
    rejectButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.error,
    },
    signButton: {
      flex: 2,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.success,
    },
    buttonDisabled: {
      backgroundColor: theme.colors.textMuted,
    },
    signButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
