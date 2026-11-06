import { Platform } from 'react-native';

import { detectPlatform } from '@/platform/detection';
import {
  getAppModeEarly,
  useRemoteSignerStore,
} from '@/store/remoteSignerStore';
import { useWalletStore } from '@/store/walletStore';
import { WalletConnectService } from '@/services/walletconnect';
import { DeepLinkService } from '@/services/deeplink';
import { extensionDeepLinkHandler } from '@/services/deeplink/extensionHandler';
import { isWalletConnectUri } from '@/services/walletconnect/utils';
import { redactSensitiveForLog } from '@/utils/logRedaction';
import { notificationService } from '@/services/notifications';
import {
  takeAccountSubscribeToken,
  invalidateAccountSubscribePasses,
} from '@/services/notifications/subscribePass';
import { MultiAccountWalletService } from '@/services/wallet';
import { ledgerTransportService } from '@/services/ledger/transport';
import {
  QueueFullError,
  TransactionRequestQueue,
} from '@/services/walletconnect/TransactionRequestQueue';
import { answerDroppedRequests } from '@/services/walletconnect/droppedRequestResponder';

/**
 * Whole-app service boot, extracted verbatim from AppNavigator's mount effect
 * (TASK-243) so the async init + teardown can be unit-tested without mounting
 * the full navigator (its 70-screen module graph is impractical to load under
 * jest). The init logic and ordering are UNCHANGED from the inline version;
 * only the surrounding closure captures (navigationRef, initializeNetwork,
 * cleanupRef) are now injected as `deps`.
 *
 * TASK-243 fix: instead of `return () => {...}` (which the async function would
 * resolve into a Promise the effect discards), the teardown is assigned to
 * `deps.cleanupRef.current`. The effect's SYNCHRONOUS cleanup invokes that ref
 * on unmount, so the WalletConnect handler unregister and
 * extensionDeepLinkHandler/notificationService cleanup actually run.
 */
export interface InitializeServicesDeps {
  /** The NavigationContainer ref; read lazily inside the WC handlers. */
  navigationRef: { current: any };
  /** networkStore.initializeNetwork, read at the mount commit. */
  initializeNetwork: () => Promise<void>;
  /**
   * Mutable holder the effect's synchronous cleanup invokes on unmount. This
   * function assigns the teardown here once boot reaches the point where the
   * services that need tearing down have been wired up.
   */
  cleanupRef: { current: (() => void) | undefined };
  /**
   * Returns true if the mount effect has ALREADY torn down (the component
   * unmounted) while this async boot was still in flight — e.g. a fast
   * unmount or a dev Fast Refresh boundary before boot finished. When that
   * happens the effect's synchronous cleanup found `cleanupRef.current`
   * undefined and no-op'd, yet this boot still went on to register the
   * WalletConnect handlers etc. So once the teardown is assigned below we
   * invoke it immediately, rather than leaking those registrations against an
   * unmounted navigator. Defaults to never-disposed. (TASK-243.)
   */
  isDisposed?: () => boolean;
}

