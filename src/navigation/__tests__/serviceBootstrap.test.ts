/**
 * Regression test for TASK-243.
 *
 * AppNavigator's service-boot effect declared `initializeServices` as an async
 * function that RETURNED a teardown closure (WalletConnect session_proposal /
 * session_request unregister + extensionDeepLinkHandler.cleanup /
 * notificationService.cleanup). The effect invoked it as a bare statement, so
 * that returned closure was wrapped in a Promise and DISCARDED — the effect
 * returned `undefined` and no teardown ever ran on unmount.
 *
 * The fix hoists the teardown into a `cleanupRef` the async boot assigns, which
 * the effect's SYNCHRONOUS return invokes on unmount. Mounting the full
 * AppNavigator under jest is impractical (its ~70-screen native module graph
 * won't load), so the boot body was extracted verbatim into
 * `serviceBootstrap.ts` (deps injected) — the smallest unit that still exercises
 * the REAL init + teardown wiring. This test drives that unit directly:
 * it runs the real boot, then invokes the captured teardown (the unmount
 * simulation) and asserts every unregister/cleanup fires.
 *
 * All services/stores are mocked as opaque effect sinks — the test only asserts
 * the wiring calls them; no key/mnemonic/network material is fabricated.
 */

import { initializeServices } from '../serviceBootstrap';

// --- Mock leaves (all prefixed `mock` so jest can hoist them into factories) ---
const mockWcService = {
  initialize: jest.fn(async () => {}),
  on: jest.fn(),
  off: jest.fn(),
};
const mockDeepLinkService = {
  setNavigationRef: jest.fn(),
  initialize: jest.fn(async () => {}),
  testDeepLink: jest.fn(async () => {}),
};
const mockExtensionDeepLinkHandler = {
  initialize: jest.fn(),
  cleanup: jest.fn(),
};
const mockNotificationService = {
  initialize: jest.fn(async () => {}),
  registerPushToken: jest.fn(async () => null as string | null),
  subscribeAllAccounts: jest.fn(async () => {}),
  cleanup: jest.fn(),
};
const mockTxnQueue = {
  enqueue: jest.fn(async () => {}),
  setProcessing: jest.fn(async () => {}),
  isEmpty: jest.fn(async () => true),
  peek: jest.fn(async () => null),
  dequeue: jest.fn(async () => {}),
};
// Mutable app mode driven per test ('user' vs 'signer').
let mockAppMode = 'user';

jest.mock('@/store/remoteSignerStore', () => ({
  useRemoteSignerStore: {
    getState: () => ({ initialize: jest.fn(async () => {}) }),
  },
  getAppModeEarly: jest.fn(async () => mockAppMode),
}));

jest.mock('@/store/walletStore', () => ({
  useWalletStore: {
    getState: () => ({ initialize: jest.fn(async () => {}) }),
  },
}));

jest.mock('@/services/walletconnect', () => ({
  WalletConnectService: { getInstance: jest.fn(() => mockWcService) },
}));

jest.mock('@/services/deeplink', () => ({
  DeepLinkService: { getInstance: jest.fn(() => mockDeepLinkService) },
}));

// Getter exports: jest hoists these factories above the `const mock*`
// declarations, so a direct reference would capture `undefined`. A getter
// defers the read to use-time, once the consts are initialized.
jest.mock('@/services/deeplink/extensionHandler', () => ({
  get extensionDeepLinkHandler() {
    return mockExtensionDeepLinkHandler;
  },
}));

jest.mock('@/services/walletconnect/utils', () => ({
  isWalletConnectUri: jest.fn(() => false),
}));

jest.mock('@/services/notifications', () => ({
  get notificationService() {
    return mockNotificationService;
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getCurrentWallet: jest.fn(async () => null) },
}));

jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    initializeIfPersistedDevices: jest.fn(async () => false),
  },
}));

jest.mock('@/services/walletconnect/TransactionRequestQueue', () => ({
  get TransactionRequestQueue() {
    return mockTxnQueue;
  },
}));

jest.mock('@/platform/detection', () => ({
  detectPlatform: jest.fn(() => 'mobile'),
}));

const makeCleanupRef = () => ({
  current: undefined as (() => void) | undefined,
});

