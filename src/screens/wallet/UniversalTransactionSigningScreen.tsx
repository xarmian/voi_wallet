import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import algosdk from 'algosdk';

import { RootStackParamList } from '@/navigation/AppNavigator';
import { AccountMetadata } from '@/types/wallet';
import UniversalHeader from '@/components/common/UniversalHeader';
import UnifiedTransactionAuthModal from '@/components/UnifiedTransactionAuthModal';
import {
  useTransactionAuthController,
} from '@/services/auth/transactionAuthController';
import {
  UnifiedTransactionRequest,
} from '@/services/transactions/unifiedSigner';
import {
  truncateAddress,
  getNetworkNameByChainId,
  getNetworkCurrencyByChainId,
} from '@/services/walletconnect/utils';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { NetworkId } from '@/types/network';
import {
  getNavigationCallbacks,
  clearNavigationCallbacks,
} from '@/services/navigation/callbackRegistry';

type UniversalTransactionSigningScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'UniversalTransactionSigning'
>;
type UniversalTransactionSigningScreenRouteProp = RouteProp<
  RootStackParamList,
  'UniversalTransactionSigning'
>;

interface Props {
  navigation: UniversalTransactionSigningScreenNavigationProp;
  route: UniversalTransactionSigningScreenRouteProp;
}

interface ParsedTransaction {
  from: string;
  to: string;
  amount?: number;
  fee: number;
  note?: string;
  assetId?: number;
  type: string;
}

