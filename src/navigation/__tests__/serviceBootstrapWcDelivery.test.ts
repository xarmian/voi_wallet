/**
 * WalletConnect delivery from the service boot (TASK-382, TASK-257).
 *
 * TASK-382: the session_proposal / session_request handlers used to return
 * silently when the navigation container was not ready, so a WalletConnect
 * event that woke the app was lost. They now go through DeepLinkService's
 * cold-start route queue (DR-10). The queue here is the REAL pendingRoute
 * queue, wired to the fake container's readiness exactly as DeepLinkService
 * wires it.
 *
 * TASK-257: a repeat emit of the same (topic, id) must not surface a second
 * signing group: not by navigating twice, not by enqueueing a copy of the
 * request already on screen, not by the startup drain or the screen's "next
 * request" step showing a persisted copy of a request already displayed. And
 * nothing may be dropped unanswered: a request queued in this session
 * survives the startup drain, and a failed delivery releases its claim. The
 * queue is the REAL TransactionRequestQueue over the AsyncStorage jest mock.
 *
 * No key, mnemonic or signature material is involved: requests carry an
 * opaque placeholder payload the handlers never inspect.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { initializeServices } from '../serviceBootstrap';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';

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
  MultiAccountWalletService: { getCurrentWallet: jest.fn(async () => null) },
}));
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {
    initializeIfPersistedDevices: jest.fn(async () => false),
  },
}));
jest.mock('@/platform/detection', () => ({
  detectPlatform: jest.fn(() => 'mobile'),
}));

const { createPendingRouteQueue } = jest.requireActual(
  '@/services/deeplink/pendingRoute'
);

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
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
  mockNav.getCurrentRoute.mockImplementation(() =>
    mockRoute ? { name: mockRoute } : undefined
  );
  await AsyncStorage.clear();
  mockRouteQueue = createPendingRouteQueue({
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
  jest.restoreAllMocks();
});

describe('WalletConnect events before navigation is ready (TASK-382)', () => {
  it('a session proposal that arrives early is shown once navigation is ready', async () => {
    await boot();
    const proposal = { id: 101 };

    await emit('session_proposal', proposal);
    expect(mockNav.navigate).not.toHaveBeenCalled();

    becomeReady();
    await flush();

    expect(mockNav.navigate).toHaveBeenCalledTimes(1);
    expect(mockNav.navigate).toHaveBeenCalledWith(
      'WalletConnectSessionProposal',
      { proposal }
    );
  });

  it('a signing request that arrives early is shown once navigation is ready', async () => {
    await boot();
    const requestEvent = request(201);

    await emit('session_request', requestEvent);
    expect(mockNav.navigate).not.toHaveBeenCalled();

    becomeReady();
    await flush();

    expect(mockNav.navigate).toHaveBeenCalledTimes(1);
    expect(mockNav.navigate).toHaveBeenCalledWith(
      'WalletConnectTransactionRequest',
      { requestEvent }
    );
  });
});

const QUEUE_STORAGE_KEY = '@walletconnect_transaction_queue';

/** A request persisted by a PREVIOUS app session (not claimed in this one). */
const persistFromPriorSession = async (...ids: number[]) => {
  await AsyncStorage.setItem(
    QUEUE_STORAGE_KEY,
    JSON.stringify(ids.map((id) => ({ ...request(id), timestamp: Date.now() })))
  );
};

/** Run `fn` during boot, after WalletConnect init and before the drain. */
const duringBoot = (fn: () => Promise<void>) => {
  jest
    .spyOn(TransactionRequestQueue, 'setProcessing')
    .mockImplementationOnce(async () => {
      await fn();
    });
};

/** navigate() moves the fake container onto the target route. */
const navigateMovesRoute = () => {
  mockNav.navigate.mockImplementation((name: string) => {
    mockRoute = name;
  });
};

/**
 * The signing screen's "next request" step after the user answers
 * (TransactionRequestScreen: takeNext with navigation.replace). Returns the
 * id it replaced to, or null.
 */
const screenShowsNext = async (): Promise<number | string | null> => {
  let shown: number | string | null = null;
  await TransactionRequestQueue.takeNext((req) => {
    shown = req.id;
  });
  return shown;
};

const queuedIds = async () =>
  (await TransactionRequestQueue.getAll()).map((r) => r.id);

const navigatedIds = () =>
  mockNav.navigate.mock.calls
    .filter(([name]) => name === 'WalletConnectTransactionRequest')
    .map(([, params]) => params.requestEvent.id);

