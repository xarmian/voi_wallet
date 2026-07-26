import React, { useState, useEffect, useMemo } from 'react';
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
import Toast from 'react-native-toast-message';

import { RootStackParamList } from '@/navigation/AppNavigator';
import {
  WalletConnectService,
  WalletTransaction,
} from '@/services/walletconnect';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountMetadata, WalletAccount } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import UniversalHeader from '@/components/common/UniversalHeader';
import UnifiedTransactionAuthModal from '@/components/UnifiedTransactionAuthModal';
import { useTransactionAuthController } from '@/services/auth/transactionAuthController';
import {
  UnifiedTransactionRequest,
  WalletConnectSessionBinding,
} from '@/services/transactions/unifiedSigner';
import {
  truncateAddress,
  getNetworkNameByChainId,
  getNetworkCurrencyByChainId,
  getNetworkByChainId,
  formatAccountAddress,
} from '@/services/walletconnect/utils';
import { resolveV1Chain } from '@/services/walletconnect/v1/config';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';
import { registerNavigationCallbacks } from '@/services/navigation/callbackRegistry';
import TransactionDangerBanner from '@/components/transaction/TransactionDangerBanner';
import {
  detectTransactionDangers,
  aggregateDangers,
  hasAnyDanger,
  TransactionDangers,
} from '@/utils/transactionDangers';

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

