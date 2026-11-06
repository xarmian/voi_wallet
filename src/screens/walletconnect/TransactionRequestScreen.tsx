import { SIGNED_THEN_LAPSED_BATCH_MESSAGE } from '@/services/auth/transactionAuthController';
import { redactError } from '@/utils/logRedaction';
import {
  RequestCoordinator,
  type ExitReason,
} from '@/services/walletconnect/requestCoordinator';
import {
  requestRefFor,
  requestExpiryOf,
} from '@/services/walletconnect/requestRefs';
import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
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
import {
  registerNavigationCallbacks,
  type CallbackNavigation,
} from '@/services/navigation/callbackRegistry';

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

class WalletConnectLoadError extends Error {
  constructor(
    message: string,
    public reason: ExitReason
  ) {
    super(message);
  }
}

export default function TransactionRequestScreen({ navigation, route }: Props) {
  const { requestEvent } = route.params;
  const version = (route.params as any)?.version as number | undefined;
  const coordinator = RequestCoordinator.getInstance();
  const ref = requestRefFor(requestEvent, version === 1 ? 1 : 2);
  const requestKey = walletConnectRequestKey(
    (requestEvent as any)?.topic ?? '',
    (requestEvent as any)?.id ?? ''
  );
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  // True while a rejection is being sent and the next request taken.
  const rejectingRef = useRef(false);

  // An outcome in flight also owns the answer, so onDismiss cannot abandon it.
  const settledRef = useRef(false);
  const handedOffRef = useRef(false);
  const advancedRef = useRef(false);
  const navRef = useRef<CallbackNavigation>(navigation);

  const settleExit = (reason: ExitReason) => {
    settledRef.current = true;
    void coordinator.settle(ref, reason);
  };

  const forgetIfAbandoned = () => {
    if (!settledRef.current) settleExit('abandoned');
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

  // Leaving this screen (OS back, swipe-back) settles an unanswered request. A navigation event, not an unmount cleanup, so an effect replay
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
      const state = await coordinator.ensureOpen(
        ref,
        requestExpiryOf(requestEvent)
      );
      if (state !== 'open') {
        settledRef.current = true;
        if (state === 'expired' || state === 'handled') {
          Toast.show({
            type: 'info',
            text1:
              state === 'expired'
                ? 'Request expired'
                : 'Request already handled',
            text2:
              state === 'expired'
                ? 'Try again in the dApp.'
                : 'Check the dApp before you try again.',
          });
        }
        await advanceAfterEnd();
        return;
      }
      // Load accounts
      const allAccounts = await MultiAccountWalletService.getAllAccounts();
      if (settledRef.current) return;

      const eventParams = (requestEvent as any).params;
      if (!eventParams) {
        throw new WalletConnectLoadError(
          'Malformed request: missing params',
          'load-failed'
        );
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

        if (!txns || !Array.isArray(txns) || txns.length === 0) {
          throw new WalletConnectLoadError(
            'Malformed request: missing transactions array',
            'load-failed'
          );
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
            throw new WalletConnectLoadError(
              'This WalletConnect v1 session uses a network this wallet cannot ' +
                'identify (v1 sessions carry an ambiguous numeric chain id). ' +
                'Please reconnect the dApp using WalletConnect v2.',
              'load-failed'
            );
          }
          chainId = resolved.chainId;
          chainNetworkId = resolved.networkId;
        } else {
          if (typeof requestChainId !== 'string' || !requestChainId) {
            throw new WalletConnectLoadError(
              'Malformed request: missing chain id',
              'load-failed'
            );
          }
          const resolved = getNetworkByChainId(requestChainId);
          if (!resolved) {
            throw new WalletConnectLoadError(
              'This request targets a network this wallet does not support.',
              'load-failed'
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
          throw new WalletConnectLoadError(
            'This dApp session has no approved account on ' +
              `${getNetworkNameByChainId(chainId)}. Reconnect the session and try again.`,
            'unsupported-accounts'
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
          throw new WalletConnectLoadError(
            'No account available to sign this request',
            'unsupported-accounts'
          );
        }

        // Register callbacks in the callback registry to avoid serialization warnings
        const callbackId = registerNavigationCallbacks({
          onSuccess: async (result, nav) => {
            navRef.current = nav ?? navigation;
            await handleWalletConnectSuccess(result);
          },
          onReject: async (nav) => {
            navRef.current = nav ?? navigation;
            await handleReject();
          },
          onEnd: async (reason, nav) => {
            navRef.current = nav ?? navigation;
            await endAndAdvance(reason);
          },
          onDismiss: forgetIfAbandoned,
        });

        handedOffRef.current = true;
        const signingParams = {
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
            ref,
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
        };
        navRef.current.replace('UniversalTransactionSigning', signingParams);
      } else {
        // The normal path (algo_signTxn) always navigates away to
        // UniversalTransactionSigning above; any other method has no review UI on
        // this screen, so fail explicitly instead of leaving a blank screen.
        throw new WalletConnectLoadError(
          `Unsupported request method: ${request.method}`,
          'unsupported-method'
        );
      }
    } catch (error) {
      reviewGrant.leave(requestKey);
      console.error('Failed to load transaction request:', redactError(error));
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to parse transaction request';
      const reason =
        error instanceof WalletConnectLoadError ? error.reason : 'load-failed';
      settleExit(reason);
      // Route to the dedicated error screen (replace, so the user cannot return
      // to this now-empty screen) rather than showing an alert on a blank page.
      navRef.current.replace('WalletConnectError', { error: message });
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
        navRef.current.replace('WalletConnectTransactionRequest', {
          requestEvent: req,
          version: req.version,
        });
      });
      // A normal unlock mints one permission per request waiting at that moment.
      // A gate unlock covers only its own request; later requests join no sitting.
      // Leaving this request ends only its own permission.
      if (!taken.request) reviewGrant.leave(requestKey);
    } catch (error) {
      reviewGrant.revoke();
      toast(await TransactionRequestQueue.size());
      throw error;
    }
    toast(taken.remaining + (taken.request ? 1 : 0));
    return taken.request;
  };

  const handleWalletConnectSuccess = async (result: any) => {
    // Reserve this outcome while recording and publishing the signed response.
    settledRef.current = true;
    if (result?.signedTransactions) {
      let won: boolean;
      try {
        won = await coordinator.decide(ref, 'approved');
      } catch {
        await coordinator.sendError(ref, 'sign-failed');
        settledRef.current = true;
        navRef.current.navigate('WalletConnectError', {
          error: 'Failed to record the approval',
        });
        return;
      }
      if (!won) {
        Alert.alert('Request ended', SIGNED_THEN_LAPSED_BATCH_MESSAGE);
        reviewGrant.revoke();
        if (!rejectingRef.current) {
          rejectingRef.current = true;
          await advanceAfterEnd();
        }
        return;
      }
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
        rejectingRef.current = true;

        await advanceAfterEnd(undefined, (queueSize) => {
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
      } catch (error) {
        if (!responseSent) {
          await coordinator.sendError(ref, 'sign-failed');
        }
        reviewGrant.revoke();
        console.error(
          'Failed to respond to WalletConnect:',
          redactError(error)
        );
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to respond to dApp';
        navRef.current.navigate('WalletConnectError', { error: errorMessage });
      }
    } else {
      // Handle signing failure: nothing was sent to the dApp.
      settleExit('sign-failed');
      reviewGrant.revoke();
      const errorMessage = 'Failed to sign transactions';
      navRef.current.navigate('WalletConnectError', { error: errorMessage });
    }
  };

  const handleReject = async () => {
    await endAndAdvance('declined');
  };

  // Keep the guard set through removal: coordinator echoes and later ends do
  // not take a second queued request, even after the first advance completes.
  const endAndAdvance = async (reason: ExitReason = 'declined') => {
    if (rejectingRef.current) return;
    rejectingRef.current = true;
    settledRef.current = true;
    await coordinator.settle(ref, reason);
    await advanceAfterEnd(reason);
  };

  const advanceAfterEnd = async (
    reason?: ExitReason,
    toast?: (queueSize: number) => void
  ) => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    const nextRequest = await takeNextRequest(
      toast ??
        ((queueSize) => {
          if (reason !== 'declined') return;
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
        })
    );

    if (!nextRequest) {
      // No pending requests, navigate back
      if (navRef.current.canGoBack()) {
        navRef.current.goBack();
      } else {
        navRef.current.navigate('Main', { screen: 'Home' });
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
