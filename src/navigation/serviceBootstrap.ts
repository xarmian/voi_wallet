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
import { notificationService } from '@/services/notifications';
import { MultiAccountWalletService } from '@/services/wallet';
import { ledgerTransportService } from '@/services/ledger/transport';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';

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
        try {
          wcService = WalletConnectService.getInstance();
          await wcService.initialize();

          // Listen for WalletConnect session proposals and navigate to approval screen
          onProposal = (proposal: any) => {
            try {
              if (navigationRef.current?.isReady?.()) {
                // Close any open QR scanner first when possible
                if (navigationRef.current.canGoBack?.()) {
                  navigationRef.current.goBack();
                }
                // Then navigate to session proposal
                navigationRef.current.navigate('WalletConnectSessionProposal', {
                  proposal,
                });
              }
            } catch (err) {
              console.error(
                'Failed to navigate to WalletConnectSessionProposal:',
                err
              );
            }
          };
          wcService.on('session_proposal', onProposal);

          onRequest = async (requestEvent: any) => {
            try {
              if (navigationRef.current?.isReady?.()) {
                // Get current route name
                const currentRoute = navigationRef.current.getCurrentRoute();

                // Check if we're already on the TransactionRequestScreen
                if (currentRoute?.name === 'WalletConnectTransactionRequest') {
                  // Enqueue the request instead of navigating immediately
                  console.log(
                    '[AppNavigator] Currently on transaction screen, enqueueing request'
                  );
                  await TransactionRequestQueue.enqueue({
                    id: requestEvent.id,
                    topic: requestEvent.topic,
                    params: requestEvent.params,
                  });
                } else {
                  // Navigate immediately if not on transaction screen
                  navigationRef.current.navigate(
                    'WalletConnectTransactionRequest',
                    { requestEvent }
                  );
                }
              }
            } catch (err) {
              console.error(
                'Failed to handle WalletConnect transaction request:',
                err
              );
            }
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
              console.log('[AppNavigator] Extension received WC URI:', uri);
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
            // Register push token if permissions granted
            const token = await notificationService.registerPushToken();
            if (token) {
              // Defer the expensive per-account subscribe (N sequential
              // Supabase round-trips) off the critical path; it re-reads the
              // wallet at run time so startup-created accounts are included.
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
          const nextRequest = await TransactionRequestQueue.peek();
          if (nextRequest && navigationRef.current) {
            // Dequeue and navigate to the first request
            await TransactionRequestQueue.dequeue();
            navigationRef.current.navigate('WalletConnectTransactionRequest', {
              requestEvent: nextRequest,
              version: nextRequest.version,
            });
          }
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
      void (async () => {
        try {
          const wallet = await MultiAccountWalletService.getCurrentWallet();
          if (wallet && wallet.accounts.length > 0) {
            // Subscribe ALL accounts to notifications (not just active one)
            // Watch accounts will have message notifications disabled by default
            await notificationService.subscribeAllAccounts(wallet.accounts);

            // TODO: Re-enable realtime subscription when needed
            // Currently disabled to reduce server load - using polling instead
            // const allAddresses = wallet.accounts.map(a => a.address);
            // await realtimeService.subscribeToAddresses(allAddresses);
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
        if (wcService && onProposal) {
          wcService.off?.('session_proposal', onProposal);
        }
        if (wcService && onRequest) {
          wcService.off?.('session_request', onRequest);
        }
        if (!isSignerMode) {
          extensionDeepLinkHandler.cleanup();
          notificationService.cleanup();
        }
        // realtimeService.cleanup(); // Disabled - realtime subscription not active
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