describe('serviceBootstrap.initializeServices — TASK-243 teardown wiring', () => {
  beforeEach(() => {
    // jest.config `clearMocks: true` resets call history; only the mutable app
    // mode needs resetting.
    mockAppMode = 'user';
  });

  it('captures a teardown that unregisters BOTH WalletConnect handlers and cleans up deep-link + notifications on unmount', async () => {
    const cleanupRef = makeCleanupRef();
    const initializeNetwork = jest.fn(async () => {});

    await initializeServices({
      navigationRef: { current: null },
      initializeNetwork,
      cleanupRef,
    });

    // Init actually ran and the WC handler registration (unchanged by the fix)
    // is reachable for BOTH events.
    expect(initializeNetwork).toHaveBeenCalledTimes(1);
    expect(mockWcService.on).toHaveBeenCalledWith(
      'session_proposal',
      expect.any(Function)
    );
    expect(mockWcService.on).toHaveBeenCalledWith(
      'session_request',
      expect.any(Function)
    );

    // The core of the fix: a teardown was actually captured (before, it was
    // wrapped in a discarded Promise and lost).
    expect(typeof cleanupRef.current).toBe('function');

    // ...and nothing has torn down yet — the teardown only runs on unmount.
    expect(mockWcService.off).not.toHaveBeenCalled();
    expect(mockExtensionDeepLinkHandler.cleanup).not.toHaveBeenCalled();
    expect(mockNotificationService.cleanup).not.toHaveBeenCalled();

    // Simulate the effect's synchronous unmount cleanup.
    cleanupRef.current!();

    // BOTH WalletConnect handlers are unregistered...
    expect(mockWcService.off).toHaveBeenCalledWith(
      'session_proposal',
      expect.any(Function)
    );
    expect(mockWcService.off).toHaveBeenCalledWith(
      'session_request',
      expect.any(Function)
    );
    // ...and the deep-link + notification services are cleaned up.
    expect(mockExtensionDeepLinkHandler.cleanup).toHaveBeenCalledTimes(1);
    expect(mockNotificationService.cleanup).toHaveBeenCalledTimes(1);
  });

  it('tears services down IMMEDIATELY when the effect already unmounted before boot completed (isDisposed)', async () => {
    // Models a fast unmount / Fast Refresh before boot finished: the effect's
    // synchronous cleanup already ran (no-op, teardown did not exist yet), so
    // the boot must not leave the WalletConnect handlers registered against a
    // dead navigator — it runs the teardown as soon as it is assigned.
    const cleanupRef = makeCleanupRef();

    await initializeServices({
      navigationRef: { current: null },
      initializeNetwork: jest.fn(async () => {}),
      cleanupRef,
      isDisposed: () => true,
    });

    // Handlers were registered during boot...
    expect(mockWcService.on).toHaveBeenCalledWith(
      'session_proposal',
      expect.any(Function)
    );
    expect(mockWcService.on).toHaveBeenCalledWith(
      'session_request',
      expect.any(Function)
    );
    // ...and torn straight back down because the component was already gone.
    expect(mockWcService.off).toHaveBeenCalledWith(
      'session_proposal',
      expect.any(Function)
    );
    expect(mockWcService.off).toHaveBeenCalledWith(
      'session_request',
      expect.any(Function)
    );
    expect(mockExtensionDeepLinkHandler.cleanup).toHaveBeenCalledTimes(1);
    expect(mockNotificationService.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-tear-down when still mounted (isDisposed false) — teardown waits for unmount', async () => {
    const cleanupRef = makeCleanupRef();

    await initializeServices({
      navigationRef: { current: null },
      initializeNetwork: jest.fn(async () => {}),
      cleanupRef,
      isDisposed: () => false,
    });

    // A teardown is captured but must NOT have run — the component is live.
    expect(typeof cleanupRef.current).toBe('function');
    expect(mockWcService.off).not.toHaveBeenCalled();
    expect(mockExtensionDeepLinkHandler.cleanup).not.toHaveBeenCalled();
    expect(mockNotificationService.cleanup).not.toHaveBeenCalled();
  });

  it('in signer mode, the captured teardown skips the network-service cleanup (air-gapped: nothing was registered)', async () => {
    mockAppMode = 'signer';
    const cleanupRef = makeCleanupRef();

    await initializeServices({
      navigationRef: { current: null },
      initializeNetwork: jest.fn(async () => {}),
      cleanupRef,
    });

    // A teardown is still captured (the ref is always assigned)...
    expect(typeof cleanupRef.current).toBe('function');

    // ...but signer mode never boots the network services, so nothing was
    // registered and running the teardown must be a safe no-op.
    expect(mockWcService.on).not.toHaveBeenCalled();

    cleanupRef.current!();

    expect(mockWcService.off).not.toHaveBeenCalled();
    expect(mockExtensionDeepLinkHandler.cleanup).not.toHaveBeenCalled();
    expect(mockNotificationService.cleanup).not.toHaveBeenCalled();
  });
});
