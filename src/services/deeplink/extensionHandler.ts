/**
 * Extension-specific deep link handler
 * Monitors chrome.storage for pending WalletConnect URIs passed from
 * the extension background service worker.
 */

import { Platform } from 'react-native';
import { detectPlatform } from '@/platform/detection';

const WC_PENDING_URI_KEY = 'voi_wallet_pending_wc_uri';
const URI_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export interface PendingWcUri {
  uri: string;
  timestamp: number;
}

type UriCallback = (uri: string) => void;

export class ExtensionDeepLinkHandler {
  private static instance: ExtensionDeepLinkHandler;
  private onUriCallback: UriCallback | null = null;
  private storageListener:
    | ((
        changes: { [key: string]: chrome.storage.StorageChange },
        areaName: string
      ) => void)
    | null = null;

  static getInstance(): ExtensionDeepLinkHandler {
    if (!ExtensionDeepLinkHandler.instance) {
      ExtensionDeepLinkHandler.instance = new ExtensionDeepLinkHandler();
    }
    return ExtensionDeepLinkHandler.instance;
  }

  isExtension(): boolean {
    return Platform.OS === 'web' && detectPlatform() === 'extension';
  }

  async initialize(onUri: UriCallback): Promise<void> {
    if (!this.isExtension()) {
      return;
    }

    this.onUriCallback = onUri;

    // Check for URI in URL query params (initial load)
    await this.checkUrlParams();

    // Check for pending URI in storage
    await this.checkPendingUri();

    // Listen for storage changes (for URIs received while app is open)
    this.setupStorageListener();
  }

  private async checkUrlParams(): Promise<void> {
    if (typeof window === 'undefined') return;

    const params = new URLSearchParams(window.location.search);
    const wcUri = params.get('wc');

    if (wcUri) {
      console.log('[ExtensionDeepLinkHandler] Found WC URI in URL params');
      // Clear the URL param to prevent re-processing on refresh
      window.history.replaceState({}, '', window.location.pathname);
      this.onUriCallback?.(decodeURIComponent(wcUri));
    }
  }

  private async checkPendingUri(): Promise<void> {
    if (typeof chrome === 'undefined' || !chrome.storage) return;

    return new Promise((resolve) => {
      chrome.storage.local.get([WC_PENDING_URI_KEY], (result) => {
        const pending = result[WC_PENDING_URI_KEY] as PendingWcUri | undefined;

        if (pending && pending.uri) {
          const age = Date.now() - pending.timestamp;

          if (age < URI_EXPIRY_MS) {
            console.log(
              '[ExtensionDeepLinkHandler] Found pending WC URI in storage'
            );
            // Clear the pending URI
            chrome.storage.local.remove([WC_PENDING_URI_KEY]);
            this.onUriCallback?.(pending.uri);
          } else {
            // URI expired, clean it up
            chrome.storage.local.remove([WC_PENDING_URI_KEY]);
          }
        }
        resolve();
      });
    });
  }

  private setupStorageListener(): void {
    if (typeof chrome === 'undefined' || !chrome.storage) return;

    this.storageListener = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string
    ) => {
      if (areaName !== 'local') return;

      if (changes[WC_PENDING_URI_KEY]) {
        const newValue = changes[WC_PENDING_URI_KEY].newValue as
          | PendingWcUri
          | undefined;

        if (newValue && newValue.uri) {
          const age = Date.now() - newValue.timestamp;

          if (age < URI_EXPIRY_MS) {
            console.log(
              '[ExtensionDeepLinkHandler] Received new WC URI via storage'
            );
            // Clear the pending URI
            chrome.storage.local.remove([WC_PENDING_URI_KEY]);
            this.onUriCallback?.(newValue.uri);
          }
        }
      }
    };

    chrome.storage.onChanged.addListener(this.storageListener);
  }

  cleanup(): void {
    if (
      this.storageListener &&
      typeof chrome !== 'undefined' &&
      chrome.storage
    ) {
      chrome.storage.onChanged.removeListener(this.storageListener);
    }
    this.storageListener = null;
    this.onUriCallback = null;
  }
}

export const extensionDeepLinkHandler = ExtensionDeepLinkHandler.getInstance();
