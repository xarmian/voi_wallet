import { Alert, Platform, Linking } from 'react-native';
import { NavigationContainerRef } from '@react-navigation/native';
import { WalletConnectService } from '@/services/walletconnect';
import {
  parseWalletConnectUri,
  isWalletConnectUri,
  isWalletConnectPairingUri,
  isWalletConnectRequestUri,
  parseWalletConnectRequestUri,
  isVoiUri,
  detectWalletConnectVersion,
  parseWalletConnectV1Uri,
} from '@/services/walletconnect/utils';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import {
  isArc0090Uri,
  parseArc0090Uri,
  getArc0090UriType,
  resolveNetworkFromAuthority,
  isLegacyVoiUri,
  Arc0090PaymentUri,
  Arc0090KeyregUri,
  Arc0090ApplUri,
  Arc0090AppQueryUri,
  Arc0090AssetQueryUri,
  validatePaymentUri,
  validateKeyregUri,
  validateApplUri,
} from '@/utils/arc0090Uri';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';
import {
  notificationService,
  NotificationData,
} from '@/services/notifications';
import { useWalletStore } from '@/store/walletStore';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';

// Log-redaction helpers (TASK-33): deep-link URIs and their parsed contents can
// embed full addresses, amounts, notes and other PII. These keep debug logs
// useful (request type, network, truncated address) without emitting the
// sensitive payload. Used for the console.* sites in handleArc0090Uri.
const redactAddress = (address?: string): string =>
  address && address.length > 6
    ? `${address.slice(0, 6)}…[redacted]`
    : '[redacted]';

