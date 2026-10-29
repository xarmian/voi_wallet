import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
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
import {
  reviewGrant,
  walletConnectRequestKey,
} from '@/services/auth/reviewGrant';
import { WalletConnectSessionBinding } from '@/services/transactions/unifiedSigner';
import {
  getNetworkNameByChainId,
  getNetworkByChainId,
  formatAccountAddress,
} from '@/services/walletconnect/utils';
import { resolveV1Chain } from '@/services/walletconnect/v1/config';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  QueuedTransactionRequest,
  TransactionRequestQueue,
} from '@/services/walletconnect/TransactionRequestQueue';
import { registerNavigationCallbacks } from '@/services/navigation/callbackRegistry';

type TransactionRequestScreenNavigationProp = NativeStackNavigationProp<
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
  const requestKey = walletConnectRequestKey(
    (requestEvent as any)?.topic ?? '',
    (requestEvent as any)?.id ?? ''
  );
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  // True while a rejection is being sent and the next request taken.
  const rejectingRef = useRef(false);

  // Set once this request's outcome is decided: an answer was attempted (a
  // failed attempt clears the mark itself) or the mark was already cleared.
  const settledRef = useRef(false);
  // Set once the request is handed to UniversalTransactionSigning, which then
  // answers through the registered callbacks (or reports onDismiss).
  const handedOffRef = useRef(false);

  /**
   * Every exit that leaves this request WITHOUT an answer sent to the dApp
   * calls this first (TASK-257): it clears the request's delivery mark so a
   * relay redelivery surfaces again instead of being dropped as a duplicate.
   * No rejection is sent here (that is TASK-394).
   */
  const forgetUnanswered = () => {
    settledRef.current = true;
    TransactionRequestQueue.forgetDelivery(
      (requestEvent as any)?.id,
      (requestEvent as any)?.topic
    );
  };

  /** Left the stack with no answer attempted (OS back, swipe-back): forget. */
  const forgetIfAbandoned = () => {
    if (!settledRef.current) forgetUnanswered();
  };

  useEffect(() => {
    loadAccountsAndTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount; loadAccountsAndTransactions is read at the mount commit.
  }, []);

  useEffect(() => {
    return () => {
      if (!handedOffRef.current) reviewGrant.leave(requestKey);
    };
  }, [requestKey]);

  // Leaving this screen (OS back, swipe-back) with no answer attempted clears
  // the mark. A navigation event, not an unmount cleanup, so an effect replay
  // never reports a departure that did not happen.
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        // Once handed off, the signing screen's onDismiss decides instead.
        if (!handedOffRef.current) {
          reviewGrant.leave(requestKey);
          forgetIfAbandoned();
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- forgetIfAbandoned reads only refs and the immutable route param; re-subscribing on its identity each render is pointless.
    [navigation]
  );

  const loadAccountsAndTransactions = async () => {
    try {
      // Load accounts
      const allAccounts = await MultiAccountWalletService.getAllAccounts();
      if (settledRef.current) return;

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

        // Register callbacks in the callback registry to avoid serialization warnings
        const callbackId = registerNavigationCallbacks({
          onSuccess: async (result: any) => {
            await handleWalletConnectSuccess(result);
          },
          onReject: async () => {
            await handleReject();
          },
          onDismiss: forgetIfAbandoned,
        });

        handedOffRef.current = true;

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
          walletConnect: {
            transactions: txns,
            binding,
            requestKey,
            dapp: (() => {
              const metadata = WalletConnectService.getInstance()
                .getActiveSessions()
                .find(
                  (session) => session.topic === requestTopic
                )?.peerMetadata;
              return metadata
                ? {
                    name: metadata.name,
                    url: metadata.url,
                    icon: metadata.icons?.[0],
                  }
                : undefined;
            })(),
          },
        });
      } else {
        // The normal path (algo_signTxn) always navigates away to
        // UniversalTransactionSigning above; any other method has no review UI on
        // this screen, so fail explicitly instead of leaving a blank screen.
        throw new Error(`Unsupported request method: ${request.method}`);
      }
    } catch (error) {
      reviewGrant.leave(requestKey);
      console.error('Failed to load transaction request:', error);
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to parse transaction request';
      // Unanswered: let a redelivery of it surface again.
      forgetUnanswered();
      // Route to the dedicated error screen (replace, so the user cannot return
      // to this now-empty screen) rather than showing an alert on a blank page.
      navigation.replace('WalletConnectError', { error: message });
    }
  };

  /**
   * Take and show the next queued request this session has not shown yet,
   * atomically (TASK-257): one already displayed (a redelivered persisted
   * request) is dropped, never shown twice; one that was only queued is never
   * skipped. It leaves the queue only once the replace has gone through.
   *
   * `toast` gets the number of pending requests, counting the one just shown.
   * It runs even if the replace throws (the request then stays queued and is
   * counted), as it did when the toast preceded the advance; the error still
   * propagates. Returns the request shown, or null if none was waiting.
   */
  const takeNextRequest = async (
    toast: (queueSize: number) => void
  ): Promise<QueuedTransactionRequest | null> => {
    let taken: Awaited<ReturnType<typeof TransactionRequestQueue.takeNext>>;
    try {
      taken = await TransactionRequestQueue.takeNext((req) => {
        reviewGrant.continueTo(walletConnectRequestKey(req.topic, req.id));
        navigation.replace('WalletConnectTransactionRequest', {
          requestEvent: req,
          version: req.version,
        });
      });
      if (!taken.request) reviewGrant.revoke();
    } catch (error) {
      reviewGrant.revoke();
      toast(await TransactionRequestQueue.size());
      throw error;
    }
    toast(taken.remaining + (taken.request ? 1 : 0));
    return taken.request;
  };

  const handleWalletConnectSuccess = async (result: any) => {
    // Answered, or cleared below: leaving after this must not forget.
    settledRef.current = true;
    if (result?.signedTransactions) {
      let responseSent = false;
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
        responseSent = true;

        const nextRequest = await takeNextRequest((queueSize) => {
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
        });

        if (!nextRequest) {
          // No pending requests, navigate back
          if (navigation.canGoBack()) {
            navigation.goBack();
          } else {
            navigation.navigate('Main', { screen: 'Home' });
          }
        }
      } catch (error) {
        if (!responseSent) {
          // The dApp never got the signed response.
          forgetUnanswered();
        }
        reviewGrant.revoke();
        console.error('Failed to respond to WalletConnect:', error);
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to respond to dApp';
        navigation.navigate('WalletConnectError', { error: errorMessage });
      }
    } else {
      // Handle signing failure: nothing was sent to the dApp.
      forgetUnanswered();
      reviewGrant.revoke();
      const errorMessage = 'Failed to sign transactions';
      navigation.navigate('WalletConnectError', { error: errorMessage });
    }
  };

  // One rejection at a time (TASK-257): a second tap while the first is in
  // flight would take, and so skip past, a second queued request.
  const handleReject = async () => {
    if (rejectingRef.current) return;
    rejectingRef.current = true;
    try {
      await rejectAndAdvance();
    } finally {
      rejectingRef.current = false;
    }
  };

  const rejectAndAdvance = async () => {
    // A failed rejection clears the mark itself.
    settledRef.current = true;
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
      // The dApp never got the rejection.
      forgetUnanswered();
    }

    const nextRequest = await takeNextRequest((queueSize) => {
      if (!rejectionSent) return;
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
    });

    if (!nextRequest) {
      // No pending requests, navigate back
      if (navigation.canGoBack()) {
        navigation.goBack();
      } else {
        navigation.navigate('Main', { screen: 'Home' });
      }
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <UniversalHeader
        title="WalletConnect Request"
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />
      <View style={styles.content}>
        <ActivityIndicator color={theme.colors.primary} />
        <Text style={styles.text}>Loading request…</Text>
        <TouchableOpacity style={styles.button} onPress={handleReject}>
          <Text style={styles.buttonText}>Reject</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    content: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
    text: { color: theme.colors.text, textAlign: 'center' },
    button: {
      padding: 16,
      borderRadius: 8,
      backgroundColor: theme.colors.primary,
    },
    buttonText: { color: theme.colors.buttonText, textAlign: 'center' },
  });
