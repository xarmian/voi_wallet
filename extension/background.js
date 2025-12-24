// Background service worker for Voi Wallet extension
// Opens the wallet in a dedicated window instead of a popup

const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 800;
const WC_PENDING_URI_KEY = 'voi_wallet_pending_wc_uri';

let walletWindowId = null;

// Listen for external messages (from getvoi.app)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  // Verify sender is from allowed origin
  if (sender.origin && (
    sender.origin === 'https://www.getvoi.app' ||
    sender.origin.endsWith('.getvoi.app')
  )) {
    if (message.type === 'WALLETCONNECT_URI' && message.uri) {
      handleWalletConnectUri(message.uri);
      sendResponse({ received: true });
    }
  }
  return true; // Keep channel open for async response
});

async function handleWalletConnectUri(uri) {
  console.log('[Background] Handling WalletConnect URI:', uri);

  // Store the URI for the React app to pick up
  await chrome.storage.local.set({
    [WC_PENDING_URI_KEY]: {
      uri: uri,
      timestamp: Date.now()
    }
  });

  // Open or focus the wallet window
  await openOrFocusWallet(uri);
}

async function openOrFocusWallet(wcUri) {
  // Check if wallet window already exists
  if (walletWindowId !== null) {
    try {
      const existingWindow = await chrome.windows.get(walletWindowId);
      if (existingWindow) {
        // Window exists, focus it
        await chrome.windows.update(walletWindowId, { focused: true });
        // URI is already in storage, React app will pick it up via storage listener
        return;
      }
    } catch (e) {
      // Window no longer exists
      walletWindowId = null;
    }
  }

  // Build URL with optional WC URI parameter for initial load
  let url = chrome.runtime.getURL('index.html');
  if (wcUri) {
    url += '?wc=' + encodeURIComponent(wcUri);
  }

  // Create new wallet window
  const window = await chrome.windows.create({
    url: url,
    type: 'popup',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focused: true
  });

  walletWindowId = window.id;
}

// Listen for extension icon clicks
chrome.action.onClicked.addListener(async () => {
  await openOrFocusWallet();
});

// Clean up when wallet window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === walletWindowId) {
    walletWindowId = null;
  }
});