// Strip sensitive values from an arbitrary log string — a caught error message
// OR untrusted deep-link input (scheme/host/path/query/params). Redacts, in
// order:
//  - raw and percent-encoded WalletConnect URIs (`wc:` / `wc%3A`), whose query
//    string carries the session symKey;
//  - any stray `symKey=` / `symKey%3D` token (raw or encoded), belt-and-braces
//    so a symKey can never survive regardless of surrounding format;
//  - any scheme://… URL (voi://, https://, universal links, …) — whole URI
//    including the query string;
//  - full 58-char Algorand addresses, run LAST on the whole string so an
//    address used as a pseudo-scheme (ADDR://…) is still truncated.
// Used only for LOGGED output — thrown/surfaced errors keep the full value so
// user-facing messages are unchanged (TASK-33).
const redactSensitiveForLog = (message: string): string =>
  message
    .replace(/wc:\S+/gi, 'wc:[redacted]')
    .replace(/wc%3[Aa]\S*/g, 'wc:[redacted]')
    .replace(/symKey(=|%3[Dd])[^&\s"']+/gi, 'symKey=[redacted]')
    .replace(/([a-z][a-z0-9+.-]*):\/\/\S*/gi, '$1://[redacted]')
    .replace(/[A-Z2-7]{58}/g, (addr) => redactAddress(addr));

// Convenience wrapper for the common `catch (error) { console.error(msg, error) }`
// pattern: derive the message string and redact it before logging.
const redactError = (error: unknown): string =>
  redactSensitiveForLog(error instanceof Error ? error.message : String(error));

// Summarize a notification for logs: keep non-sensitive routing fields but
// truncate the sender/receiver addresses and redact the amount.
const redactNotificationData = (
  data: NotificationData
): Record<string, unknown> => ({
  type: data.type,
  eventType: data.eventType,
  sender: data.sender ? redactAddress(data.sender) : undefined,
  receiver: data.receiver ? redactAddress(data.receiver) : undefined,
  amount: data.amount !== undefined ? '[redacted]' : undefined,
  hasTxId: !!data.txId,
  contractId: data.contractId,
  tokenId: data.tokenId,
  round: data.round,
});

export type DeepLinkHandler = (url: string) => Promise<boolean>;

export interface DeepLinkRoute {
  screen: string;
  params?: any;
}

// Cross-platform alert helper
const showAlert = (
  title: string,
  message: string,
  buttons?: { text: string; onPress?: () => void; style?: string }[]
): Promise<boolean> => {
  return new Promise((resolve) => {
    if (Platform.OS === 'web') {
      if (buttons && buttons.length > 1) {
        const confirmed = window.confirm(`${title}\n\n${message}`);
        if (confirmed) {
          const confirmButton =
            buttons.find((b) => b.style !== 'cancel') || buttons[0];
          confirmButton?.onPress?.();
          resolve(true);
        } else {
          const cancelButton = buttons.find((b) => b.style === 'cancel');
          cancelButton?.onPress?.();
          resolve(false);
        }
      } else {
        window.alert(`${title}\n\n${message}`);
        buttons?.[0]?.onPress?.();
        resolve(true);
      }
    } else {
      Alert.alert(
        title,
        message,
        buttons?.map((b) => ({
          text: b.text,
          onPress: () => {
            b.onPress?.();
            resolve(b.style !== 'cancel');
          },
          style: b.style as any,
        })) || [{ text: 'OK', onPress: () => resolve(true) }]
      );
    }
  });
};

export class DeepLinkService {
  private static instance: DeepLinkService;
  private navigationRef: NavigationContainerRef<any> | null = null;
  private handlers: Map<string, DeepLinkHandler> = new Map();
  private pendingNotification: NotificationData | null = null;
  private isAppUnlocked: boolean = false;
  private linkingSubscription: { remove: () => void } | null = null;

  static getInstance(): DeepLinkService {
    if (!DeepLinkService.instance) {
      DeepLinkService.instance = new DeepLinkService();
    }
    return DeepLinkService.instance;
  }

  constructor() {
    this.setupDefaultHandlers();
  }

  setNavigationRef(ref: NavigationContainerRef<any>): void {
    this.navigationRef = ref;
  }

  /**
   * Set the app's unlock state. Call this from AuthContext when unlock state changes.
   * When the app becomes unlocked, any pending notification navigation will be executed.
   */
  setUnlockState(isUnlocked: boolean): void {
    const wasUnlocked = this.isAppUnlocked;
    this.isAppUnlocked = isUnlocked;
    console.log(
      `[DeepLink] setUnlockState: ${wasUnlocked} -> ${isUnlocked}, pendingNotification: ${!!this.pendingNotification}`
    );

    // If app just unlocked and we have a pending notification, process it now
    if (isUnlocked && !wasUnlocked && this.pendingNotification) {
      console.log(
        '[DeepLink] App unlocked, processing pending notification:',
        redactNotificationData(this.pendingNotification)
      );
      const pendingData = this.pendingNotification;
      this.pendingNotification = null;
      this.handleNotificationNavigation(pendingData);
    }
  }

  /**
   * Check if there's a pending notification waiting to be processed
   */
  hasPendingNotification(): boolean {
    return this.pendingNotification !== null;
  }

  async initialize(): Promise<void> {
    try {
      // Handle initial URL if app was opened via deep link
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) {
        console.log(
          'Handling initial deep link:',
          redactSensitiveForLog(initialUrl)
        );
        await this.handleUrl(initialUrl);
      }

      // Listen for incoming deep links
      this.linkingSubscription = Linking.addEventListener('url', ({ url }) => {
        console.log('Received deep link:', redactSensitiveForLog(url));
        this.handleUrl(url).catch((error) => {
          console.error('Failed to handle deep link:', redactError(error));
        });
      });

      // Set up notification tap handler for navigation
      this.setupNotificationHandler();
    } catch (error) {
      console.error(
        'Failed to initialize deep link service:',
        redactError(error)
      );
      throw error;
    }
  }

  /**
   * Set up handler for notification taps to navigate to relevant screens
   */
  private setupNotificationHandler(): void {
    notificationService.setNotificationTapHandler(
      async (data: NotificationData) => {
        console.log(
          '[DeepLink] Notification tap handler called, isAppUnlocked:',
          this.isAppUnlocked,
          'data:',
          redactNotificationData(data)
        );

        // If app is locked, store the notification for later processing after unlock
        if (!this.isAppUnlocked) {
          console.log(
            '[DeepLink] App is locked, storing notification for after unlock'
          );
          this.pendingNotification = data;
          return;
        }

        await this.handleNotificationNavigation(data);
      }
    );
  }

  /**
   * Handle navigation for a notification tap
   * This is called either immediately (if app is unlocked) or after unlock
   */
  private async handleNotificationNavigation(
    data: NotificationData
  ): Promise<void> {
    console.log(
      'Processing notification navigation:',
      redactNotificationData(data)
    );

    switch (data.type) {
      case 'message':
        // Navigate to MessagesInbox first (handles initialization), then to Chat
        if (data.sender) {
          // If receiver is provided, switch to that account first
          if (data.receiver) {
            const walletStore = useWalletStore.getState();
            const receiverAccount = walletStore.wallet?.accounts.find(
              (acc) => acc.address === data.receiver
            );
            if (
              receiverAccount &&
              walletStore.wallet?.activeAccountId !== receiverAccount.id
            ) {
              console.log(
                'Switching to receiver account:',
                redactAddress(receiverAccount.address)
              );
              await walletStore.setActiveAccount(receiverAccount.id);
            }
          }

          // Navigate to MessagesInbox, then immediately push Chat on top
          // This ensures the messages store is properly initialized
          this.navigateToRoute({
            screen: 'Main',
            params: {
              screen: 'Friends',
              params: {
                screen: 'MessagesInbox',
              },
            },
          });

          // Small delay to let MessagesInbox initialize, then navigate to Chat
          setTimeout(() => {
            this.navigateToRoute({
              screen: 'Main',
              params: {
                screen: 'Friends',
                params: {
                  screen: 'Chat',
                  params: {
                    friendAddress: data.sender,
                  },
                },
              },
            });
          }, 100);
        }
        break;

      case 'payment':
      case 'arc200':
      case 'arc72':
        // Navigate to transaction detail or home
        // Since we don't have full transaction info in notification,
        // navigate to home screen which shows recent activity
        this.navigateToRoute({
          screen: 'Main',
          params: {
            screen: 'Home',
            params: {
              screen: 'HomeMain',
            },
          },
        });
        break;

      case 'key_registration':
      case 'test':
        // Navigate to home screen
        this.navigateToRoute({
          screen: 'Main',
          params: {
            screen: 'Home',
            params: {
              screen: 'HomeMain',
            },
          },
        });
        break;

      default:
        // Navigate to main screen
        this.navigateToRoute({
          screen: 'Main',
        });
        break;
    }
  }

  registerHandler(scheme: string, handler: DeepLinkHandler): void {
    this.handlers.set(scheme, handler);
  }

  private setupDefaultHandlers(): void {
    // WalletConnect URI handler
    this.registerHandler('wc', async (url: string) => {
      return this.handleWalletConnectUri(url);
    });

    // Voi URI handler (ARC-0090)
    this.registerHandler('voi', async (url: string) => {
      return this.handleArc0090Uri(url);
    });

    // Algorand URI handler (ARC-0090)
    this.registerHandler('algorand', async (url: string) => {
      return this.handleArc0090Uri(url);
    });

    // Pera Wallet URI handler (ARC-0090)
    this.registerHandler('perawallet', async (url: string) => {
      return this.handleArc0090Uri(url);
    });

    // HTTPS universal link handler
    this.registerHandler('https', async (url: string) => {
      return this.handleUniversalLink(url);
    });
  }

  private async handleUrl(url: string): Promise<boolean> {
    try {
      const scheme = this.extractScheme(url);
      if (!scheme) {
        console.warn('No scheme found in URL:', redactSensitiveForLog(url));
        return false;
      }

      const handler = this.handlers.get(scheme);
      if (handler) {
        return await handler(url);
      }

      console.warn(
        'No handler registered for scheme:',
        redactSensitiveForLog(scheme)
      );
      return false;
    } catch (error) {
      console.error('Error handling deep link:', redactError(error));
      return false;
    }
  }

  private async handleWalletConnectUri(url: string): Promise<boolean> {
    try {
      if (!isWalletConnectUri(url)) {
        return false;
      }

      // Detect WalletConnect version
      const version = detectWalletConnectVersion(url);

      if (version === 1) {
        return await this.handleWalletConnectV1Uri(url);
      } else if (version === 2) {
        return await this.handleWalletConnectV2Uri(url);
      } else {
        throw new Error('Unable to detect WalletConnect version from URI');
      }
    } catch (error) {
      // Show error screen for WalletConnect failures
      await this.navigateToRoute({
        screen: 'WalletConnectError',
        params: {
          error: error instanceof Error ? error.message : 'Failed to connect',
          uri: url,
        },
      });

      return false;
    }
  }

  private async handleWalletConnectV1Uri(url: string): Promise<boolean> {
    try {
      // Parse v1 URI
      const parsed = parseWalletConnectV1Uri(url);
      if (!parsed) {
        throw new Error('Invalid WalletConnect v1 URI format');
      }

      // Initialize WalletConnect v1 client
      const v1Client = WalletConnectV1Client.getInstance();

      // Set up event handlers
      v1Client.once('session_request', (sessionRequest) => {
        // Navigate to session proposal screen
        this.navigateToRoute({
          screen: 'WalletConnectSessionProposal',
          params: {
            version: 1,
            sessionRequest,
          },
        });
      });

      // Listen for transaction signing requests (permanent listener)
      v1Client.on('call_request', async (callRequest) => {
        // Transform v1 call_request format to match v2 format
        // v1 format: { id, method, params: transactions[] }
        // v2 format: { id, topic, params: { request: { method, params: [transactions[]] }, chainId } }
        const sessionData = v1Client.getSessionData();
        const transformedRequest = {
          id: callRequest.id,
          topic: sessionData?.handshakeTopic || parsed.topic,
          params: {
            request: {
              method: callRequest.method,
              // Wrap transactions array in another array to match v2 format
              params: [callRequest.params],
            },
            chainId: sessionData?.chainId || 416001, // Default to Algorand mainnet
          },
        };

        // Check if we're already on the TransactionRequestScreen
        if (this.navigationRef?.isReady()) {
          const currentRoute = this.navigationRef.getCurrentRoute();

          if (currentRoute?.name === 'WalletConnectTransactionRequest') {
            // Enqueue the request instead of navigating immediately
            console.log(
              '[DeepLinkService] Currently on transaction screen, enqueueing V1 request'
            );
            await TransactionRequestQueue.enqueue({
              id: transformedRequest.id,
              topic: transformedRequest.topic,
              params: transformedRequest.params,
              version: 1,
            });
            return;
          }
        }

        // Navigate to transaction request screen if not already there
        this.navigateToRoute({
          screen: 'WalletConnectTransactionRequest',
          params: {
            requestEvent: transformedRequest,
            version: 1,
          },
        });
      });

      v1Client.once('error', (error) => {
        console.error(
          'DeepLinkService: v1 connection error',
          redactError(error)
        );
        this.navigateToRoute({
          screen: 'WalletConnectError',
          params: {
            error: error instanceof Error ? error.message : 'Connection failed',
            uri: url,
          },
        });
      });

      // Connect to bridge
      await v1Client.connect({
        topic: parsed.topic,
        version: parsed.version,
        bridge: parsed.bridge,
        key: parsed.key,
      });

      return true;
    } catch (error) {
      console.error(
        'Failed to handle WalletConnect v1 URI:',
        redactError(error)
      );
      throw error;
    }
  }

  private async handleWalletConnectV2Uri(url: string): Promise<boolean> {
    try {
      // Determine URI type (pairing vs. request)
      if (isWalletConnectRequestUri(url)) {
        // This is a request deep link used to wake the app; do not call pair()
        const { requestId, sessionTopic } = parseWalletConnectRequestUri(url);

        // Let the pending session_request event drive navigation
        return true;
      }

      // Initialize WalletConnect service if needed (pairing flow)
      const wcService = WalletConnectService.getInstance();
      if (!wcService) {
        throw new Error('WalletConnect service not available');
      }

      // Parse the URI to validate format
      const parsed = parseWalletConnectUri(url);
      if (!parsed.topic) {
        throw new Error('Invalid WalletConnect URI format - no topic found');
      }

      // Only pair on actual pairing URIs (require relay-protocol in query)
      if (!isWalletConnectPairingUri(url)) {
        throw new Error('Not a valid pairing URI - missing relay protocol');
      }

      // Initiate pairing
      await wcService.pair(url);

      return true;
    } catch (error) {
      console.error(
        'Failed to handle WalletConnect v2 URI:',
        redactError(error)
      );
      throw error;
    }
  }

  /**
   * Handle ARC-0090 URIs (voi://, algorand://, perawallet://)
   * Supports payment, keyreg, appl, app-query, and asset-query types
   */
  private async handleArc0090Uri(url: string): Promise<boolean> {
    try {
      console.log(
        '[DeepLink] handleArc0090Uri - received URI:',
        redactSensitiveForLog(url)
      );

      // Check for legacy voi:// format first (voi://send?to=...)
      if (isLegacyVoiUri(url)) {
        console.log(
          '[DeepLink] handleArc0090Uri - detected legacy voi:// format'
        );
        return await this.handleLegacyVoiUri(url);
      }

      // Check if it's a valid ARC-0090 URI
      if (!isArc0090Uri(url)) {
        console.log('[DeepLink] handleArc0090Uri - not a valid ARC-0090 URI');
        return false;
      }

      const uriType = getArc0090UriType(url);
      console.log('[DeepLink] handleArc0090Uri - uriType:', uriType);
      if (!uriType) {
        console.warn(
          '[DeepLink] Unknown ARC-0090 URI type:',
          redactSensitiveForLog(url)
        );
        return false;
      }

      const parsed = parseArc0090Uri(url);
      // Redacted summary only: parsed contains full address + amount/note params.
      console.log('[DeepLink] handleArc0090Uri - parsed:', {
        type: parsed?.type,
        network: parsed?.network,
        scheme: parsed?.scheme,
        address:
          parsed && 'address' in parsed
            ? redactAddress(parsed.address)
            : undefined,
        params: '[redacted]',
      });
      if (!parsed) {
        console.error(
          '[DeepLink] Failed to parse ARC-0090 URI:',
          redactSensitiveForLog(url)
        );
        return false;
      }

      // Resolve target network from URI
      const targetNetwork = resolveNetworkFromAuthority(
        parsed.network,
        parsed.scheme
      );
      console.log(
        '[DeepLink] handleArc0090Uri - targetNetwork:',
        targetNetwork
      );

      // Check network compatibility and prompt for switch if needed
      const networkOk = await this.ensureCorrectNetwork(targetNetwork);
      console.log('[DeepLink] handleArc0090Uri - networkOk:', networkOk);
      if (!networkOk) {
        return false;
      }

      // Route to appropriate handler based on URI type
      console.log(
        '[DeepLink] handleArc0090Uri - routing to handler for type:',
        parsed.type
      );
      switch (parsed.type) {
        case 'payment':
          return await this.handlePaymentUri(parsed as Arc0090PaymentUri);
        case 'keyreg':
          return await this.handleKeyregUri(parsed as Arc0090KeyregUri);
        case 'appl':
          return await this.handleApplUri(parsed as Arc0090ApplUri);
        case 'app-query':
          return await this.handleAppQueryUri(parsed as Arc0090AppQueryUri);
        case 'asset-query':
          return await this.handleAssetQueryUri(parsed as Arc0090AssetQueryUri);
        default:
          console.warn(
            'Unhandled ARC-0090 URI type:',
            redactSensitiveForLog(uriType)
          );
          return false;
      }
    } catch (error) {
      console.error('[DeepLink] handleArc0090Uri - error:', redactError(error));
      await showAlert(
        'Invalid Deep Link',
        error instanceof Error ? error.message : 'Failed to process URI'
      );
      return false;
    }
  }

  /**
   * Ensures the app is on the correct network for the URI
   * Prompts user to switch if necessary
   */
  private async ensureCorrectNetwork(
    targetNetwork: NetworkId | null
  ): Promise<boolean> {
    if (!targetNetwork) {
      // No specific network required, use current
      return true;
    }

    const networkStore = useNetworkStore.getState();
    const currentNetwork = networkStore.currentNetwork;

    if (currentNetwork === targetNetwork) {
      return true;
    }

    // Get network display names
    const currentConfig = getNetworkConfig(currentNetwork);
    const targetConfig = getNetworkConfig(targetNetwork);

    // Prompt user to switch networks
    const shouldSwitch = await showAlert(
      'Switch Network?',
      `This request is for ${targetConfig.name}, but you're currently on ${currentConfig.name}. Would you like to switch networks?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Switch', style: 'default' },
      ]
    );

    if (!shouldSwitch) {
      return false;
    }

    try {
      await networkStore.switchNetwork(targetNetwork);
      return true;
    } catch (error) {
      console.error('Failed to switch network:', redactError(error));
      await showAlert(
        'Network Switch Failed',
        `Failed to switch to ${targetConfig.name}. Please try again.`
      );
      return false;
    }
  }

  /**
   * Handle payment URI
   */
  private async handlePaymentUri(parsed: Arc0090PaymentUri): Promise<boolean> {
    try {
      // Validate payment URI
      const validation = validatePaymentUri(parsed);
      if (!validation.valid) {
        console.error(
          'Invalid payment URI:',
          redactSensitiveForLog(validation.errors.join('; '))
        );
        await showAlert(
          'Invalid Payment Request',
          validation.errors.join('\n')
        );
        return false;
      }

      const params: Record<string, any> = {};

      if (parsed.address) {
        params.recipient = parsed.address;
      }

      if (parsed.params.amount) {
        // Pass the raw base-unit amount through untouched. SendScreen resolves
        // the asset's real decimals and converts to display exactly once. This
        // matches the URI format and the legacy voi:// path (both raw).
        params.amount = parsed.params.amount;
      }

      if (parsed.params.asset) {
        const assetId = parseInt(parsed.params.asset);
        // Only set asset parameter if it's not the native token (0)
        if (assetId !== 0) {
          params.asset = parsed.params.asset;
        }
      }

      if (parsed.params.note || parsed.params.xnote) {
        // Prefer xnote (non-modifiable) over note
        params.note = parsed.params.xnote || parsed.params.note;
        params.isXnote = !!parsed.params.xnote;
      }

      if (parsed.params.label) {
        params.label = parsed.params.label;
      }

      // NEW: Pass fee parameter if provided
      if (parsed.params.fee) {
        params.fee = parsed.params.fee;
      }

      await this.navigateToRoute({
        screen: 'Main',
        params: {
          screen: 'Home',
          params: {
            screen: 'Send',
            params,
          },
        },
      });

      return true;
    } catch (error) {
      console.error('Failed to handle payment URI:', redactError(error));
      return false;
    }
  }

  /**
   * Handle key registration URI
   */
  private async handleKeyregUri(parsed: Arc0090KeyregUri): Promise<boolean> {
    try {
      // Redacted summary only: parsed carries the address plus participation/
      // vote/selection keys, fee and note, none of which belong in logs.
      console.log('[DeepLink] handleKeyregUri - parsed:', {
        type: parsed.type,
        network: parsed.network,
        scheme: parsed.scheme,
        address: redactAddress(parsed.address),
        isOnline: parsed.isOnline,
        participationKeys: '[redacted]',
        fee: parsed.params.fee !== undefined ? '[redacted]' : undefined,
        note:
          parsed.params.xnote || parsed.params.note ? '[redacted]' : undefined,
      });

      // Validate keyreg URI
      const validation = validateKeyregUri(parsed);
      console.log('[DeepLink] handleKeyregUri - validation:', validation);
      if (!validation.valid) {
        console.error(
          'Invalid keyreg URI:',
          redactSensitiveForLog(validation.errors.join('; '))
        );
        await showAlert(
          'Invalid Key Registration Request',
          validation.errors.join('\n')
        );
        return false;
      }

      const currentNetwork = useNetworkStore.getState().currentNetwork;
      console.log(
        '[DeepLink] handleKeyregUri - currentNetwork:',
        currentNetwork
      );

      const navParams = {
        address: parsed.address,
        votekey: parsed.params.votekey,
        selkey: parsed.params.selkey,
        sprfkey: parsed.params.sprfkey,
        votefst: parsed.params.votefst
          ? parseInt(parsed.params.votefst)
          : undefined,
        votelst: parsed.params.votelst
          ? parseInt(parsed.params.votelst)
          : undefined,
        votekd: parsed.params.votekd
          ? parseInt(parsed.params.votekd)
          : undefined,
        fee: parsed.params.fee ? parseInt(parsed.params.fee) : undefined,
        note: parsed.params.xnote || parsed.params.note,
        isOnline: parsed.isOnline,
        networkId: currentNetwork,
      };
      // Redacted: navParams carries the address, participation keys, fee and
      // note. Log only the non-sensitive routing/round fields.
      console.log(
        '[DeepLink] handleKeyregUri - navigating to KeyregConfirm with params:',
        {
          address: redactAddress(navParams.address),
          isOnline: navParams.isOnline,
          networkId: navParams.networkId,
          votefst: navParams.votefst,
          votelst: navParams.votelst,
          votekd: navParams.votekd,
          participationKeys: '[redacted]',
          fee: navParams.fee !== undefined ? '[redacted]' : undefined,
          note: navParams.note ? '[redacted]' : undefined,
        }
      );

      // Use replace to dismiss the QRScanner and show KeyregConfirm in its place
      await this.navigateToRoute(
        {
          screen: 'KeyregConfirm',
          params: navParams,
        },
        { replace: true }
      );

      console.log('[DeepLink] handleKeyregUri - navigation complete');
      return true;
    } catch (error) {
      console.error('[DeepLink] handleKeyregUri - error:', redactError(error));
      return false;
    }
  }

  /**
   * Handle application call URI
   */
  private async handleApplUri(parsed: Arc0090ApplUri): Promise<boolean> {
    try {
      // Validate appl URI
      const validation = validateApplUri(parsed);
      if (!validation.valid) {
        console.error(
          'Invalid appl URI:',
          redactSensitiveForLog(validation.errors.join('; '))
        );
        await showAlert(
          'Invalid Application Call Request',
          validation.errors.join('\n')
        );
        return false;
      }

      const currentNetwork = useNetworkStore.getState().currentNetwork;

      // Use replace to dismiss the QRScanner and show AppCallConfirm in its place
      await this.navigateToRoute(
        {
          screen: 'AppCallConfirm',
          params: {
            senderAddress: parsed.address,
            appId: parseInt(parsed.params.app[0]),
            foreignApps: parsed.params.app.slice(1).map((id) => parseInt(id)),
            method: parsed.params.method,
            args: parsed.params.arg,
            boxes: parsed.params.box,
            foreignAssets: parsed.params.asset?.map((id) => parseInt(id)),
            foreignAccounts: parsed.params.account,
            fee: parsed.params.fee ? parseInt(parsed.params.fee) : undefined,
            note: parsed.params.xnote || parsed.params.note,
            networkId: currentNetwork,
          },
        },
        { replace: true }
      );

      return true;
    } catch (error) {
      console.error('Failed to handle appl URI:', redactError(error));
      return false;
    }
  }

  /**
   * Handle application query URI
   */
  private async handleAppQueryUri(
    parsed: Arc0090AppQueryUri
  ): Promise<boolean> {
    try {
      const currentNetwork = useNetworkStore.getState().currentNetwork;

      // Use replace to dismiss the QRScanner and show AppInfoModal in its place
      await this.navigateToRoute(
        {
          screen: 'AppInfoModal',
          params: {
            appId: parseInt(parsed.appId),
            networkId: currentNetwork,
            queryParams: parsed.params,
          },
        },
        { replace: true }
      );

      return true;
    } catch (error) {
      console.error('Failed to handle app query URI:', redactError(error));
      return false;
    }
  }

  /**
   * Handle asset query URI
   */
  private async handleAssetQueryUri(
    parsed: Arc0090AssetQueryUri
  ): Promise<boolean> {
    try {
      const currentNetwork = useNetworkStore.getState().currentNetwork;
      const walletStore = useWalletStore.getState();
      const activeAccountId = walletStore.wallet?.activeAccountId;

      // Use replace to dismiss the QRScanner and show AssetDetail in its place
      await this.navigateToRoute(
        {
          screen: 'AssetDetail',
          params: {
            assetId: parseInt(parsed.assetId),
            assetName: `Asset ${parsed.assetId}`,
            accountId: activeAccountId,
            networkId: currentNetwork,
          },
        },
        { replace: true }
      );

      return true;
    } catch (error) {
      console.error('Failed to handle asset query URI:', redactError(error));
      return false;
    }
  }

  private async handleLegacyVoiUri(url: string): Promise<boolean> {
    try {
      if (!isVoiUri(url)) {
        return false;
      }

      // Parse Voi-specific URI
      const parsed = this.parseVoiUri(url);

      switch (parsed.action) {
        case 'send':
          await this.navigateToRoute({
            screen: 'Main',
            params: {
              screen: 'Home',
              params: {
                screen: 'Send',
                params: {
                  recipient: parsed.params.to,
                  amount: parsed.params.amount,
                  note: parsed.params.note,
                },
              },
            },
          });
          return true;

        case 'receive':
          await this.navigateToRoute({
            screen: 'Main',
            params: {
              screen: 'Receive',
              params: parsed.params,
            },
          });
          return true;

        case 'connect':
          // Handle custom wallet connection
          return await this.handleWalletConnectUri(parsed.params.wc_uri || '');

        default:
          console.warn(
            'Unknown Voi URI action:',
            redactSensitiveForLog(parsed.action)
          );
          return false;
      }
    } catch (error) {
      console.error('Failed to handle legacy Voi URI:', redactError(error));
      return false;
    }
  }

  private async handleUniversalLink(url: string): Promise<boolean> {
    try {
      // Parse the URL to check if it's a www.getvoi.app link
      const urlObj = new URL(url);

      if (urlObj.hostname !== 'www.getvoi.app') {
        console.warn(
          'Universal link not for www.getvoi.app:',
          redactSensitiveForLog(url)
        );
        return false;
      }

      // Handle /wc path for WalletConnect
      if (urlObj.pathname.startsWith('/wc')) {
        // Extract the WalletConnect URI from query parameters
        // Support both 'uri' and direct WC parameters
        const wcUri = urlObj.searchParams.get('uri');

        if (wcUri) {
          // Decode and handle the WalletConnect URI
          const decodedUri = decodeURIComponent(wcUri);
          console.log(
            'Handling WalletConnect URI from universal link:',
            redactSensitiveForLog(decodedUri)
          );
          return await this.handleWalletConnectUri(decodedUri);
        } else {
          console.warn(
            'No WalletConnect URI found in universal link:',
            redactSensitiveForLog(url)
          );
          return false;
        }
      }

      console.warn(
        'Unknown universal link path:',
        redactSensitiveForLog(urlObj.pathname)
      );
      return false;
    } catch (error) {
      console.error('Failed to handle universal link:', redactError(error));
      return false;
    }
  }

  private parseVoiUri(url: string): {
    action: string;
    params: Record<string, string>;
  } {
    // Voi URI format: voi://action?param1=value1&param2=value2
    const withoutProtocol = url.replace(/^voi:\/\//i, '');
    const [action, paramsString] = withoutProtocol.split('?');

    const params: Record<string, string> = {};
    if (paramsString) {
      const searchParams = new URLSearchParams(paramsString);
      for (const [key, value] of searchParams.entries()) {
        params[key] = value;
      }
    }

    return { action: action || '', params };
  }

  private extractScheme(url: string): string | null {
    const match = url.match(/^([^:]+):/);
    return match ? match[1] : null;
  }

  private async navigateToRoute(
    route: DeepLinkRoute,
    options?: { replace?: boolean }
  ): Promise<void> {
    // Log route name + param keys only; param values can carry
    // recipient addresses, amounts, notes and keyreg key material.
    console.log(
      '[DeepLink] navigateToRoute - route:',
      route.screen,
      'paramKeys:',
      route.params ? Object.keys(route.params) : [],
      'replace:',
      options?.replace
    );
    console.log(
      '[DeepLink] navigateToRoute - navigationRef:',
      !!this.navigationRef,
      'isReady:',
      this.navigationRef?.isReady()
    );

    if (!this.navigationRef?.isReady()) {
      console.warn('[DeepLink] Navigation not ready, waiting...');
      // Wait a bit for navigation to be ready
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!this.navigationRef?.isReady()) {
        console.error('[DeepLink] Navigation still not ready after waiting');
        return;
      }
    }

    try {
      console.log(
        '[DeepLink] navigateToRoute - calling',
        options?.replace ? 'dispatch replace' : 'navigate'
      );
      // Use type assertion to handle React Navigation's complex generic types
      if (options?.replace) {
        // Use StackActions.replace to replace current screen in stack
        const { StackActions } = require('@react-navigation/native');
        this.navigationRef.dispatch(
          StackActions.replace(route.screen, route.params)
        );
      } else {
        (this.navigationRef as any).navigate(route.screen, route.params);
      }
      console.log(
        '[DeepLink] navigateToRoute - navigation called successfully'
      );
    } catch (error) {
      console.error(
        '[DeepLink] navigateToRoute - Failed to navigate:',
        route.screen,
        route.params ? Object.keys(route.params) : [],
        redactError(error)
      );
      throw error;
    }
  }

  // Utility method to test deep link handling
  async testDeepLink(url: string): Promise<boolean> {
    return await this.handleUrl(url);
  }
}
