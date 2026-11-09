/**
 * Entry-point behaviour of the service boot for WalletConnect events: what the
 * coordinator answers before anything reaches the review queue (replay, expiry,
 * session end, publish retry, setup-incomplete refusal). What an admitted
 * arrival does once it reaches the queue is in serviceBootstrapFeed.test.ts.
 *
 * No key, mnemonic or signature material is involved: requests carry an
 * opaque placeholder payload the handlers never inspect.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { initializeServices } from '../serviceBootstrap';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';
import { answerDroppedRequests } from '@/services/walletconnect/droppedRequestResponder';

import { HandledStore } from '@/services/walletconnect/handledStore';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import {
  clearPinSetupPending,
  markPinSetupPending,
} from '@/services/secure/pinSetupPending';
import {
  RequestCoordinator,
  CoordinatorTransport,
} from '@/services/walletconnect/requestCoordinator';
import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { requestRefFor } from '@/services/walletconnect/requestRefs';

const mockTransport: jest.Mocked<CoordinatorTransport> = {
  rejectRequestV2: jest.fn<
    Promise<void>,
    Parameters<CoordinatorTransport['rejectRequestV2']>
  >(async () => {}),
  rejectRequestV1: jest.fn<
    Promise<void>,
    Parameters<CoordinatorTransport['rejectRequestV1']>
  >(async () => {}),
  rejectProposalV2: jest.fn<
    Promise<void>,
    Parameters<CoordinatorTransport['rejectProposalV2']>
  >(async () => {}),
  rejectProposalV1: jest.fn<
    Promise<void>,
    Parameters<CoordinatorTransport['rejectProposalV1']>
  >(async () => {}),
};
jest.mock('@/services/walletconnect/coordinatorTransport', () => ({
  createCoordinatorTransport: () => mockTransport,
}));
let store: HandledStore;
let coordinator: RequestCoordinator;
let queue: RequestQueue;

type Listener = (event: any) => unknown;

const mockWcListeners: Record<string, Listener[]> = {};
const mockWcService = {
  initialize: jest.fn(async () => {}),
  on: jest.fn((event: string, listener: Listener) => {
    (mockWcListeners[event] ||= []).push(listener);
  }),
  off: jest.fn(),
};

// Fake NavigationContainer ref; readiness flips when the "navigator mounts".
let mockReady = false;
const mockReadyCallbacks = new Set<() => void>();
const mockNav = {
  isReady: jest.fn(() => mockReady),
  canGoBack: jest.fn(() => false),
  goBack: jest.fn(),
  navigate: jest.fn(),
  dispatch: jest.fn(),
  getCurrentRoute: jest.fn((): { name: string } | undefined => undefined),
};
/** Current route name; drives getCurrentRoute. */
let mockRoute: string | undefined;

let mockRouteQueue: { deliver: (key: string, run: any) => Promise<void> };
const mockDeepLinkService = {
  setNavigationRef: jest.fn(),
  initialize: jest.fn(async () => {}),
  testDeepLink: jest.fn(async () => {}),
  cleanup: jest.fn(),
  deliverRoute: (key: string, run: any) => mockRouteQueue.deliver(key, run),
  // As DeepLinkService: a fresh route key per signing delivery.
  deliverSigningRequest: (run: any) =>
    mockRouteQueue.deliver(`wc:signing:${++mockSigningSeq}`, run),
};
let mockSigningSeq = 0;

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/store/remoteSignerStore', () => ({
  useRemoteSignerStore: {
    getState: () => ({ initialize: jest.fn(async () => {}) }),
  },
  getAppModeEarly: jest.fn(async () => 'user'),
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: {
    getState: () => ({ initialize: jest.fn(async () => {}) }),
  },
}));
jest.mock('@/services/walletconnect', () => ({
  get WalletConnectService() {
    return { getInstance: () => mockWcService };
  },
}));
jest.mock('@/services/deeplink', () => ({
  get DeepLinkService() {
    return { getInstance: () => mockDeepLinkService };
  },
}));
// The handler the boot installs on the queue (TASK-394); mocked at the queue
// boundary, so no WalletConnect client is involved.
jest.mock('@/services/walletconnect/droppedRequestResponder', () => ({
  answerDroppedRequests: jest.fn(),
}));
jest.mock('@/services/deeplink/extensionHandler', () => ({
  extensionDeepLinkHandler: { initialize: jest.fn(), cleanup: jest.fn() },
}));
jest.mock('@/services/walletconnect/utils', () => ({
  isWalletConnectUri: jest.fn(() => false),
}));
jest.mock('@/services/notifications', () => ({
  notificationService: {
    initialize: jest.fn(async () => {}),
    registerPushToken: jest.fn(async () => null),
    subscribeAllAccounts: jest.fn(async () => {}),
    cleanup: jest.fn(),
  },
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: jest.fn(async () => null),
    hasKeyBearingAccountStrict: jest.fn(async () => false),
  },
}));
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    initializeIfPersistedDevices: jest.fn(async () => false),
  },
}));
jest.mock('@/platform/detection', () => ({
  detectPlatform: jest.fn(() => 'mobile'),
  isMobile: jest.fn(() => true),
}));