export default function UniversalTransactionSigningScreen({ navigation, route }: Props) {
  const {
    transactions,
    account,
    onSuccess: directOnSuccess,
    onReject: directOnReject,
    callbackId,
    title = 'Sign Transaction',
    networkId,
    chainId,
  } = route.params;

  // Get callbacks from registry if callbackId provided, otherwise use direct callbacks
  const registryCallbacks = getNavigationCallbacks(callbackId);
  const onSuccess = registryCallbacks?.onSuccess || directOnSuccess;
  const onReject = registryCallbacks?.onReject || directOnReject;

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [currentRequest, setCurrentRequest] = useState<UnifiedTransactionRequest | null>(null);
  const [parsedTransactions, setParsedTransactions] = useState<ParsedTransaction[]>([]);
  const [decodedTransactions, setDecodedTransactions] = useState<algosdk.Transaction[]>([]);
  const [networkName, setNetworkName] = useState<string>('Unknown Network');
  const [networkCurrency, setNetworkCurrency] = useState<string>('VOI');

  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const authController = useTransactionAuthController();

  useEffect(() => {
    parseTransactions();
    return () => {
      authController.cleanup();
      // Clean up callback registry when unmounting
      clearNavigationCallbacks(callbackId);
    };
  }, []);

  useEffect(() => {
    // Set network information from chainId or networkId
    if (chainId) {
      setNetworkName(getNetworkNameByChainId(chainId));
      setNetworkCurrency(getNetworkCurrencyByChainId(chainId));
    } else if (networkId) {
      // Handle networkId (e.g., from SwapScreen)
      if (networkId === 'algorand-mainnet' || networkId === 'algorand-testnet') {
        setNetworkName('Algorand');
        setNetworkCurrency('ALGO');
      } else if (networkId === 'voi-mainnet' || networkId === 'voi-testnet') {
        setNetworkName('Voi Network');
        setNetworkCurrency('VOI');
      }
    }
  }, [chainId, networkId]);

  const parseTransactions = () => {
    try {
      const parsed: ParsedTransaction[] = [];
      const decoded: algosdk.Transaction[] = [];

      for (const txnBase64 of transactions) {
        try {
          const txnBytes = Buffer.from(txnBase64, 'base64');
          let txn: algosdk.Transaction;
          let isAlreadySigned = false;

          // Try to decode as unsigned first
          try {
            txn = algosdk.decodeUnsignedTransaction(txnBytes);
          } catch {
            // If that fails, try to decode as signed transaction
            try {
              const signedTxn = algosdk.decodeSignedTransaction(txnBytes);
              txn = signedTxn.txn;
              isAlreadySigned = true;
            } catch {
              // Neither worked - skip this transaction
              parsed.push({
                from: 'Pre-signed',
                to: 'Protocol Transaction',
                amount: 0,
                fee: 0,
                type: 'logic_sig',
              });
              continue;
            }
          }

          const txnAny = txn as any;

          // Cache the decoded transaction (only if unsigned - we'll sign it)
          if (!isAlreadySigned) {
            decoded.push(txn);
          }

          // Extract transaction details
          let fromAddress = 'N/A';
          let toAddress = 'N/A';
          let amount = 0;

          if (txnAny.from && txnAny.from.publicKey) {
            fromAddress = algosdk.encodeAddress(txnAny.from.publicKey);
          } else if (txnAny.sender && txnAny.sender.publicKey) {
            fromAddress = algosdk.encodeAddress(txnAny.sender.publicKey);
          }

          const txnType = txnAny.type || 'unknown';

          if (txnType === 'pay' && txnAny.payment) {
            if (txnAny.payment.receiver && txnAny.payment.receiver.publicKey) {
              toAddress = algosdk.encodeAddress(txnAny.payment.receiver.publicKey);
            }
            amount = txnAny.payment.amount ? Number(txnAny.payment.amount) : 0;
          } else if (txnType === 'axfer' && txnAny.assetTransfer) {
            if (txnAny.assetTransfer.receiver && txnAny.assetTransfer.receiver.publicKey) {
              toAddress = algosdk.encodeAddress(txnAny.assetTransfer.receiver.publicKey);
            }
            amount = txnAny.assetTransfer.amount ? Number(txnAny.assetTransfer.amount) : 0;
          } else if (txnType === 'appl') {
            // Application call
            toAddress = 'App Call';
          }

          parsed.push({
            from: fromAddress,
            to: toAddress,
            amount,
            fee: txnAny.fee ? Number(txnAny.fee) : 0,
            note: txnAny.note ? Buffer.from(txnAny.note).toString() : undefined,
            assetId: txnAny.assetIndex,
            type: isAlreadySigned ? `${txnType} (pre-signed)` : txnType,
          });
        } catch (error) {
          console.error('Failed to parse transaction:', error);
          parsed.push({
            from: 'Pre-signed',
            to: 'Protocol Transaction',
            amount: 0,
            fee: 0,
            type: 'logic_sig',
          });
        }
      }

      setParsedTransactions(parsed);
      setDecodedTransactions(decoded);
    } catch (error) {
      console.error('Failed to parse transactions:', error);
      Alert.alert('Error', 'Failed to parse transactions');
    }
  };

  const handleApprove = () => {
    if (!account) {
      Alert.alert('Error', 'Account information is missing');
      return;
    }

    // Build the transaction list
    const allTransactions = transactions.map((txn) => ({ txn, signers: [account.address] }));
    const allDecodedTransactions = decodedTransactions.length === transactions.length ? [...decodedTransactions] : undefined;

    // Create unified transaction request for batch signing
    const request: UnifiedTransactionRequest = {
      type: 'batch_transaction',
      account,
      walletConnectParams: {
        transactions: allTransactions,
        accountAddress: account.address,
        decodedTransactions: allDecodedTransactions,
      },
    };

    setCurrentRequest(request);
    setShowAuthModal(true);
  };

  const handleAuthComplete = async (success: boolean, result?: any) => {
    setShowAuthModal(false);
    setCurrentRequest(null);

    if (success && onSuccess) {
      await onSuccess(result);
    } else if (!success) {
      const errorMessage = result instanceof Error ? result.message : 'Failed to sign transactions';
      Alert.alert('Error', errorMessage);
    }
  };

  const handleReject = async () => {
    if (onReject) {
      await onReject();
    } else {
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate('Main', { screen: 'Home' });
      }
    }
  };

  const renderTransactionSummary = () => (
    <View style={styles.summaryContainer}>
      <Text style={styles.sectionTitle}>Transaction Summary</Text>

      {parsedTransactions.map((txn, index) => (
        <View key={index} style={styles.transactionItem}>
          <Text style={styles.transactionTitle}>Transaction {index + 1}</Text>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Type:</Text>
            <Text style={styles.detailValue}>{txn.type}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>From:</Text>
            <Text style={styles.detailValue}>{truncateAddress(txn.from)}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>To:</Text>
            <Text style={styles.detailValue}>{truncateAddress(txn.to)}</Text>
          </View>
          {txn.amount !== undefined && txn.amount > 0 && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Amount:</Text>
              <Text style={styles.detailValue}>
                {(txn.amount / 1000000).toFixed(6)}{' '}
                {txn.assetId ? 'ASA' : networkCurrency}
              </Text>
            </View>
          )}
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Fee:</Text>
            <Text style={styles.detailValue}>
              {(Number(txn.fee) / 1000000).toFixed(6)} {networkCurrency}
            </Text>
          </View>
          {txn.note && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Note:</Text>
              <Text style={styles.detailValue}>{txn.note}</Text>
            </View>
          )}
        </View>
      ))}
    </View>
  );

  const renderAccountSelector = () => (
    <View style={styles.accountContainer}>
      <Text style={styles.sectionTitle}>Sign with Account</Text>
      {account && (
        <View style={styles.selectedAccount}>
          <View
            style={[
              styles.accountColor,
              { backgroundColor: account.color },
            ]}
          />
          <View style={styles.accountInfo}>
            <Text style={styles.accountLabel}>{account.label}</Text>
            <Text style={styles.accountAddress}>
              {truncateAddress(account.address)}
            </Text>
          </View>
          <Text style={styles.accountType}>{account.type}</Text>
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <UniversalHeader
        title={title}
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {networkName !== 'Unknown Network' && (
          <View style={styles.networkContainer}>
            <View style={styles.networkHeader}>
              <Ionicons name="globe" size={20} color={theme.colors.primary} />
              <Text style={styles.networkTitle}>Network</Text>
            </View>
            <Text style={styles.networkName}>{networkName}</Text>
            <Text style={styles.networkCurrency}>Currency: {networkCurrency}</Text>
          </View>
        )}

        {renderTransactionSummary()}
        {renderAccountSelector()}

        <View style={styles.warningContainer}>
          <Ionicons name="warning" size={24} color={theme.colors.warning} />
          <Text style={styles.warningText}>
            Carefully review all transaction details before signing. This action
            cannot be undone.
          </Text>
        </View>
      </ScrollView>

      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, styles.rejectButton]}
          onPress={handleReject}
          disabled={false}
        >
          <Text style={styles.rejectButtonText}>Reject</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.approveButton]}
          onPress={handleApprove}
          disabled={!account}
        >
          <Text style={styles.approveButtonText}>Sign</Text>
        </TouchableOpacity>
      </View>

      <UnifiedTransactionAuthModal
        visible={showAuthModal}
        controller={authController}
        request={currentRequest}
        onComplete={handleAuthComplete}
        onCancel={() => {
          setShowAuthModal(false);
          setCurrentRequest(null);
        }}
        title="Sign Transaction"
        message="Authenticate to sign the transaction"
      />
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    scrollView: {
      flex: 1,
      padding: 16,
    },
    scrollContent: {
      paddingBottom: theme.spacing.xl + 96,
    },
    networkContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      ...theme.shadows.sm,
    },
    networkHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 8,
    },
    networkTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginLeft: 8,
    },
    networkName: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.colors.primary,
      marginBottom: 4,
    },
    networkCurrency: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
    summaryContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      ...theme.shadows.sm,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 12,
    },
    transactionItem: {
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: 12,
      marginBottom: 12,
    },
    transactionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 8,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 4,
    },
    detailLabel: {
      fontSize: 12,
      color: theme.colors.textMuted,
      flex: 1,
    },
    detailValue: {
      fontSize: 12,
      color: theme.colors.text,
      fontWeight: '500',
      flex: 2,
      textAlign: 'right',
    },
    accountContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      ...theme.shadows.sm,
    },
    selectedAccount: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
    },
    accountColor: {
      width: 12,
      height: 12,
      borderRadius: 6,
      marginRight: 12,
    },
    accountInfo: {
      flex: 1,
    },
    accountLabel: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 2,
    },
    accountAddress: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    accountType: {
      fontSize: 11,
      color: theme.colors.primary,
      textTransform: 'uppercase',
    },
    warningContainer: {
      flexDirection: 'row',
      backgroundColor: theme.mode === 'light' ? 'rgba(255,149,0,0.1)' : 'rgba(255,159,10,0.15)',
      borderWidth: 1,
      borderColor: theme.colors.warning + '40',
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    warningText: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.warning,
      marginLeft: 12,
      lineHeight: 20,
    },
    buttonContainer: {
      flexDirection: 'row',
      padding: 16,
      paddingTop: 8,
      backgroundColor: theme.colors.surface,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    button: {
      flex: 1,
      height: 48,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
      marginHorizontal: 8,
    },
    rejectButton: {
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    rejectButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textMuted,
    },
    approveButton: {
      backgroundColor: theme.colors.primary,
    },
    approveButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
