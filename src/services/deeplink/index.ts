import { Linking } from 'react-native';
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
  isWalletConnectV1Uri,
  parseWalletConnectV1Uri,
} from '@/services/walletconnect/utils';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import {
  isAlgorandPaymentUri,
  parseAlgorandUri,
  convertAmountToDisplay,
} from '@/utils/algorandUri';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';

export type DeepLinkHandler = (url: string) => Promise<boolean>;

export interface DeepLinkRoute {
  screen: string;
  params?: any;
}

export class DeepLinkService {
  private static instance: DeepLinkService;
  private navigationRef: NavigationContainerRef<any> | null = null;
  private handlers: Map<string, DeepLinkHandler> = new Map();

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

  async initialize(): Promise<void> {
    try {
      // Handle initial URL if app was opened via deep link
      const initialUrl = await Linking.getInitialURL();
      if (initialUrl) {
        console.log('Handling initial deep link:', initialUrl);
        await this.handleUrl(initialUrl);
      }

      // Listen for incoming deep links
      const linkingListener = Linking.addEventListener('url', ({ url }) => {
        console.log('Received deep link:', url);
        this.handleUrl(url).catch((error) => {
          console.error('Failed to handle deep link:', error);
        });
      });

      return () => {
        linkingListener?.remove();
      };
    } catch (error) {
      console.error('Failed to initialize deep link service:', error);
      throw error;
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

    // Voi URI handler
    this.registerHandler('voi', async (url: string) => {
      return this.handlePaymentUri(url);
    });

    // Algorand URI handler
    this.registerHandler('algorand', async (url: string) => {
      return this.handlePaymentUri(url);
    });

    // Pera Wallet URI handler
    this.registerHandler('perawallet', async (url: string) => {
      return this.handlePaymentUri(url);
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
        console.warn('No scheme found in URL:', url);
        return false;
      }

      const handler = this.handlers.get(scheme);
      if (handler) {
        return await handler(url);
      }

      console.warn(`No handler registered for scheme: ${scheme}`);
      return false;
    } catch (error) {
      console.error('Error handling deep link:', error);
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
            console.log('[DeepLinkService] Currently on transaction screen, enqueueing V1 request');
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
        console.error('DeepLinkService: v1 connection error', error);
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
      console.error('Failed to handle WalletConnect v1 URI:', error);
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
      console.error('Failed to handle WalletConnect v2 URI:', error);
      throw error;
    }
  }

  private async handlePaymentUri(url: string): Promise<boolean> {
    try {
      // Check if it's an Algorand/Voi payment request URI
      if (isAlgorandPaymentUri(url)) {
        return await this.handleAlgorandPaymentRequest(url);
      }

      // Fall back to legacy Voi URI format for backwards compatibility
      if (isVoiUri(url)) {
        return await this.handleLegacyVoiUri(url);
      }

      return false;
    } catch (error) {
      console.error('Failed to handle payment URI:', error);
      return false;
    }
  }

  private async handleAlgorandPaymentRequest(url: string): Promise<boolean> {
    try {
      const parsed = parseAlgorandUri(url);

      if (!parsed || !parsed.isValid) {
        console.error('Invalid Algorand payment URI:', url);
        return false;
      }

      const params: Record<string, any> = {};

      if (parsed.address) {
        params.recipient = parsed.address;
      }

      if (parsed.params.amount) {
        // Convert from smallest units to display format
        const assetId = parsed.params.asset ? parseInt(parsed.params.asset) : 0;
        const isNativeToken = assetId === 0;
        const decimals = isNativeToken ? 6 : 0; // VOI has 6 decimals, other assets default to 0
        params.amount = convertAmountToDisplay(parsed.params.amount, decimals);
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
      }

      if (parsed.params.label) {
        params.label = parsed.params.label;
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
      console.error('Failed to handle Algorand payment request:', error);
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
          console.warn('Unknown Voi URI action:', parsed.action);
          return false;
      }
    } catch (error) {
      console.error('Failed to handle legacy Voi URI:', error);
      return false;
    }
  }

  private async handleUniversalLink(url: string): Promise<boolean> {
    try {
      // Parse the URL to check if it's a www.getvoi.app link
      const urlObj = new URL(url);

      if (urlObj.hostname !== 'www.getvoi.app') {
        console.warn('Universal link not for www.getvoi.app:', url);
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
          console.log('Handling WalletConnect URI from universal link:', decodedUri);
          return await this.handleWalletConnectUri(decodedUri);
        } else {
          console.warn('No WalletConnect URI found in universal link:', url);
          return false;
        }
      }

      console.warn('Unknown universal link path:', urlObj.pathname);
      return false;
    } catch (error) {
      console.error('Failed to handle universal link:', error);
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

  private async navigateToRoute(route: DeepLinkRoute): Promise<void> {
    if (!this.navigationRef?.isReady()) {
      console.warn('Navigation not ready, waiting...');
      // Wait a bit for navigation to be ready
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!this.navigationRef?.isReady()) {
        console.error('Navigation still not ready after waiting');
        return;
      }
    }

    try {
      this.navigationRef.navigate(route.screen as never, route.params as never);
    } catch (error) {
      console.error('Failed to navigate to route:', route, error);
      throw error;
    }
  }

  // Utility method to test deep link handling
  async testDeepLink(url: string): Promise<boolean> {
    return await this.handleUrl(url);
  }
}
