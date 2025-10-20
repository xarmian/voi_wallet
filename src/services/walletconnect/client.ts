import { ICore } from '@walletconnect/types';
import UniversalProvider from '@walletconnect/universal-provider';
import '@walletconnect/react-native-compat';

import { WALLETCONNECT_CONFIG } from './config';

export class WalletConnectClient {
  private static instance: WalletConnectClient;
  private core: ICore | null = null;
  private provider: UniversalProvider | null = null;
  private initialized = false;

  static getInstance(): WalletConnectClient {
    if (!WalletConnectClient.instance) {
      WalletConnectClient.instance = new WalletConnectClient();
    }
    return WalletConnectClient.instance;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // Check if we have a valid project ID
      if (
        WALLETCONNECT_CONFIG.projectId ===
        'PLACEHOLDER_WALLETCONNECT_PROJECT_ID'
      ) {
        console.warn(
          'WalletConnect: Using placeholder project ID. Please configure a real project ID from https://cloud.walletconnect.com'
        );
        // For development, we'll continue with the placeholder
        // In production, this should throw an error
      }

      // Initialize Universal Provider (RN compat sets storage/crypto)
      this.provider = await UniversalProvider.init({
        projectId: WALLETCONNECT_CONFIG.projectId,
        metadata: WALLETCONNECT_CONFIG.metadata,
      });

      // Disable automatic responses by removing default handlers
      if (this.provider.client) {
        // Remove any automatic response handlers
        this.provider.client.removeAllListeners('session_request');
      }

      // Capture underlying core from the provider
      this.core = (this.provider as any)?.client?.core ?? null;

      this.initialized = true;
      console.log('WalletConnect client initialized successfully');
    } catch (error) {
      console.error('Failed to initialize WalletConnect client:', error);
      throw new Error(
        `WalletConnect initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  getCore(): ICore {
    if (!this.core) {
      throw new Error('WalletConnect core not initialized');
    }
    return this.core;
  }

  getProvider(): UniversalProvider {
    if (!this.provider) {
      throw new Error('WalletConnect provider not initialized');
    }
    return this.provider;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async disconnect(): Promise<void> {
    if (this.provider) {
      await this.provider.cleanupPendingPairings();
    }
    this.initialized = false;
    this.core = null;
    this.provider = null;
  }
}