export default function TransactionRequestScreen({ navigation, route }: Props) {
  const { requestEvent } = route.params;
  const version = (route.params as any)?.version as number | undefined;
  const autoRetry = (route.params as any)?.autoRetry as boolean | undefined;
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [currentRequest, setCurrentRequest] =
    useState<UnifiedTransactionRequest | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [selectedAccount, setSelectedAccount] =
    useState<AccountMetadata | null>(null);
  const [networkName, setNetworkName] = useState<string>('Unknown Network');
  const [networkCurrency, setNetworkCurrency] = useState<string>('TOKEN');
  const [sessionBinding, setSessionBinding] =
    useState<WalletConnectSessionBinding | null>(null);
  const [dangerAcknowledged, setDangerAcknowledged] = useState(false);

  // Use the unified auth controller
  const authController = useTransactionAuthController();

  // S-01: derive authority-transfer / balance-sweep dangers directly from the
  // WalletConnect transactions that would be signed on this screen's direct path.
  const aggregatedDangers = useMemo<TransactionDangers>(() => {
    const list: TransactionDangers[] = [];
    for (const wtxn of transactions) {
      try {
        const txnBytes = Buffer.from(wtxn.txn, 'base64');
        const decoded = algosdk.decodeUnsignedTransaction(txnBytes);
        list.push(detectTransactionDangers(decoded));
      } catch {
        // Pre-signed / undecodable transaction — no danger fields surfaced.
      }
    }
    return aggregateDangers(list);
  }, [transactions]);
  const hasDanger = hasAnyDanger(aggregatedDangers);

  useEffect(() => {
    loadAccountsAndTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount; loadAccountsAndTransactions is read at the mount commit.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot auto-retry trigger keyed on autoRetry/selectedAccount; handleApprove is read at that commit and must not re-fire on its own identity.
  }, [autoRetry, selectedAccount]);

  const loadAccountsAndTransactions = async () => {
    try {
      // Load accounts
      const allAccounts = await MultiAccountWalletService.getAllAccounts();

      const eventParams = (requestEvent as any).params;
      if (!eventParams) {
        throw new Error('Malformed request: missing params');
      }

      const paramsWrapper = eventParams;
      const { request } = paramsWrapper;

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

        // DR-7 / DR-11 / DR-14 — resolve the chain the REQUEST is scoped to.
        // This is deliberately the chain the dApp/session declares, never one
        // derived from the transaction bytes: deriving it from the bytes would
        // make the binding circular, and the signer's job is to verify that the
        // bytes match this chain.
        const requestChainId = paramsWrapper.chainId;
        let chainId: string;
        let chainNetworkId: NetworkId;

        if (version === 1) {
          const resolved = resolveV1Chain(Number(requestChainId));
          if (!resolved) {
            throw new Error(
              'This WalletConnect v1 session uses a network this wallet cannot ' +
                'identify (v1 sessions carry an ambiguous numeric chain id). ' +
                'Please reconnect the dApp using WalletConnect v2.'
            );
          }
          chainId = resolved.chainId;
          chainNetworkId = resolved.networkId;
        } else {
          if (typeof requestChainId !== 'string' || !requestChainId) {
            throw new Error('Malformed request: missing chain id');
          }
          const resolved = getNetworkByChainId(requestChainId);
          if (!resolved) {
            throw new Error(
              'This request targets a network this wallet does not support.'
            );
          }
          chainId = requestChainId;
          chainNetworkId = resolved;
        }

        setNetworkName(getNetworkNameByChainId(chainId));
        setNetworkCurrency(getNetworkCurrencyByChainId(chainId));

        // DR-5 / DR-14 — the accounts the LIVE session approved for THIS chain,
        // as full CAIP-10 strings. Empty means absent / expired / disconnected /
        // topic-mismatched, which is a rejection: local accounts are never
        // substituted for the session's.
        const requestTopic = (requestEvent as any).topic as string | undefined;
        const approvedAccounts = requestTopic
          ? WalletConnectService.getInstance().getApprovedAccountsForChain(
              requestTopic,
              chainId
            )
          : [];

        if (approvedAccounts.length === 0) {
          throw new Error(
            'This dApp session has no approved account on ' +
              `${getNetworkNameByChainId(chainId)}. Reconnect the session and try again.`
          );
        }

        const binding: WalletConnectSessionBinding = {
          topic: requestTopic!,
          chainId,
          networkId: chainNetworkId,
          approvedAccounts,
        };
        setSessionBinding(binding);

        // Choose the account to review. DR-13 keeps signing eligibility narrow —
        // only the REVIEWED account signs — so this must pick an account that is
        // both ours and session-approved for this chain, rather than defaulting
        // to `allAccounts[0]` (which would review one account and then decline
        // every entry). The first eligible sender in the group wins; a group
        // whose first entry is a pool/logic-sig transaction still resolves to
        // the user's own account further down the list.
        let signingAccount: AccountMetadata | undefined;
        for (const wtxn of txns) {
          let senderAddress: string | null = null;
          try {
            const txn = algosdk.decodeUnsignedTransaction(
              Buffer.from(wtxn.txn, 'base64')
            );
            if (txn.sender?.publicKey) {
              senderAddress = algosdk.encodeAddress(txn.sender.publicKey);
            }
          } catch {
            // Pre-signed / undecodable entry — it names no signer of ours.
            continue;
          }

          if (!senderAddress) {
            continue;
          }
          if (
            !approvedAccounts.includes(
              formatAccountAddress(chainId, senderAddress)
            )
          ) {
            continue;
          }
          const match = allAccounts.find(
            (acc) => acc.address === senderAddress
          );
          if (match) {
            signingAccount = match;
            break;
          }
        }

        if (!signingAccount) {
          // No account this session approved on this chain is available to sign
          // (e.g. every account was removed after the session was approved).
          // Surface an explicit error rather than stranding the user on an
          // empty review screen or reviewing an account that cannot sign.
          throw new Error('No account available to sign this request');
        }

        setSelectedAccount(signingAccount);

        // Register callbacks in the callback registry to avoid serialization warnings
        const callbackId = registerNavigationCallbacks({
          onSuccess: async (result: any) => {
            await handleWalletConnectSuccess(result);
          },
          onReject: async () => {
            await handleReject();
          },
        });

        navigation.replace('UniversalTransactionSigning', {
          // Display bytes. `walletConnect.transactions` below is the authority
          // for both review and signing; this stays index-aligned with it.
          transactions: txns.map((wtxn) => wtxn.txn),
          // Nav param is typed WalletAccount (legacy); the screen coerces it back
          // to AccountMetadata at runtime. Matches the existing cast pattern used
          // by the other callers of this route (e.g. SwapScreen).
          account: signingAccount as unknown as WalletAccount,
          chainId,
          networkId: chainNetworkId,
          title: 'WalletConnect Request',
          callbackId,
          // DR-15: the real ARC-0001 entries (signers / authAddr / msig) plus
          // the session + chain the signer must bind every entry to.
          walletConnect: { transactions: txns, binding },
        });
      } else {
        // The normal path (algo_signTxn) always navigates away to
        // UniversalTransactionSigning above; any other method has no review UI on
        // this screen, so fail explicitly instead of leaving a blank screen.
        throw new Error(`Unsupported request method: ${request.method}`);
      }
    } catch (error) {
      console.error('Failed to load transaction request:', error);
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to parse transaction request';
      // Route to the dedicated error screen (replace, so the user cannot return
      // to this now-empty screen) rather than showing an alert on a blank page.
      navigation.replace('WalletConnectError', { error: message });
    }
  };

  const handleApprove = () => {
    if (hasDanger && !dangerAcknowledged) {
      Alert.alert(
        'Confirmation required',
        'Please acknowledge the highlighted account-security warning before signing.'
      );
      return;
    }

    if (!selectedAccount) {
      Alert.alert('Error', 'Please select an account to sign with');
      return;
    }

    if (!sessionBinding) {
      // Fail closed: without a resolved session + chain there is nothing to bind
      // the signature to, so there is no safe way to sign here.
      Alert.alert(
        'Error',
        'This request is not bound to an active session. Reconnect the dApp and try again.'
      );
      return;
    }

    // Create unified transaction request for WalletConnect batch
    const request: UnifiedTransactionRequest = {
      type: 'walletconnect_batch',
      account: selectedAccount,
      networkId: sessionBinding.networkId,
      walletConnectParams: {
        transactions,
        accountAddress: selectedAccount.address,
        sessionBinding,
      },
    };

    setCurrentRequest(request);
    setShowAuthModal(true);
  };

  const handleWalletConnectSuccess = async (result: any) => {
    if (result?.signedTransactions) {
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

        // Check if there are pending requests in the queue
        const nextRequest = await TransactionRequestQueue.peek();
        const queueSize = await TransactionRequestQueue.size();

        // Show non-blocking toast with queue info
        Toast.show({
          type: 'walletConnectSuccess',
          text1: 'Transaction Signed Successfully',
          text2: `Your transaction has been signed and sent back to the dApp. ${queueSize > 0 ? 'Processing next request...' : 'You can now return to the dApp.'}`,
          visibilityTime: 5000,
          position: 'top',
          props: {
            queueSize,
          },
        });

        if (nextRequest) {
          // Atomically dequeue only if the request matches (prevents race conditions)
          const dequeuedRequest = await TransactionRequestQueue.dequeueIfMatch(
            nextRequest.id,
            nextRequest.topic
          );

          if (dequeuedRequest) {
            // Navigate to the next transaction request
            navigation.replace('WalletConnectTransactionRequest', {
              requestEvent: dequeuedRequest,
              version: dequeuedRequest.version,
            });
          } else {
            // Queue changed, navigate back
            if (navigation.canGoBack()) {
              navigation.goBack();
            } else {
              navigation.navigate('Main', { screen: 'Home' });
            }
          }
        } else {
          // No pending requests, navigate back
          if (navigation.canGoBack()) {
            navigation.goBack();
          } else {
            navigation.navigate('Main', { screen: 'Home' });
          }
        }
      } catch (error) {
        console.error('Failed to respond to WalletConnect:', error);
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to respond to dApp';
        navigation.navigate('WalletConnectError', { error: errorMessage });
      }
    } else {
      // Handle signing failure
      const errorMessage = 'Failed to sign transactions';
      navigation.navigate('WalletConnectError', { error: errorMessage });
    }
  };

  const handleAuthComplete = async (success: boolean, result?: any) => {
    setShowAuthModal(false);
    setCurrentRequest(null);

    if (success && result?.signedTransactions) {
      await handleWalletConnectSuccess(result);
    } else {
      // Handle signing failure
      const errorMessage =
        result instanceof Error
          ? result.message
          : 'Failed to sign transactions';
      navigation.navigate('WalletConnectError', { error: errorMessage });
    }
  };

  const handleReject = async () => {
    let rejectionSent = false;
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
        await wcService.rejectRequest(
          (requestEvent as any).topic,
          (requestEvent as any).id,
          {
            code: 5001,
            message: 'User rejected the request',
          }
        );
      }
      rejectionSent = true;
    } catch (error) {
      console.error('Failed to reject request:', error);
    }

    // Check if there are pending requests in the queue
    const nextRequest = await TransactionRequestQueue.peek();
    const queueSize = await TransactionRequestQueue.size();

    if (rejectionSent) {
      // Show non-blocking toast with queue info when rejection was sent
      Toast.show({
        type: 'walletConnectRejected',
        text1: 'Transaction Request Rejected',
        text2: `You declined to sign this transaction. ${
          queueSize > 0
            ? 'Processing next request...'
            : 'You can return to the dApp.'
        }`,
        visibilityTime: 4000,
        position: 'top',
        props: {
          queueSize,
        },
      });
    }

    if (nextRequest) {
      // Atomically dequeue only if the request matches (prevents race conditions)
      const dequeuedRequest = await TransactionRequestQueue.dequeueIfMatch(
        nextRequest.id,
        nextRequest.topic
      );

      if (dequeuedRequest) {
        // Navigate to the next transaction request
        navigation.replace('WalletConnectTransactionRequest', {
          requestEvent: dequeuedRequest,
          version: dequeuedRequest.version,
        });
      } else {
        // Queue changed, navigate back
        if (navigation.canGoBack()) {
          navigation.goBack();
        } else {
          navigation.navigate('Main', { screen: 'Home' });
        }
      }
    } else {
      // No pending requests, navigate back
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate('Main', { screen: 'Home' });
      }
    }
  };

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
            {(requestEvent as any)?.params?.request?.method ?? 'Unknown'}
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

        {hasDanger && (
          <TransactionDangerBanner
            dangers={aggregatedDangers}
            acknowledged={dangerAcknowledged}
            onToggleAcknowledged={() => setDangerAcknowledged((v) => !v)}
          />
        )}

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
          disabled={!selectedAccount || (hasDanger && !dangerAcknowledged)}
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
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 12,
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
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(255,149,0,0.1)'
          : 'rgba(255,159,10,0.15)',
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