describe('duplicate signing requests (TASK-257)', () => {
  it('the same (topic, id) emitted twice navigates once', async () => {
    mockReady = true;
    await boot();
    const requestEvent = request(301);

    await emit('session_request', requestEvent);
    await emit('session_request', { ...requestEvent });

    expect(mockNav.navigate).toHaveBeenCalledTimes(1);
  });

  it('a repeat of the request already on screen is not enqueued; a new one is', async () => {
    mockReady = true;
    await boot();
    const enqueue = jest.spyOn(TransactionRequestQueue, 'enqueue');

    await emit('session_request', request(401));
    expect(mockNav.navigate).toHaveBeenCalledTimes(1);

    // The user is now looking at request 401.
    mockRoute = 'WalletConnectTransactionRequest';

    await emit('session_request', request(401));
    expect(enqueue).not.toHaveBeenCalled();

    await emit('session_request', request(402));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await queuedIds()).toEqual([402]);
    expect(mockNav.navigate).toHaveBeenCalledTimes(1);
  });

  it('the same id on a different topic is a different request', async () => {
    mockReady = true;
    await boot();

    await emit('session_request', request(501, 'topic-x'));
    await emit('session_request', request(501, 'topic-y'));

    expect(mockNav.navigate).toHaveBeenCalledTimes(2);
  });

  describe('(a) a request queued in this session survives the startup drain', () => {
    it('while the transaction screen is showing, the drain leaves it for the screen', async () => {
      mockReady = true;
      navigateMovesRoute();
      await persistFromPriorSession(800); // so the drain has work to do
      duringBoot(async () => {
        await emit('session_request', request(801)); // shown
        await emit('session_request', request(802)); // queued behind it
      });

      await boot();
      await flush();

      // Nothing was discarded and nothing new was shown by the drain...
      expect(navigatedIds()).toEqual([801]);
      expect(await queuedIds()).toEqual([800, 802]);
      // ...and the screen's "next request" step hands each one over in turn.
      expect(await screenShowsNext()).toBe(800);
      expect(await screenShowsNext()).toBe(802);
    });

    it('once the screen has moved on, the drain shows it', async () => {
      mockReady = true;
      navigateMovesRoute();
      duringBoot(async () => {
        await emit('session_request', request(811)); // shown
        await emit('session_request', request(812)); // queued behind it
        // The request screen has replaced itself with the signing screen.
        mockRoute = 'UniversalTransactionSigning';
      });

      await boot();
      await flush();

      expect(navigatedIds()).toEqual([811, 812]);
      expect(await queuedIds()).toEqual([]);
    });
  });

  describe('(b) a persisted request the relay redelivers is shown once', () => {
    it('across onRequest and the screen taking the next request', async () => {
      mockReady = true;
      navigateMovesRoute();
      await persistFromPriorSession(901);
      duringBoot(async () => {
        await emit('session_request', request(901)); // relay redelivery
      });

      await boot();
      await flush();
      expect(navigatedIds()).toEqual([901]);

      // The user answers 901; the screen asks for the next request.
      expect(await screenShowsNext()).toBeNull();
      expect(await queuedIds()).toEqual([]);
      expect(navigatedIds()).toEqual([901]);
    });

    it('across onRequest and the startup drain', async () => {
      mockReady = true;
      navigateMovesRoute();
      await persistFromPriorSession(911, 912);
      duringBoot(async () => {
        await emit('session_request', request(911)); // relay redelivery
        mockRoute = 'UniversalTransactionSigning';
      });

      await boot();
      await flush();

      // The drain skipped the copy of 911 and showed 912, which was not.
      expect(navigatedIds()).toEqual([911, 912]);
      expect(await queuedIds()).toEqual([]);
    });
  });

  describe('(c) a failed delivery releases the claim; a redelivery shows', () => {
    it('enqueue throws', async () => {
      mockReady = true;
      await boot();
      mockRoute = 'WalletConnectTransactionRequest';
      jest
        .spyOn(TransactionRequestQueue, 'enqueue')
        .mockRejectedValueOnce(new Error('queue full'));

      await emit('session_request', request(701));
      expect(await queuedIds()).toEqual([]);

      await emit('session_request', request(701)); // relay redelivery
      expect(await queuedIds()).toEqual([701]);
    });

    it('navigate throws', async () => {
      mockReady = true;
      await boot();
      mockNav.navigate.mockImplementationOnce(() => {
        throw new Error('navigator gone');
      });

      await emit('session_request', request(711));
      await emit('session_request', request(711)); // relay redelivery

      expect(navigatedIds()).toEqual([711, 711]);
      // Only the second attempt was shown: a third emit is a duplicate.
      await emit('session_request', request(711));
      expect(navigatedIds()).toEqual([711, 711]);
    });

    it('the route queue itself rejects', async () => {
      mockReady = true;
      await boot();
      jest
        .spyOn(mockDeepLinkService, 'deliverSigningRequest')
        .mockRejectedValueOnce(new Error('route queue failed'));

      await emit('session_request', request(731));
      expect(navigatedIds()).toEqual([]);

      await emit('session_request', request(731)); // relay redelivery
      expect(navigatedIds()).toEqual([731]);
    });

    it('navigation turns out not usable when the route runs', async () => {
      await boot();
      // The route queue saw "ready" but the container no longer is when
      // the handler checks.
      mockNav.isReady.mockReturnValueOnce(false);
      mockReady = true;

      await emit('session_request', request(721));
      expect(navigatedIds()).toEqual([]);

      await emit('session_request', request(721)); // relay redelivery
      expect(navigatedIds()).toEqual([721]);
    });
  });
});
