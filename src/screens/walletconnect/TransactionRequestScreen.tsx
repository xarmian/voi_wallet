import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import algosdk from 'algosdk';

import { RootStackParamList } from '@/navigation/AppNavigator';
import {
  WalletConnectService,
  WalletConnectRequestEvent,
  WalletTransaction,
} from '@/services/walletconnect';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountMetadata, AccountType, LedgerAccountMetadata } from '@/types/wallet';
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
  getChainIdByGenesisHash,
} from '@/services/walletconnect/utils';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

type TransactionRequestScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'WalletConnectTransactionRequest'
>;
type TransactionRequestScreenRouteProp = RouteProp<
  RootStackParamList,
  'WalletConnectTransactionRequest'
>;

interface Props {
  navigation: TransactionRequestScreenNavigationProp;
  route: TransactionRequestScreenRouteProp;
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

export default function TransactionRequestScreen({ navigation, route }: Props) {
  const { requestEvent } = route.params;
  const version = (route.params as any)?.version as number | undefined;
  const autoRetry = (route.params as any)?.autoRetry as boolean | undefined;
  const [isLoading, setIsLoading] = useState(false);
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [currentRequest, setCurrentRequest] = useState<UnifiedTransactionRequest | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [parsedTransactions, setParsedTransactions] = useState<
    ParsedTransaction[]
  >([]);
  const [selectedAccount, setSelectedAccount] =
    useState<AccountMetadata | null>(null);
  const [accounts, setAccounts] = useState<AccountMetadata[]>([]);
  const [networkName, setNetworkName] = useState<string>('Unknown Network');
  const [networkCurrency, setNetworkCurrency] = useState<string>('TOKEN');

  // Use the unified auth controller
  const authController = useTransactionAuthController();

  useEffect(() => {
    loadAccountsAndTransactions();
  }, []);

  useEffect(() => {
    return () => {
      authController.cleanup();
    };
  }, [authController]);

  useEffect(() => {
    // If autoRetry flag is passed, immediately start the auth flow
    if (autoRetry && selectedAccount) {
      handleApprove();
    }
  }, [autoRetry, selectedAccount]);

  const loadAccountsAndTransactions = async () => {
    try {
      // Load accounts
      const allAccounts = await MultiAccountWalletService.getAllAccounts();
      setAccounts(allAccounts);

      const eventParams = (requestEvent as any).params;
      if (!eventParams) {
        throw new Error('Malformed request: missing params');
      }

      const paramsWrapper = eventParams;
      const initialChainId = paramsWrapper.chainId as string | undefined;
      const { request } = paramsWrapper;
      let derivedChainId: string | null = null;

      if (request.method === 'algo_signTxn') {
        // Support both WC param shapes: { txn: WalletTransaction[] } or [ WalletTransaction[] ]
        let txns: WalletTransaction[] | undefined;
        if (Array.isArray(request.params)) {
          txns = (request.params[0] as WalletTransaction[]) || [];
        } else if (request.params?.txn) {
          txns = request.params.txn as WalletTransaction[];
        }

        if (!txns || !Array.isArray(txns)) {
          throw new Error('Malformed request: missing transactions array');
        }
        setTransactions(txns);

        // Parse transactions for display
        const parsed: ParsedTransaction[] = [];

        for (const wtxn of txns) {
          try {
            const txnBytes = Buffer.from(wtxn.txn, 'base64');
            const txn = algosdk.decodeUnsignedTransaction(txnBytes);
            const txnAny = txn as any;

            if (!derivedChainId) {
              const genesisSource =
                txnAny.genesisHash || txnAny.gh || txn?.genesisHash;

              const chainIdFromGenesis = getChainIdByGenesisHash(genesisSource);
              if (chainIdFromGenesis) {
                derivedChainId = chainIdFromGenesis;
              }
            }

            // Extract transaction details using the correct Algorand structure
            let fromAddress = 'N/A';
            let toAddress = 'N/A';
            let amount = 0;

            if (txnAny.sender && txnAny.sender.publicKey) {
              fromAddress = algosdk.encodeAddress(txnAny.sender.publicKey);
            }

            const txnType = txnAny.type || 'unknown';

            if (txnType === 'pay' && txnAny.payment) {
              if (txnAny.payment.receiver && txnAny.payment.receiver.publicKey) {
                toAddress = algosdk.encodeAddress(
                  txnAny.payment.receiver.publicKey
                );
              }
              amount = txnAny.payment.amount ? Number(txnAny.payment.amount) : 0;
            } else if (txnType === 'axfer' && txnAny.assetTransfer) {
              if (
                txnAny.assetTransfer.receiver &&
                txnAny.assetTransfer.receiver.publicKey
              ) {
                toAddress = algosdk.encodeAddress(
                  txnAny.assetTransfer.receiver.publicKey
                );
              }
              amount = txnAny.assetTransfer.amount
                ? Number(txnAny.assetTransfer.amount)
                : 0;
            }

            parsed.push({
              from: fromAddress,
              to: toAddress,
              amount,
              fee: txnAny.fee ? Number(txnAny.fee) : 0,
              note: txnAny.note ? Buffer.from(txnAny.note).toString() : undefined,
              assetId: txnAny.assetIndex,
              type: txnType,
            });
          } catch (error) {
            console.error('Failed to parse transaction:', error);
            console.error('Transaction data:', wtxn);
            parsed.push({
              from: 'Parse Error',
              to: 'Parse Error',
              amount: 0,
              fee: 0,
              type: 'parse_error',
            });
          }
        }

        setParsedTransactions(parsed);

        // Set default account (first account that can sign for the transaction)
        if (parsed.length > 0) {
          const firstTxn = parsed[0];
          const account = allAccounts.find(
            (acc) => acc.address === firstTxn.from
          );
          if (account) {
            setSelectedAccount(account);
          }
        }
      }

      const effectiveChainId = derivedChainId || initialChainId;
      if (effectiveChainId) {
        setNetworkName(getNetworkNameByChainId(effectiveChainId));
        setNetworkCurrency(getNetworkCurrencyByChainId(effectiveChainId));
        eventParams.chainId = effectiveChainId;
      } else {
        setNetworkName('Unknown Network');
        setNetworkCurrency('TOKEN');
      }
    } catch (error) {
      console.error('Failed to load transaction request:', error);
      Alert.alert('Error', 'Failed to parse transaction request');
    }
  };

  const handleApprove = () => {
    if (!selectedAccount) {
      Alert.alert('Error', 'Please select an account to sign with');
      return;
    }

    // Create unified transaction request for WalletConnect batch
    const request: UnifiedTransactionRequest = {
      type: 'walletconnect_batch',
      account: selectedAccount,
      walletConnectParams: {
        transactions,
        accountAddress: selectedAccount.address,
      },
    };

    setCurrentRequest(request);
    setShowAuthModal(true);
  };

  const handleAuthComplete = async (success: boolean, result?: any) => {
    setShowAuthModal(false);
    setCurrentRequest(null);

    if (success && result?.signedTransactions) {
      try {
        // Use v1 client for v1 requests, otherwise use v2
        if (version === 1) {
          // Handle v1 response
          const v1Client = WalletConnectV1Client.getInstance();
          await v1Client.approveRequest(
            (requestEvent as any).id,
            result.signedTransactions
          );
        } else {
          // Handle v2 response
          const wcService = WalletConnectService.getInstance();
          await wcService.respondToRequest(
            (requestEvent as any).topic,
            (requestEvent as any).id,
            result.signedTransactions
          );
        }

        Alert.alert('Success', 'Transactions signed and returned to the dApp.', [
          {
            text: 'OK',
            onPress: () => {
              if (navigation.canGoBack()) {
                navigation.goBack();
              } else {
                navigation.navigate('Main', { screen: 'Home' });
              }
            },
          },
        ]);
      } catch (error) {
        console.error('Failed to respond to WalletConnect:', error);
        const errorMessage = error instanceof Error
          ? error.message
          : 'Failed to respond to dApp';
        navigation.navigate('WalletConnectError', { error: errorMessage });
      }
    } else {
      // Handle signing failure
      const errorMessage = result instanceof Error
        ? result.message
        : 'Failed to sign transactions';
      navigation.navigate('WalletConnectError', { error: errorMessage });
    }
  };

  const handleReject = async () => {
    try {
      // Use v1 client for v1 requests, otherwise use v2
      if (version === 1) {
        // Handle v1 rejection
        const v1Client = WalletConnectV1Client.getInstance();
        await v1Client.rejectRequest(
          (requestEvent as any).id,
          'User rejected the request'
        );
      } else {
        // Handle v2 rejection
        const wcService = WalletConnectService.getInstance();
        await wcService.rejectRequest((requestEvent as any).topic, (requestEvent as any).id, {
          code: 5001,
          message: 'User rejected the request',
        });
      }

      Alert.alert('Rejected', 'Transaction request rejected', [
        {
          text: 'OK',
          onPress: () => {
            if (navigation.canGoBack()) {
              navigation.goBack();
            } else {
              navigation.navigate('Main', { screen: 'Home' });
            }
          },
        },
      ]);
    } catch (error) {
      console.error('Failed to reject request:', error);
      Alert.alert('Error', 'Failed to reject transaction request');
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
      {selectedAccount && (
        <View style={styles.selectedAccount}>
          <View
            style={[
              styles.accountColor,
              { backgroundColor: selectedAccount.color },
            ]}
          />
          <View style={styles.accountInfo}>
            <Text style={styles.accountLabel}>{selectedAccount.label}</Text>
            <Text style={styles.accountAddress}>
              {truncateAddress(selectedAccount.address)}
            </Text>
          </View>
          <Text style={styles.accountType}>{selectedAccount.type}</Text>
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <UniversalHeader
        title="Sign Transaction"
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.dappContainer}>
          <Text style={styles.dappName}>Transaction Request</Text>
          <Text style={styles.requestMethod}>
            {(requestEvent as any).params.request.method}
          </Text>
        </View>

        <View style={styles.networkContainer}>
          <View style={styles.networkHeader}>
            <Ionicons name="globe" size={20} color={theme.colors.primary} />
            <Text style={styles.networkTitle}>Network</Text>
          </View>
          <Text style={styles.networkName}>{networkName}</Text>
          <Text style={styles.networkCurrency}>
            Currency: {networkCurrency}
          </Text>
        </View>

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
          disabled={!selectedAccount}
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
    dappContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 20,
      marginBottom: 16,
      alignItems: 'center',
      ...theme.shadows.sm,
    },
    dappName: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 4,
    },
    requestMethod: {
      fontSize: 12,
      color: theme.colors.primary,
      textTransform: 'uppercase',
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
      borderColor: theme.colors.warning + '40', // Add a subtle border for better visibility
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
