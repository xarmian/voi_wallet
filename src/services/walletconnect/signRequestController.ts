import { SIGNED_THEN_LAPSED_BATCH_MESSAGE } from '@/services/auth/transactionAuthController';
import { redactError } from '@/utils/logRedaction';
import {
  RequestCoordinator,
  type ExitReason,
  type RequestRef,
} from './requestCoordinator';
import { requestRefFor, requestExpiryOf } from './requestRefs';
import { Alert } from 'react-native';
import algosdk from 'algosdk';
import Toast from 'react-native-toast-message';
import {
  WalletConnectService,
  type WalletTransaction,
} from '@/services/walletconnect';
import { MultiAccountWalletService } from '@/services/wallet';
import type { AccountMetadata, WalletAccount } from '@/types/wallet';
import { NetworkId } from '@/types/network';
import {
  reviewGrant,
  walletConnectRequestKey,
} from '@/services/auth/reviewGrant';
import type { WalletConnectSessionBinding } from '@/services/transactions/unifiedSigner';
import {
  getNetworkNameByChainId,
  getNetworkByChainId,
  formatAccountAddress,
} from './utils';
import { resolveV1Chain } from './v1/config';
import { WalletConnectV1Client } from './v1';
import {
  registerNavigationCallbacks,
  type CallbackNavigation,
} from '@/services/navigation/callbackRegistry';

export class WalletConnectLoadError extends Error {
  constructor(
    message: string,
    public reason: ExitReason
  ) {
    super(message);
  }
}

export interface SigningReviewParams {
  transactions: string[];
  account: WalletAccount;
  chainId: string;
  networkId: NetworkId;
  title: string;
  callbackId: string;
  walletConnect: {
    ref: RequestRef;
    transactions: WalletTransaction[];
    binding: WalletConnectSessionBinding;
    requestKey: string;
    dapp: { name?: string; url?: string; icon?: string } | undefined;
  };
}

/** Thrown by a surface's takeNext when the place the next request would be shown is gone. */
export class NavigationTargetGoneError extends Error {
  constructor() {
    super('navigation target gone');
  }
}

export interface TakenRequest {
  /** The request now shown, or null when none was waiting. */
  request: unknown | null;
  /** Requests still queued after it. */
  remaining: number;
}

export interface SignRequestSurface {
  /**
   * False when the surface leaves the next request waiting until the person
   * dismisses the result, so a toast must not say the next one is processing.
   * Absent means true.
   */
  readonly advancesToNext?: boolean;
  /** Show the signing review for this request. */
  presentReview(params: SigningReviewParams): void;
  /** Show a terminal error. */
  presentError(message: string): void;
  /** Adopt the callback's live navigation, falling back when undefined. */
  adoptNavigation(nav: CallbackNavigation | undefined): void;
  /**
   * Take and present the next waiting request through the surface's queue.
   * Throws NavigationTargetGoneError when it cannot be shown because its place
   * is gone (the request then stays queued). It never touches reviewGrant: the
   * controller decides whether a signing permission survives. `approved` is
   * true only when the signed answer reached the dApp.
   */
  takeNext(approved?: boolean): Promise<TakenRequest>;
  /** Number of requests queued, for the toast after a failed take. */
  queueSize(): Promise<number>;
  /** Leave the finished request when no successor is waiting. */
  leave(): void;
}

export interface SignRequestControllerDeps {
  requestEvent: unknown;
  version?: number;
  surface: SignRequestSurface;
  coordinator?: RequestCoordinator;
}

export class SignRequestController {
  private rejecting = false;
  // An outcome in flight also owns the answer, so onDismiss cannot abandon it.
  private settled = false;
  private handedOff = false;
  private advanced = false;
  private readonly ref: RequestRef;
  private readonly requestKey: string;
  private readonly requestEvent: any;
  private readonly version: number | undefined;
  private readonly surface: SignRequestSurface;
  private readonly coordinator: RequestCoordinator;

  constructor(deps: SignRequestControllerDeps) {
    this.requestEvent = deps.requestEvent;
    this.version = deps.version;
    this.surface = deps.surface;
    this.coordinator = deps.coordinator ?? RequestCoordinator.getInstance();
    this.ref = requestRefFor(this.requestEvent, this.version === 1 ? 1 : 2);
    this.requestKey = walletConnectRequestKey(
      this.requestEvent?.topic ?? '',
      this.requestEvent?.id ?? ''
    );
  }

  leave(): void {
    // Once handed off, the signing screen's onDismiss decides instead.
    if (!this.handedOff) {
      reviewGrant.leave(this.requestKey);
      this.forgetIfAbandoned();
    }
  }

  dispose(): void {
    if (!this.handedOff) reviewGrant.leave(this.requestKey);
  }

  private settleExit = (reason: ExitReason) => {
    const { coordinator, ref } = this;
    this.settled = true;
    void coordinator.settle(ref, reason);
  };

  private forgetIfAbandoned = () => {
    if (!this.settled) this.settleExit('abandoned');
  };