const { createPendingRouteQueue } = jest.requireActual(
  '@/services/deeplink/pendingRoute'
);

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};

const becomeReady = () => {
  mockReady = true;
  mockReadyCallbacks.forEach((cb) => cb());
};

const emit = async (event: string, payload: unknown) => {
  for (const listener of mockWcListeners[event] || []) {
    void listener(payload);
  }
  await flush();
};

const request = (id: number, topic = 'topic-a') => ({
  id,
  topic,
  params: {
    request: { method: 'algo_signTxn', params: [[{ txn: 'opaque' }]] },
    chainId: 'algorand:opaque',
  },
});

const boot = () =>
  initializeServices({
    navigationRef: { current: mockNav },
    initializeNetwork: jest.fn(async () => {}),
    cleanupRef: { current: undefined },
  });

beforeEach(async () => {
  for (const key of Object.keys(mockWcListeners)) delete mockWcListeners[key];
  mockReady = false;
  mockReadyCallbacks.clear();
  mockRoute = undefined;
  mockNav.navigate.mockReset();
  mockNav.dispatch.mockReset();
  mockNav.isReady.mockReset().mockImplementation(() => mockReady);
  mockNav.getCurrentRoute.mockImplementation(() =>
    mockRoute ? { name: mockRoute } : undefined
  );
  await AsyncStorage.clear();
  HandledStore.getInstance().__resetForTests();
  store = new HandledStore();
  coordinator = new RequestCoordinator({ store, transport: mockTransport });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  queue = new RequestQueue({ coordinator });
  jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
  Object.values(mockTransport).forEach((fn) => fn.mockClear());
  mockNav.canGoBack.mockReturnValue(false);
  mockNav.goBack.mockClear();
  mockWcService.off.mockClear();
  mockRouteQueue = createPendingRouteQueue({
    now: () => Date.now(),
    isReady: () => mockReady,
    onReady: (cb: () => void) => {
      mockReadyCallbacks.add(cb);
      return () => mockReadyCallbacks.delete(cb);
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  coordinator.__resetForTests();
  queue.__resetForTests();
  TransactionRequestQueue.setDroppedRequestHandler(null);
  (answerDroppedRequests as jest.Mock).mockReset();
  jest.restoreAllMocks();
});

describe('a request the queue cannot take is answered, not dropped (TASK-394)', () => {
  it('the boot installs the dropped-request handler', async () => {
    const install = jest.spyOn(
      TransactionRequestQueue,
      'setDroppedRequestHandler'
    );
    await boot();
    expect(install).toHaveBeenCalledWith(answerDroppedRequests);
  });
});

describe('coordinator ingest (U2)', () => {
  it('DEFECT a handled replay is answered already handled without navigation', async () => {
    mockReady = true;
    await boot();
    const event = request(5201);
    await store.markHandled(requestRefFor(event), 'approved');
    await emit('session_request', event);
    expect(mockNav.navigate).not.toHaveBeenCalled();
    expect(mockTransport.rejectRequestV2).toHaveBeenCalledWith(
      event.topic,
      event.id,
      {
        code: -32000,
        message: 'Request already handled.',
      }
    );
  });

  it('DEFECT a request past its own expiryTimestamp is answered expired without navigation', async () => {
    mockReady = true;
    await boot();
    const event = request(5202);
    const expired = {
      ...event,
      params: {
        ...event.params,
        request: {
          ...event.params.request,
          expiryTimestamp: Math.floor(Date.now() / 1000) - 1,
        },
      },
    };
    await emit('session_request', expired);
    expect(mockNav.navigate).not.toHaveBeenCalled();
    expect(mockTransport.rejectRequestV2).toHaveBeenCalledWith(
      event.topic,
      event.id,
      {
        code: -32000,
        message: 'Request expired.',
      }
    );
  });

  it.each(['session_deleted', 'session_expired', 'session_disconnected'])(
    'DEFECT %s settles the open topic as session-ended without transport',
    async (eventName) => {
      mockReady = true;
      await boot();
      const event = request(
        eventName === 'session_deleted'
          ? 5205
          : eventName === 'session_expired'
            ? 5207
            : 5210
      );
      const ref = requestRefFor(event);
      await emit('session_request', event);
      expect(coordinator.isOpen(ref)).toBe(true);
      const listener = jest.fn();
      coordinator.subscribe(ref, listener);
      await emit(
        eventName,
        eventName === 'session_disconnected'
          ? event.topic
          : { topic: event.topic }
      );
      expect(coordinator.isOpen(ref)).toBe(false);
      expect(store.isHandled(ref)).toBe(true);
      expect(listener).toHaveBeenCalledWith({ reason: 'session-ended' });
      Object.values(mockTransport).forEach((fn) =>
        expect(fn).not.toHaveBeenCalled()
      );
    }
  );

  it('REGRESSION teardown removes all session end listeners', async () => {
    const cleanupRef: { current: (() => void) | undefined } = {
      current: undefined,
    };
    await initializeServices({
      navigationRef: { current: mockNav },
      initializeNetwork: async () => {},
      cleanupRef,
    });
    for (const event of [
      'session_deleted',
      'session_expired',
      'session_disconnected',
    ]) {
      expect(mockWcListeners[event]).toHaveLength(1);
    }
    cleanupRef.current?.();
    for (const event of [
      'session_deleted',
      'session_expired',
      'session_disconnected',
    ]) {
      expect(mockWcService.off).toHaveBeenCalledWith(
        event,
        mockWcListeners[event][0]
      );
    }
  });
});

it('DEFECT duplicate delivery retries failed publish once and stops after success', async () => {
  mockReady = true;
  await boot();
  const event = request(5311);
  await emit('session_request', event);
  mockTransport.rejectRequestV2.mockRejectedValueOnce(
    new Error('publish failed')
  );
  await coordinator.settle(requestRefFor(event), 'expired');
  await emit('session_request', event);
  await flush();
  expect(mockTransport.rejectRequestV2).toHaveBeenCalledTimes(2);
  await emit('session_request', event);
  await flush();
  expect(mockTransport.rejectRequestV2).toHaveBeenCalledTimes(2);
});

describe('setup incomplete is refused at the entry point (S2)', () => {
  const enterS2 = async (keyBearing = true) => {
    await markPinSetupPending();
    jest
      .mocked(MultiAccountWalletService.hasKeyBearingAccountStrict)
      .mockResolvedValue(keyBearing);
    jest.spyOn(AccountSecureStorage, 'hasPinStrict').mockResolvedValue(false);
  };
  const SETUP_INCOMPLETE = {
    code: -32001,
    message: 'Wallet setup incomplete.',
  };

  it('DEFECT a v2 request is answered setup-incomplete before any route or queue', async () => {
    await enterS2();
    mockReady = true;
    await boot();
    const event = request(5301);
    await emit('session_request', event);
    expect(mockNav.navigate).not.toHaveBeenCalled();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    expect(mockTransport.rejectRequestV2).toHaveBeenCalledTimes(1);
    expect(mockTransport.rejectRequestV2).toHaveBeenCalledWith(
      event.topic,
      event.id,
      SETUP_INCOMPLETE
    );
    expect(coordinator.isOpen(requestRefFor(event))).toBe(false);
    expect(queue.getSnapshot().head).toBeNull();
  });

  it('DEFECT a v2 proposal is answered setup-incomplete before any route', async () => {
    await enterS2();
    mockReady = true;
    await boot();
    const proposal = { id: 5302, pairingTopic: 'pairing' };
    await emit('session_proposal', proposal);
    expect(mockNav.navigate).not.toHaveBeenCalled();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
    expect(mockTransport.rejectProposalV2).toHaveBeenCalledTimes(1);
    expect(mockTransport.rejectProposalV2).toHaveBeenCalledWith(
      proposal.id,
      proposal.pairingTopic,
      SETUP_INCOMPLETE
    );
  });

  it('DEFECT a refusal waits for no navigation: it is answered while the container is not ready', async () => {
    await enterS2();
    await boot();
    await emit('session_request', request(5303));
    await emit('session_proposal', { id: 5304, pairingTopic: 'pairing' });
    expect(mockTransport.rejectRequestV2).toHaveBeenCalledTimes(1);
    expect(mockTransport.rejectProposalV2).toHaveBeenCalledTimes(1);
    becomeReady();
    await flush();
    expect(mockNav.navigate).not.toHaveBeenCalled();
    expect(mockNav.dispatch).not.toHaveBeenCalled();
  });

  it('DEFECT once setup completes the next arrival is shown as usual', async () => {
    await enterS2();
    mockReady = true;
    await boot();
    await emit('session_request', request(5305));
    expect(queue.getSnapshot().head).toBeNull();
    await clearPinSetupPending();
    await emit('session_request', request(5306));
    expect(queue.getSnapshot().head?.ref.id).toBe(5306);
    expect(mockNav.navigate).not.toHaveBeenCalled();
    expect(mockTransport.rejectRequestV2).toHaveBeenCalledTimes(1);
  });

  it('DEFECT a keyless wallet restored with no PIN (breadcrumb set) is not refused', async () => {
    await enterS2(false);
    mockReady = true;
    await boot();
    await emit('session_request', request(5308));
    expect(queue.getSnapshot().head?.ref.id).toBe(5308);
    expect(mockNav.navigate).not.toHaveBeenCalled();
    expect(mockTransport.rejectRequestV2).not.toHaveBeenCalled();
  });

  it('REGRESSION with no setup pending nothing is refused', async () => {
    mockReady = true;
    await boot();
    await emit('session_request', request(5307));
    expect(queue.getSnapshot().head?.ref.id).toBe(5307);
    expect(mockNav.navigate).not.toHaveBeenCalled();
    expect(mockTransport.rejectRequestV2).not.toHaveBeenCalled();
  });
});
