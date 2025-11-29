// Background service worker for Voi Wallet extension
// Opens the wallet in a dedicated window instead of a popup

const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 800;

let walletWindowId = null;

// Listen for extension icon clicks
chrome.action.onClicked.addListener(async () => {
  // Check if wallet window already exists
  if (walletWindowId !== null) {
    try {
      const existingWindow = await chrome.windows.get(walletWindowId);
      if (existingWindow) {
        // Window exists, focus it
        await chrome.windows.update(walletWindowId, { focused: true });
        return;
      }
    } catch (e) {
      // Window no longer exists
      walletWindowId = null;
    }
  }

  // Create new wallet window
  const window = await chrome.windows.create({
    url: chrome.runtime.getURL('index.html'),
    type: 'popup',
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focused: true
  });

  walletWindowId = window.id;
});

// Clean up when wallet window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === walletWindowId) {
    walletWindowId = null;
  }
});