  start = async (): Promise<void> => {
    const { coordinator, ref, requestEvent, version, requestKey, surface } =
      this;
    try {
      const state = await coordinator.ensureOpen(
        ref,
        requestExpiryOf(requestEvent)
      );
      if (this.settled) return;
      // A close that lands while accounts load must end this request on the
      // surface, or it would wait on a review that never comes.
      let closedWhileLoading = false;
      const stopWatching =
        state === 'open'
          ? coordinator.subscribe(ref, () => {
              closedWhileLoading = true;
            })
          : () => {};
      if (state !== 'open') {
        this.settled = true;
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
        await this.advanceAfterEnd();
        return;
      }
      // Load accounts
      let allAccounts: AccountMetadata[];
      try {
        allAccounts = await MultiAccountWalletService.getAllAccounts();
      } finally {
        stopWatching();
      }
      if (this.settled) return;
      if (closedWhileLoading) {
        this.settled = true;
        await this.advanceAfterEnd();
        return;
      }

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
            surface.adoptNavigation(nav);
            await this.handleWalletConnectSuccess(result);
          },
          onReject: async (nav) => {
            surface.adoptNavigation(nav);
            await this.reject();
          },
          onEnd: async (reason, nav) => {
            surface.adoptNavigation(nav);
            await this.endAndAdvance(reason);
          },
          onDismiss: this.forgetIfAbandoned,
        });

        this.handedOff = true;
        const signingParams: SigningReviewParams = {
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
        surface.presentReview(signingParams);
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
      this.settleExit(reason);
      // Route to the dedicated error screen (replace, so the user cannot return
      // to this now-empty screen) rather than showing an alert on a blank page.
      surface.presentError(message);
    }
  };

  private handleWalletConnectSuccess = async (result: any) => {
    const { coordinator, ref, requestEvent, version, surface } = this;
    // Reserve this outcome while recording and publishing the signed response.
    this.settled = true;
    if (result?.signedTransactions) {
      let won: boolean;
      try {
        won = await coordinator.decide(ref, 'approved');
      } catch {
        await coordinator.sendError(ref, 'lapsed');
        this.settled = true;
        surface.presentError('Failed to record the approval');
        return;
      }
      if (!won) {
        Alert.alert('Request ended', SIGNED_THEN_LAPSED_BATCH_MESSAGE);
        reviewGrant.revoke();
        if (!this.rejecting) {
          this.rejecting = true;
          await this.advanceAfterEnd();
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
            result.signedTransactions,
            (requestEvent as any).topic
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
        this.rejecting = true;

        await this.advanceAfterEnd(
          undefined,
          (queueSize) => {
            // Show non-blocking toast with queue info
            Toast.show({
              type: 'walletConnectSuccess',
              text1: 'Transaction Signed Successfully',
              text2:
                surface.advancesToNext === false
                  ? 'Your transaction has been signed and sent back to the dApp.'
                  : `Your transaction has been signed and sent back to the dApp. ${queueSize > 0 ? 'Processing next request...' : 'You can now return to the dApp.'}`,
              visibilityTime: 5000,
              position: 'top',
              props: {
                queueSize,
              },
            });
          },
          true
        );
      } catch (error) {
        if (!responseSent) {
          await coordinator.sendError(ref, 'lapsed');
        }
        reviewGrant.revoke();
        console.error(
          'Failed to respond to WalletConnect:',
          redactError(error)
        );
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to respond to dApp';
        surface.presentError(errorMessage);
      }
    } else {
      // Handle signing failure: nothing was sent to the dApp.
      this.settleExit('sign-failed');
      reviewGrant.revoke();
      const errorMessage = 'Failed to sign transactions';
      surface.presentError(errorMessage);
    }
  };

  reject = async (): Promise<void> => {
    await this.endAndAdvance('declined');
  };

  // Keep the guard set through removal: coordinator echoes and later ends do
  // not take a second queued request, even after the first advance completes.
  private endAndAdvance = async (reason: ExitReason = 'declined') => {
    const { coordinator, ref } = this;
    if (this.rejecting) return;
    this.rejecting = true;
    this.settled = true;
    await coordinator.settle(ref, reason);
    await this.advanceAfterEnd(reason);
  };

  /**
   * Take the next queued request through the surface and decide what happens
   * to this request's signing permission. A normal unlock mints one permission
   * per request waiting at that moment; a gate unlock covers only its own
   * request. Leaving this request ends only its own permission. A failed take
   * revokes, because the sitting can no longer be trusted to match the queue.
   *
   * `toast` gets the number of pending requests, counting the one just shown.
   * It runs even if the take throws (the request then stays queued and is
   * counted), except when the target is gone; the error still propagates.
   */
  private takeNextRequest = async (
    toast: (queueSize: number) => void,
    approved = false
  ): Promise<'advanced' | 'empty' | 'target-gone'> => {
    const { surface, requestKey } = this;
    let taken: TakenRequest;
    try {
      taken = await surface.takeNext(approved);
      if (!taken.request) reviewGrant.leave(requestKey);
    } catch (error) {
      reviewGrant.revoke();
      if (error instanceof NavigationTargetGoneError) return 'target-gone';
      toast(await surface.queueSize());
      throw error;
    }
    toast(taken.remaining + (taken.request ? 1 : 0));
    return taken.request ? 'advanced' : 'empty';
  };

  private advanceAfterEnd = async (
    reason?: ExitReason,
    toast?: (queueSize: number) => void,
    approved = false
  ) => {
    const { surface } = this;
    if (this.advanced) return;
    this.advanced = true;
    const nextRequest = await this.takeNextRequest(
      toast ??
        ((queueSize) => {
          if (reason !== 'declined') return;
          // Show non-blocking toast with queue info when rejection was sent
          Toast.show({
            type: 'walletConnectRejected',
            text1: 'Transaction Request Rejected',
            text2:
              surface.advancesToNext === false
                ? 'You declined to sign this transaction.'
                : `You declined to sign this transaction. ${
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
        }),
      approved
    );
    if (nextRequest === 'target-gone') return;
    if (nextRequest === 'empty') {
      surface.leave();
    }
  };
}
