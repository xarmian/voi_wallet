/**
 * The v2 producers in the service boot feed the WalletConnect review queue
 * (TASK-518 U4b-2). A v2 session_request and a v2 session_proposal are
 * admitted by the coordinator and then pushed to RequestQueue through
 * feedQueue; nothing is navigated or dispatched, so the host (not a route)
 * draws the review. The coordinator, queue and handled store are the real
 * ones; only the transport, the WalletConnect service and the container are
 * fakes. Requests carry an opaque placeholder payload.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { initializeServices } from '../serviceBootstrap';
import { HandledStore } from '@/services/walletconnect/handledStore';
import {
  RequestCoordinator,
  CoordinatorTransport,
} from '@/services/walletconnect/requestCoordinator';
import {
  MAX_WAITING,
  RequestQueue,
} from '@/services/walletconnect/requestQueue';
import {
  requestRefFor,
  proposalRefFor,
} from '@/services/walletconnect/requestRefs';

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

type Listener = (event: any) => unknown;
const mockWcListeners: Record<string, Listener[]> = {};
const mockSessions: any[] = [];
const mockWcService = {
  initialize: jest.fn(async () => {}),
  on: jest.fn((event: string, listener: Listener) => {
    (mockWcListeners[event] ||= []).push(listener);
  }),
  off: jest.fn(),
  getActiveSessions: jest.fn(() => mockSessions),
};

const mockNav = {
  isReady: jest.fn(() => true),
  canGoBack: jest.fn(() => true),
  goBack: jest.fn(),
  navigate: jest.fn(),
  dispatch: jest.fn(),
  getCurrentRoute: jest.fn((): { name: string } | undefined => undefined),
};
const mockDeepLinkService = {
  setNavigationRef: jest.fn(),
  initialize: jest.fn(async () => {}),
  testDeepLink: jest.fn(async () => {}),
  cleanup: jest.fn(),
  deliverRoute: jest.fn(async (_key: string, run: () => void) => run()),
  deliverSigningRequest: jest.fn(async (run: () => void) => run()),
};

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
jest.mock('@/services/walletconnect/legacyQueueMigration', () => ({
  settleLegacyQueue: jest.fn(async () => {}),
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

let coordinator: RequestCoordinator;
let queue: RequestQueue;

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
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

const proposal = (id: number, pairingTopic = `pairing-${id}`) => ({
  id,
  pairingTopic,
  proposer: {
    metadata: {
      name: 'Example dApp',
      url: 'https://dapp.example/app',
      icons: ['https://dapp.example/icon.png'],
    },
  },
});

const boot = () =>
  initializeServices({
    navigationRef: { current: mockNav },
    initializeNetwork: jest.fn(async () => {}),
    cleanupRef: { current: undefined },
  });

const noRouteWasUsed = () => {
  expect(mockNav.navigate).not.toHaveBeenCalled();
  expect(mockNav.dispatch).not.toHaveBeenCalled();
  expect(mockDeepLinkService.deliverRoute).not.toHaveBeenCalled();
  expect(mockDeepLinkService.deliverSigningRequest).not.toHaveBeenCalled();
};

beforeEach(async () => {
  for (const key of Object.keys(mockWcListeners)) delete mockWcListeners[key];
  mockSessions.length = 0;
  mockNav.navigate.mockReset();
  mockNav.dispatch.mockReset();
  mockNav.goBack.mockReset();
  mockNav.isReady.mockReset().mockReturnValue(true);
  mockNav.canGoBack.mockReset().mockReturnValue(true);
  mockNav.getCurrentRoute.mockReset().mockReturnValue(undefined);
  mockDeepLinkService.deliverRoute.mockClear();
  mockDeepLinkService.deliverSigningRequest.mockClear();
  await AsyncStorage.clear();
  HandledStore.getInstance().__resetForTests();
  coordinator = new RequestCoordinator({
    store: new HandledStore(),
    transport: mockTransport,
  });
  jest.spyOn(RequestCoordinator, 'getInstance').mockReturnValue(coordinator);
  queue = new RequestQueue({ coordinator });
  jest.spyOn(RequestQueue, 'getInstance').mockReturnValue(queue);
  Object.values(mockTransport).forEach((fn) => fn.mockClear());
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  coordinator.__resetForTests();
  queue.__resetForTests();
  jest.restoreAllMocks();
});

describe('P2: a v2 session_request is fed to the review queue', () => {
  it('the host head appears for the admitted ref and no route is used', async () => {
    await boot();
    const event = request(1);

    await emit('session_request', event);

    const head = queue.getSnapshot().head;
    expect(head?.ref).toEqual(requestRefFor(event, 2));
    expect(head?.kind).toBe('request');
    expect(head?.payload).toBe(event);
    noRouteWasUsed();
  });

  it('a request behind a head waits in arrival order', async () => {
    await boot();

    await emit('session_request', request(1));
    await emit('session_request', request(2));
    await emit('session_request', request(3));

    const snap = queue.getSnapshot();
    expect(snap.head?.ref.id).toBe(1);
    expect(snap.waiting.map((w) => w.ref.id)).toEqual([2, 3]);
    noRouteWasUsed();
  });

  it('carries what the lock-screen summary reads: the dApp from the session, the chain, the first-seen time', async () => {
    await boot();
    mockSessions.push({
      topic: 'topic-a',
      peerMetadata: {
        name: 'Example dApp',
        url: 'https://dapp.example/app',
        icons: ['https://dapp.example/icon.png'],
        description: '',
      },
    });

    await emit('session_request', request(1, 'topic-a'));

    const head = queue.getSnapshot().head;
    expect(head?.dapp).toEqual({
      name: 'Example dApp',
      url: 'https://dapp.example/app',
      icon: 'https://dapp.example/icon.png',
    });
    expect(head?.network).toBe('algorand:opaque');
    expect(head?.firstSeenMs).toBe(
      coordinator.describe(requestRefFor(request(1, 'topic-a'), 2))?.firstSeenMs
    );
    expect(head?.firstSeenMs).toBeGreaterThan(0);
  });

  it('takes the dApp from the session the request arrived on, not another session', async () => {
    await boot();
    mockSessions.push(
      {
        topic: 'topic-other',
        peerMetadata: {
          name: 'Other dApp',
          url: 'https://other.example',
          icons: [],
          description: '',
        },
      },
      {
        topic: 'topic-a',
        peerMetadata: {
          name: 'Example dApp',
          url: 'https://dapp.example/app',
          icons: [],
          description: '',
        },
      }
    );

    await emit('session_request', request(1, 'topic-a'));

    expect(queue.getSnapshot().head?.dapp).toEqual({
      name: 'Example dApp',
      url: 'https://dapp.example/app',
    });
  });

  it('a request from a topic with no known session still queues, without a dApp', async () => {
    await boot();

    await emit('session_request', request(1, 'unknown-topic'));

    expect(queue.getSnapshot().head?.ref.id).toBe(1);
    expect(queue.getSnapshot().head?.dapp).toBeUndefined();
  });

  it('a session lookup that throws does not stop the request queueing', async () => {
    await boot();
    mockWcService.getActiveSessions.mockImplementationOnce(() => {
      throw new Error('lookup broke');
    });

    await emit('session_request', request(1));

    expect(queue.getSnapshot().head?.ref.id).toBe(1);
  });

  it('the same request emitted twice is queued once and answered never', async () => {
    await boot();
    const event = request(1);

    await emit('session_request', event);
    await emit('session_request', event);

    const snap = queue.getSnapshot();
    expect(snap.head?.ref.id).toBe(1);
    expect(snap.waiting).toHaveLength(0);
    expect(mockTransport.rejectRequestV2).not.toHaveBeenCalled();
    noRouteWasUsed();
  });

  it('a ref closed between admit and push is neither queued nor answered twice', async () => {
    await boot();
    const event = request(1);
    const realAdmit = coordinator.admit.bind(coordinator);
    jest.spyOn(coordinator, 'admit').mockImplementation(async (...args) => {
      const admission = await realAdmit(...args);
      await coordinator.settle(requestRefFor(event, 2), 'expired');
      return admission;
    });

    await emit('session_request', event);

    expect(queue.getSnapshot().head).toBeNull();
    expect(mockTransport.rejectRequestV2).toHaveBeenCalledTimes(1);
    noRouteWasUsed();
  });

  it('past the waiting limit the dApp is answered busy once and the queue is unchanged', async () => {
    await boot();
    for (let id = 1; id <= 1 + MAX_WAITING; id++) {
      await emit('session_request', request(id));
    }
    expect(queue.getSnapshot().waiting).toHaveLength(MAX_WAITING);
    expect(mockTransport.rejectRequestV2).not.toHaveBeenCalled();

    await emit('session_request', request(100));

    expect(queue.getSnapshot().waiting).toHaveLength(MAX_WAITING);
    expect(mockTransport.rejectRequestV2).toHaveBeenCalledTimes(1);
    expect(mockTransport.rejectRequestV2.mock.calls[0].slice(0, 2)).toEqual([
      'topic-a',
      100,
    ]);
    noRouteWasUsed();
  });

  it('a waiting request whose session ends is gone and answered nothing extra', async () => {
    await boot();
    await emit('session_request', request(1, 'topic-a'));
    await emit('session_request', request(2, 'topic-b'));
    expect(queue.getSnapshot().waiting.map((w) => w.ref.id)).toEqual([2]);

    await coordinator.settle(
      requestRefFor(request(2, 'topic-b'), 2),
      'session-ended'
    );

    expect(queue.getSnapshot().waiting).toHaveLength(0);
    expect(queue.getSnapshot().head?.ref.id).toBe(1);
  });
});

describe('P1: a v2 session_proposal is fed to the review queue', () => {
  it('the host head appears for the admitted ref and no route is used', async () => {
    await boot();
    const p = proposal(7);

    await emit('session_proposal', p);

    const head = queue.getSnapshot().head;
    expect(head?.ref).toEqual(proposalRefFor(p));
    expect(head?.kind).toBe('proposal');
    expect(head?.payload).toBe(p);
    noRouteWasUsed();
  });

  it('carries the dApp from the proposer metadata', async () => {
    await boot();

    await emit('session_proposal', proposal(7));

    expect(queue.getSnapshot().head?.dapp).toEqual({
      name: 'Example dApp',
      url: 'https://dapp.example/app',
      icon: 'https://dapp.example/icon.png',
    });
  });

  it('a proposal with no proposer metadata still queues', async () => {
    await boot();

    await emit('session_proposal', { id: 8, pairingTopic: 'pairing-8' });

    expect(queue.getSnapshot().head?.ref.id).toBe(8);
    expect(queue.getSnapshot().head?.dapp).toBeUndefined();
  });

  it('arriving over the QR scanner closes the scanner and nothing else', async () => {
    await boot();
    mockNav.getCurrentRoute.mockReturnValue({ name: 'QRScanner' });

    await emit('session_proposal', proposal(7));

    expect(mockNav.goBack).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().head?.ref.id).toBe(7);
    noRouteWasUsed();
  });

  it('arriving over any other screen closes nothing', async () => {
    await boot();
    mockNav.getCurrentRoute.mockReturnValue({ name: 'Settings' });

    await emit('session_proposal', proposal(7));

    expect(mockNav.goBack).not.toHaveBeenCalled();
    expect(queue.getSnapshot().head?.ref.id).toBe(7);
    noRouteWasUsed();
  });

  it('a proposal queues behind a request head', async () => {
    await boot();
    await emit('session_request', request(1));

    await emit('session_proposal', proposal(7));

    const snap = queue.getSnapshot();
    expect(snap.head?.kind).toBe('request');
    expect(snap.waiting.map((w) => w.ref.id)).toEqual([7]);
  });

  it('the same proposal emitted twice is queued once', async () => {
    await boot();
    const p = proposal(7);

    await emit('session_proposal', p);
    await emit('session_proposal', p);

    expect(queue.getSnapshot().head?.ref.id).toBe(7);
    expect(queue.getSnapshot().waiting).toHaveLength(0);
    expect(mockTransport.rejectProposalV2).not.toHaveBeenCalled();
  });

  it('past the waiting limit the proposal is answered busy once', async () => {
    await boot();
    for (let id = 1; id <= 1 + MAX_WAITING; id++) {
      await emit('session_request', request(id));
    }

    await emit('session_proposal', proposal(50));

    expect(queue.getSnapshot().waiting).toHaveLength(MAX_WAITING);
    expect(mockTransport.rejectProposalV2).toHaveBeenCalledTimes(1);
  });
});

describe('only an arrival the coordinator says to show is fed', () => {
  it('a request admitted as a duplicate of an open ref is not pushed', async () => {
    await boot();
    const event = request(1);
    const ref = requestRefFor(event, 2);
    // The ref is open in the coordinator (the first arrival's admission) but
    // has not been fed; this second arrival is told it is a duplicate.
    await coordinator.admit(ref);
    jest
      .spyOn(coordinator, 'admit')
      .mockResolvedValue({ action: 'suppressed', reason: 'duplicate' });

    await emit('session_request', event);

    expect(coordinator.isOpen(ref)).toBe(true);
    expect(queue.getSnapshot().head).toBeNull();
    noRouteWasUsed();
  });

  it('a proposal admitted as a duplicate of an open ref is not pushed', async () => {
    await boot();
    const p = proposal(7);
    const ref = proposalRefFor(p);
    await coordinator.admit(ref);
    jest
      .spyOn(coordinator, 'admit')
      .mockResolvedValue({ action: 'suppressed', reason: 'duplicate' });
    mockNav.getCurrentRoute.mockReturnValue({ name: 'QRScanner' });

    await emit('session_proposal', p);

    expect(coordinator.isOpen(ref)).toBe(true);
    expect(queue.getSnapshot().head).toBeNull();
    // Nothing was admitted for this arrival, so the scanner stays open.
    expect(mockNav.goBack).not.toHaveBeenCalled();
    noRouteWasUsed();
  });
});

describe('arrival conditions that used to decide delivery', () => {
  it('a request that arrives before the container is ready is queued, not held for navigation', async () => {
    await boot();
    mockNav.isReady.mockReturnValue(false);

    await emit('session_request', request(1));

    expect(queue.getSnapshot().head?.ref.id).toBe(1);
    noRouteWasUsed();
  });

  it('a proposal that arrives before the container is ready is queued and closes nothing', async () => {
    await boot();
    mockNav.isReady.mockReturnValue(false);
    mockNav.getCurrentRoute.mockReturnValue({ name: 'QRScanner' });

    await emit('session_proposal', proposal(7));

    expect(queue.getSnapshot().head?.ref.id).toBe(7);
    expect(mockNav.goBack).not.toHaveBeenCalled();
    noRouteWasUsed();
  });

  it('a second proposal over a focused proposal head queues behind it', async () => {
    await boot();
    mockNav.getCurrentRoute.mockReturnValue({
      name: 'WalletConnectSessionProposal',
    });

    await emit('session_proposal', proposal(7));
    await emit('session_proposal', proposal(8));

    expect(queue.getSnapshot().head?.ref.id).toBe(7);
    expect(queue.getSnapshot().waiting.map((w) => w.ref.id)).toEqual([8]);
    expect(mockNav.goBack).not.toHaveBeenCalled();
    noRouteWasUsed();
  });

  it('a request that arrives while the wallet is locked is queued and the wallet stays locked', async () => {
    const { AppLockSignal } = require('@/services/secure/appLockState');
    AppLockSignal.setUnlocked(false);
    await boot();

    await emit('session_request', request(437));

    expect(queue.getSnapshot().head?.ref.id).toBe(437);
    expect(AppLockSignal.isUnlocked()).toBe(false);
    noRouteWasUsed();
  });
});