export const initializeServices = async ({
  navigationRef,
  initializeNetwork,
  cleanupRef,
  isDisposed,
}: InitializeServicesDeps): Promise<void> => {
  try {
    // Kick off remote-signer store hydration EARLY (F-03 cross-stage
    // parallelization). Previously it started only once MainTabNavigator
    // mounted (behind the AppStack render gate), daisy-chaining it after the
    // first frame. Starting it here runs it concurrently with AppStack's
    // checkInitialRoute and the service init below. It reuses the same
    // getAppModeEarly() promise awaited just below, and its initialize() is
    // coalesced, so the later MainTabNavigator mount-effect call dedupes onto
    // this in-flight pass rather than starting a second one. Fire-and-forget:
    // it must not block service init.
    void useRemoteSignerStore.getState().initialize();

    // Get app mode BEFORE initializing network services
    // This avoids a race condition with store hydration
    const appMode = await getAppModeEarly();
    const isSignerMode = appMode === 'signer';

    // Initialize Network store (needed in both modes for basic config)
    await initializeNetwork();

    // Kick off wallet store hydration EARLY too (F-03). It previously started
    // only when HomeScreen/AirgapHomeScreen mounted — the last of three
    // render gates. Starting it here (well ahead of that gate) lets the
    // wallet/account list + persisted balance cache load during startup.
    // It is kept AFTER initializeNetwork() on purpose: walletStore.initialize
    // reads the ACTIVE network to key the balance cache, matching where the
    // Home mount effect ran it (always post-network-init). Its initialize()
    // coalescer dedupes the later Home mount-effect call. Fire-and-forget.
    void useWalletStore.getState().initialize();

    // Variables for cleanup - only defined if services are initialized
    let wcService: WalletConnectService | null = null;
    let onProposal: ((proposal: any) => void) | null = null;
    let onRequest: ((requestEvent: any) => Promise<void>) | null = null;

    // Whether the deferred (off-critical-path) per-account subscribe should
    // run. Set once the notification service is initialized and a push token
    // is registered; the actual subscribe is scheduled after startup.
    let shouldSubscribeAccounts = false;

    // Independent service inits run in parallel via Promise.allSettled, each
    // with its own try/catch so one failure never blocks the others or app
    // startup. Ordering constraints are preserved WITHIN each branch.
    const parallelInits: Promise<unknown>[] = [];

    // Skip internet-dependent services in signer mode (air-gapped device)
    if (!isSignerMode) {
      // --- Branch: WalletConnect (init + handler attach kept ATOMIC) ---
      // WalletConnect installs its own handlers during initialize(); the
      // AppNavigator navigation handlers must attach to that same initialized
      // instance, so init and .on(...) stay together in one unit.
      const initWalletConnect = async () => {
        // TASK-394: answer requests the transaction queue drops unshown (full
        // queue, stale entry) so the dApp is not left waiting. Installed
        // before v2 init so v1 requests (DeepLinkService) are covered even if
        // v2 init fails.
        TransactionRequestQueue.setDroppedRequestHandler(answerDroppedRequests);
        try {
          wcService = WalletConnectService.getInstance();
          await wcService.initialize();

          // TASK-382: WalletConnect events go through DeepLinkService's
          // cold-start route queue (DR-10), so an event that arrives before
          // the navigation container is ready (a wc: link that woke the app)
          // waits for it instead of being dropped.
          const deepLinkService = DeepLinkService.getInstance();

          // Listen for WalletConnect session proposals and navigate to approval screen
          onProposal = (proposal: any) => {
            void deepLinkService.deliverRoute(
              `wc:proposal:${proposal?.id}`,
              () => {
                try {
                  if (navigationRef.current?.isReady?.()) {
                    // Close any open QR scanner first when possible
                    if (navigationRef.current.canGoBack?.()) {
                      navigationRef.current.goBack();
                    }
                    // Then navigate to session proposal
                    navigationRef.current.navigate(
                      'WalletConnectSessionProposal',
                      { proposal }
                    );
                  } else {
                    console.error(
                      'WalletConnect session proposal not shown: navigation not ready'
                    );
                  }
                } catch (err) {
                  console.error(
                    'Failed to navigate to WalletConnectSessionProposal:',
                    err
                  );
                }
              }
            );
          };
          wcService.on('session_proposal', onProposal);

          onRequest = async (requestEvent: any) => {
            // TASK-257: surface each (topic, id) once. A repeat emit (relay
            // redelivery, a second listener) is dropped here, including while
            // the original is still on screen. The claim lives until the
            // request is shown or queued; a failed delivery releases it
            // (TransactionRequestQueue.claim documents the lifecycle).
            if (
              !TransactionRequestQueue.claim(
                requestEvent?.id,
                requestEvent?.topic
              )
            ) {
              console.log(
                '[AppNavigator] Duplicate transaction request ignored'
              );
              return;
            }
            // Not shown and not queued: let a redelivery of it through.
            const release = () =>
              TransactionRequestQueue.releaseClaim(
                requestEvent.id,
                requestEvent.topic
              );

            const showOrQueue = async () => {
              let delivered = false;
              try {
                const nav = navigationRef.current;
                if (nav?.isReady?.()) {
                  // Check if we're already on the TransactionRequestScreen
                  if (
                    nav.getCurrentRoute()?.name ===
                    'WalletConnectTransactionRequest'
                  ) {
                    // Enqueue the request instead of navigating immediately;
                    // that screen takes it next. The claim stays: queued.
                    console.log(
                      '[AppNavigator] Currently on transaction screen, enqueueing request'
                    );
                    try {
                      await TransactionRequestQueue.enqueue({
                        id: requestEvent.id,
                        topic: requestEvent.topic,
                        params: requestEvent.params,
                      });
                    } catch (err) {
                      if (!(err instanceof QueueFullError)) throw err;
                      // TASK-394: answer it as dropped (marks it displayed,
                      // so a redelivery is not shown) instead of releasing.
                      TransactionRequestQueue.reportDropped(
                        [
                          {
                            id: requestEvent.id,
                            topic: requestEvent.topic,
                            params: requestEvent.params,
                            timestamp: Date.now(),
                          },
                        ],
                        'full'
                      );
                    }
                  } else {
                    // Navigate immediately if not on transaction screen
                    nav.navigate('WalletConnectTransactionRequest', {
                      requestEvent,
                    });
                    TransactionRequestQueue.markDisplayed(
                      requestEvent.id,
                      requestEvent.topic
                    );
                  }
                  delivered = true;
                } else {
                  console.error(
                    'WalletConnect transaction request not shown: navigation not ready'
                  );
                }
              } catch (err) {
                console.error(
                  'Failed to handle WalletConnect transaction request:',
                  err
                );
              } finally {
                if (!delivered) release();
              }
            };

            await deepLinkService
              .deliverSigningRequest(showOrQueue)
              .catch((err) => {
                // The route queue never rejects; if it ever did, the handler
                // never ran, so the request was not delivered.
                release();
                console.error(
                  'Failed to deliver WalletConnect transaction request:',
                  err
                );
              });
          };
          wcService.on('session_request', onRequest);

          console.log('WalletConnect service initialized');
        } catch (error) {
          console.warn('Failed to initialize WalletConnect service:', error);
          // Don't block app startup for WalletConnect initialization failures
        }
      };

      // --- Branch: DeepLink -> Notifications (ordered, NOT raced) ---
      // DeepLink.initialize() installs the notification-tap handler, so it
      // must run BEFORE notificationService.initialize() to avoid racing
      // cold-start notification routing; they share one sequential branch.
      const initDeepLinkAndNotifications = async () => {
        // DeepLink.initialize() installs the notification-tap handler. It
        // MUST complete before notificationService.initialize() processes a
        // cold-start notification response: notification init marks the
        // initial notification as handled and, if no tap handler is set,
        // buffers it in memory with nothing to route it — permanently
        // dropping it. Track success so a DeepLink failure GATES (skips)
        // notification init rather than silently consuming that response.
        let deepLinkTapHandlerReady = false;
        try {
          const deepLinkService = DeepLinkService.getInstance();
          if (navigationRef.current) {
            deepLinkService.setNavigationRef(navigationRef.current);
          }
          await deepLinkService.initialize();
          // initialize() installs the notification-tap handler on success
          deepLinkTapHandlerReady = true;

          // Initialize extension-specific deep link handling (for WalletConnect URIs from getvoi.app)
          if (Platform.OS === 'web' && detectPlatform() === 'extension') {
            extensionDeepLinkHandler.initialize(async (uri: string) => {
              // The URI carries the session symKey (TASK-290 sweep).
              console.log(
                '[AppNavigator] Extension received WC URI:',
                redactSensitiveForLog(uri)
              );
              if (isWalletConnectUri(uri)) {
                await deepLinkService.testDeepLink(uri);
              }
            });
          }

          console.log('DeepLink service initialized');
        } catch (error) {
          console.warn('Failed to initialize DeepLink service:', error);
          // Don't block app startup for DeepLink initialization failures
        }

        // Only initialize notifications once the notification-tap handler is
        // installed. If DeepLink init failed, skip notification init so a
        // cold-start notification response is not consumed and dropped with
        // no handler to route it (matches the original serial behavior,
        // where a DeepLink failure short-circuited notification init).
        if (!deepLinkTapHandlerReady) {
          console.warn(
            '[AppNavigator] Skipping notification init: DeepLink notification-tap handler not installed (would drop cold-start notification)'
          );
          return;
        }

        // Initialize push notification service (after DeepLink so the
        // notification-tap handler is installed before cold-start routing)
        try {
          await notificationService.initialize();
          console.log('Notification service initialized');

          // Check if user has a wallet, then register the push token
          const wallet = await MultiAccountWalletService.getCurrentWallet();
          if (wallet && wallet.accounts.length > 0) {
            // Refresh an opted-in user's token without prompting at startup.
            const token = await notificationService.registerPushToken({
              prompt: false,
            });
            if (token) {
              // Defer the per-account subscribe off the critical path; it
              // re-reads the wallet at run time so startup-created accounts
              // are included. TASK-192 collapsed it to two Supabase round
              // trips (one read, one write) regardless of account count.
              shouldSubscribeAccounts = true;
            }
          }
        } catch (error) {
          console.warn('Failed to initialize notification services:', error);
          // Don't block app startup for notification initialization failures
        }
      };

      parallelInits.push(initWalletConnect(), initDeepLinkAndNotifications());
    } else {
      console.log(
        '[AppNavigator] Signer mode: skipping network services (WalletConnect, DeepLink, Notifications)'
      );
    }

    // --- Branch: Ledger transport (useful in BOTH modes) ---
    // F-24: only eagerly initialize the Ledger transport at boot when the
    // user has a previously paired Ledger persisted. This loads that
    // device's metadata into the in-memory map so rekey/signing
    // getDevices() consumers (keyManager) see it, WITHOUT pulling
    // ble-plx/rxjs into the cold-boot eval graph or starting a permanent
    // 15s health-check interval for the ~100% of users who never use a
    // Ledger. Users with no persisted device defer init to the first Ledger
    // screen (DeviceDiscovery) / first signing attempt (keyManager), which
    // call initialize() themselves.
    const initLedger = async () => {
      try {
        const initialized =
          await ledgerTransportService.initializeIfPersistedDevices({
            enableBle: true,
            enableUsb: true,
          });
        console.log(
          initialized
            ? 'Ledger transport service initialized'
            : 'Ledger transport init deferred (no persisted devices)'
        );
      } catch (error) {
        console.warn('Failed to initialize Ledger transport service:', error);
        // Don't block app startup for Ledger initialization failures
      }
    };
    parallelInits.push(initLedger());

    // Run the independent inits concurrently; allSettled + per-branch
    // try/catch guarantees a single failure cannot block the others.
    await Promise.allSettled(parallelInits);

    // Reset + process the TransactionRequestQueue on the critical path (NOT
    // a deferred sibling) so stale processing state is cleared and any
    // persisted request is handled before we accept new startup requests.
    // Runs after WalletConnect init so queued requests can be serviced.
    if (!isSignerMode) {
      // Reset stale processing state from previous session (prevents deadlock after crash)
      await TransactionRequestQueue.setProcessing(false);

      // Process any pending transaction requests from the queue
      try {
        const hasQueuedRequests = !(await TransactionRequestQueue.isEmpty());
        if (hasQueuedRequests) {
          console.log(
            '[AppNavigator] Processing queued transaction requests on startup'
          );
          // TASK-257/TASK-382: through the same route queue as live
          // requests, so it waits for navigation and runs in order with
          // them. Not awaited: startup must not block on navigation.
          void DeepLinkService.getInstance().deliverSigningRequest(async () => {
            const nav = navigationRef.current;
            if (!nav?.isReady?.()) {
              // Left queued; nothing was dequeued.
              console.error(
                '[AppNavigator] Queued transaction requests not shown: navigation not ready'
              );
              return;
            }
            // The transaction screen owns the queue while it is showing
            // (it takes the next request when the user answers this one),
            // exactly as a live request arriving now would be queued.
            if (
              nav.getCurrentRoute()?.name === 'WalletConnectTransactionRequest'
            ) {
              return;
            }
            // Atomic take: skips (drops) only requests already displayed this
            // session, and marks + shows the next one under the queue lock, so
            // a screen completion racing this drain cannot show it too. It is
            // removed only once shown; a failed navigate leaves it queued.
            await TransactionRequestQueue.takeNext((req) =>
              nav.navigate('WalletConnectTransactionRequest', {
                requestEvent: req,
                version: req.version,
              })
            );
          });
        }
      } catch (error) {
        console.error(
          '[AppNavigator] Failed to process queued requests:',
          error
        );
      }
    }

    // Defer per-account notification subscribe OFF the critical path.
    // Re-read the wallet here so accounts created during startup are
    // included (constraint: defer only AFTER re-reading the wallet). This is
    // fire-and-forget so it never delays time-to-interactive.
    if (shouldSubscribeAccounts) {
      // Abort token, taken SYNCHRONOUSLY at launch so it covers the whole
      // window. The pass below works from a wallet snapshot and, since
      // TASK-192, defers to a single batched write at the end — so an unmount
      // or an account deletion in the meantime must be able to drop that
      // write. The teardown assigned just below and the account-deletion paths
      // both invalidate it; re-checked immediately before the write.
      const subscribeToken = takeAccountSubscribeToken();
      void (async () => {
        try {
          const wallet = await MultiAccountWalletService.getCurrentWallet();
          if (wallet && wallet.accounts.length > 0) {
            // Subscribe ALL accounts to notifications (not just active one)
            // Watch accounts will have message notifications disabled by default
            await notificationService.subscribeAllAccounts(
              wallet.accounts,
              subscribeToken
            );
          }
        } catch (error) {
          console.warn('Failed to subscribe accounts to notifications:', error);
        }
      })();
    }

    // Hand the teardown to the effect via cleanupRef so its synchronous
    // return can run it on unmount. Returning it from this async function
    // would resolve it into a discarded Promise (the original TASK-243
    // defect), so no teardown ever ran.
    cleanupRef.current = () => {
      try {
        // FIRST, and unconditionally: cancel any in-flight deferred subscribe
        // pass. It holds a wallet snapshot from this (now dead) session and
        // would otherwise still perform its batched write. Done ahead of the
        // unregister calls so a throw there cannot skip it.
        invalidateAccountSubscribePasses();
        if (wcService && onProposal) {
          wcService.off?.('session_proposal', onProposal);
        }
        if (wcService && onRequest) {
          wcService.off?.('session_request', onRequest);
        }
        if (!isSignerMode) {
          extensionDeepLinkHandler.cleanup();
          notificationService.cleanup();
          // Removes the Linking 'url' subscription and the navigation-ready
          // listeners. A route still queued for readiness is kept and is
          // delivered after a remount (TASK-381).
          DeepLinkService.getInstance().cleanup();
        }
      } catch {}
    };

    // If the mount effect already unmounted while this boot was in flight, its
    // synchronous cleanup ran BEFORE the teardown existed (no-op). Now that the
    // teardown is assigned, run it immediately so the services just registered
    // above are not left bound to a torn-down navigator. (TASK-243.)
    if (isDisposed?.()) {
      cleanupRef.current();
    }
  } catch (error) {
    console.error('Failed to initialize services:', error);
  }
};
