/**
 * TASK-469: a wipe removes WalletConnect state from this device through the
 * SDK's own stores, without waiting on the network, and the request bookkeeping
 * forgets the previous wallet's requests.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const fakeStore = (keys: (string | number)[]) => {
  const map = new Map(keys.map((key) => [key, {}]));
  return {
    map,
    get keys() {
      return [...map.keys()];
    },
    delete: jest.fn(async (key: string | number) => {
      map.delete(key);
    }),
    getAll: () => [],
  };
};
const mockSession = fakeStore(['s1', 's2']);
const mockProposal = fakeStore([1]);
const mockPendingRequest = fakeStore([7]);
const mockPairings = fakeStore(['p1']);
const mockKeychain = new Map([
  ['s1', 'k1'],
  ['p1', 'k2'],
]);
// The expirer's map is keyed by formatted target (`topic:<topic>`, `id:<id>`),
// and `set`, `has` and `del` format their argument again, as the SDK does
// (2.26.0 core controllers/expirer.ts; sdkSubscriberShape.test.ts checks it).
const mockFormatTarget = (key: string | number): string => {
  const utils = jest.requireActual('@walletconnect/utils');
  if (typeof key === 'string') return utils.formatTopicTarget(key);
  if (typeof key === 'number') return utils.formatIdTarget(key);
  throw new Error(`Target type: ${typeof key}`);
};
const mockExpirer = new Map<string, { target: string; expiry: number }>();
const mockSetExpiry = (key: string | number, expiry: number) => {
  const target = mockFormatTarget(key);
  mockExpirer.set(target, { target, expiry });
};
mockSetExpiry('s1', 1);
mockSetExpiry(7, 2);
const mockHistory = new Map([[7, { id: 7, topic: 's1' }]]);
const mockMessages = new Map([['s1', {}]]);
const mockSubscriptions = new Map([['sub1', { topic: 's1' }]]);
const mockTopicMapClear = jest.fn();
const mockPendingSubscriptions = new Map([['s1', { topic: 's1' }]]);
const mockTransportClose = jest.fn(() => new Promise<void>(() => {}));
// The sign-client engine's private request pipeline (2.26.0 engine.ts):
// `sessionRequestQueue` emits the next `session_request` only while idle, and
// `emittedSessionRequests` (a LimitedSet over a private `set`) skips ids
// already emitted. `processSessionRequestQueue` below mirrors the SDK's gate;
// sdkSubscriberShape.test.ts checks that gate in the installed source.
const mockEngine = {
  sessionRequestQueue: {
    state: 'IDLE' as 'IDLE' | 'ACTIVE',
    queue: [] as { id: number; topic: string }[],
  },
  emittedSessionRequests: { set: new Set<number>() },
  emitted: [] as number[],
  processSessionRequestQueue() {
    const q = mockEngine.sessionRequestQueue;
    if (q.state === 'ACTIVE') return;
    const request = q.queue[0];
    if (!request || mockEngine.emittedSessionRequests.set.has(request.id))
      return;
    q.state = 'ACTIVE';
    mockEngine.emittedSessionRequests.set.add(request.id);
    mockEngine.emitted.push(request.id);
  },
};
const mockAuthRequests = fakeStore([11]);
const mockAuthPairingTopics = fakeStore(['ap1']);
const mockAuthKeys = fakeStore(['PUBLIC_KEY']);
let mockInitialized = true;
const mockClientInitialize = jest.fn(async () => {});
const mockCore = {
  pairing: { pairings: mockPairings },
  crypto: {
    keychain: {
      keychain: mockKeychain,
      del: jest.fn(async (tag: string) => {
        mockKeychain.delete(tag);
      }),
    },
  },
  expirer: {
    get keys() {
      return [...mockExpirer.keys()];
    },
    has: (key: string | number) => mockExpirer.has(mockFormatTarget(key)),
    set: mockSetExpiry,
    del: jest.fn((key: string | number) => {
      if (!mockCore.expirer.has(key)) return;
      mockExpirer.delete(mockFormatTarget(key));
    }),
  },
  history: {
    get values() {
      return [...mockHistory.values()];
    },
    delete: jest.fn((topic: string) => {
      for (const [id, record] of mockHistory)
        if (record.topic === topic) mockHistory.delete(id);
    }),
  },
  relayer: {
    transportClose: mockTransportClose,
    messages: {
      messages: mockMessages,
      del: jest.fn(async (topic: string) => {
        mockMessages.delete(topic);
      }),
    },
    subscriber: {
      subscriptions: mockSubscriptions,
      topicMap: { clear: mockTopicMapClear },
      pending: mockPendingSubscriptions,
      // Private in the SDK: the topics it re-subscribes after a reconnect.
      cached: [{ topic: 's1' }, { topic: 'p1' }] as { topic: string }[],
    },
  },
};
jest.mock('../client', () => ({
  WalletConnectClient: {
    getInstance: () => ({
      isInitialized: () => mockInitialized,
      initialize: () => mockClientInitialize(),
      getProvider: () => ({
        client: {
          session: mockSession,
          proposal: mockProposal,
          pendingRequest: mockPendingRequest,
          engine: mockEngine,
          auth: {
            requests: mockAuthRequests,
            pairingTopics: mockAuthPairingTopics,
            authKeys: mockAuthKeys,
          },
          on: jest.fn(),
        },
      }),
      getCore: () => mockCore,
    }),
  },
}));
jest.mock('../messagesRetention', () => ({
  sweepWalletConnectMessageStore: jest.fn(async () => {}),
}));
jest.mock('@walletconnect/utils', () => ({
  getSdkError: (key: string) => ({ code: 6000, message: key }),
  parseExpirerTarget: jest.requireActual('@walletconnect/utils')
    .parseExpirerTarget,
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: { getAllAccounts: jest.fn(async () => []) },
}));
const mockV1Reset = jest.fn();
jest.mock('@/services/walletconnect/v1', () => ({
  WalletConnectV1Client: {
    getInstance: () => ({
      getSessionData: () => null,
      resetForWipe: mockV1Reset,
    }),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';
import { WalletConnectService } from '../index';
import { HandledStore } from '../handledStore';

const settle = async () => {
  const run = runWipeResets();
  await Promise.all(run.pending.map((p) => p.done));
  return run;
};

test('sessions, proposals, requests, pairings, keys, expiries, history and messages are emptied; the relay close is not awaited', async () => {
  WalletConnectService.getInstance();
  const run = await settle();
  expect(run.pending.map((p) => p.name)).toContain('walletconnect');
  expect(run.failed).toEqual([]);
  expect(mockSession.keys).toEqual([]);
  expect(mockProposal.keys).toEqual([]);
  expect(mockPendingRequest.keys).toEqual([]);
  expect(mockPairings.keys).toEqual([]);
  expect(mockKeychain.size).toBe(0);
  expect(mockExpirer.size).toBe(0);
  expect(mockHistory.size).toBe(0);
  expect(mockMessages.size).toBe(0);
  expect(mockSubscriptions.size).toBe(0);
  expect(mockTopicMapClear).toHaveBeenCalled();
  expect(mockTransportClose).toHaveBeenCalledTimes(1);
  expect(mockV1Reset).toHaveBeenCalled();
  expect(WalletConnectService.getInstance().getActiveSessions()).toEqual([]);
});

test('the expirer drops its topic and id targets through the key its del takes', async () => {
  WalletConnectService.getInstance();
  mockSetExpiry('s2', 3);
  mockSetExpiry(9, 4);
  mockSetExpiry(10, 5);
  expect([...mockExpirer.keys()]).toEqual(['topic:s2', 'id:9', 'id:10']);
  mockCore.expirer.del.mockClear();
  const run = await settle();
  expect(run.failed).toEqual([]);
  expect(mockExpirer.size).toBe(0);
  expect(mockCore.expirer.del.mock.calls).toEqual([['s2'], [9], [10]]);
});

test('an expirer target in neither form fails the purge instead of staying behind', async () => {
  WalletConnectService.getInstance();
  mockExpirer.set('other:x', { target: 'other:x', expiry: 1 });
  mockSetExpiry(12, 2);
  try {
    const run = runWipeResets();
    const purge = run.pending.find((p) => p.name === 'walletconnect');
    await Promise.allSettled(run.pending.map((p) => p.done));
    await expect(purge!.done).rejects.toThrow('expirer');
    // The entries it can read are still removed.
    expect([...mockExpirer.keys()]).toEqual(['other:x']);
  } finally {
    mockExpirer.clear();
  }
});

test('the relay subscriber forgets its pending and cached topics, so a later reconnect does not subscribe them again', async () => {
  WalletConnectService.getInstance();
  mockPendingSubscriptions.set('s2', { topic: 's2' });
  mockCore.relayer.subscriber.cached = [{ topic: 's2' }];
  await settle();
  expect(mockPendingSubscriptions.size).toBe(0);
  expect(mockCore.relayer.subscriber.cached).toEqual([]);
});

test('the engine request pipeline goes back to idle and empty, so the next request is shown', async () => {
  WalletConnectService.getInstance();
  // A request from the previous wallet is on screen: the engine is waiting
  // for its answer, and a second one waits behind it.
  mockEngine.sessionRequestQueue.queue = [
    { id: 7, topic: 's1' },
    { id: 9, topic: 's1' },
  ];
  mockEngine.processSessionRequestQueue();
  expect(mockEngine.sessionRequestQueue.state).toBe('ACTIVE');
  expect(mockEngine.emitted).toEqual([7]);

  await settle();
  expect(mockEngine.sessionRequestQueue.state).toBe('IDLE');
  expect(mockEngine.sessionRequestQueue.queue).toEqual([]);
  expect(mockEngine.emittedSessionRequests.set.size).toBe(0);

  // The new wallet's first request is emitted, not held behind the old one.
  mockEngine.sessionRequestQueue.queue.push({ id: 21, topic: 'new' });
  mockEngine.processSessionRequestQueue();
  expect(mockEngine.emitted).toEqual([7, 21]);
});

test('the session-authenticate stores are emptied through their store API', async () => {
  WalletConnectService.getInstance();
  // Earlier purges in this file emptied the shared stores: fill them again.
  mockAuthRequests.map.set(12, {});
  mockAuthPairingTopics.map.set('ap2', {});
  mockAuthKeys.map.set('PUBLIC_KEY', {});
  mockAuthKeys.delete.mockClear();
  await settle();
  expect(mockAuthRequests.keys).toEqual([]);
  expect(mockAuthPairingTopics.keys).toEqual([]);
  expect(mockAuthKeys.keys).toEqual([]);
  expect(mockAuthKeys.delete).toHaveBeenCalledWith(
    'PUBLIC_KEY',
    expect.anything()
  );
});

describe('an initialize() and a wipe at the same time', () => {
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const service = () => WalletConnectService.getInstance();
  const notStarted = () => {
    (service() as unknown as { initialized: boolean }).initialized = false;
  };
  afterEach(() => {
    closeWipeWindow();
    mockInitialized = true;
    mockClientInitialize.mockReset();
    mockClientInitialize.mockImplementation(async () => {});
  });

  test('a purge during an initialize under way waits for it, then removes the sessions it restored', async () => {
    notStarted();
    mockInitialized = false;
    let finishStart: () => void = () => {};
    mockClientInitialize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStart = resolve;
        })
    );
    const starting = service().initialize();
    await flush();
    expect(mockClientInitialize).toHaveBeenCalledTimes(1);

    const run = runWipeResets();
    const purge = run.pending.find((p) => p.name === 'walletconnect');
    expect(purge).toBeDefined();
    let purged = false;
    void purge!.done.then(() => {
      purged = true;
    });
    // The SDK restores the stored session into memory as its start finishes.
    mockSession.map.set('restored', {});
    mockKeychain.set('restored', 'k3');
    mockInitialized = true;
    await flush();
    expect(purged).toBe(false);

    finishStart();
    await starting;
    await purge!.done;
    expect(mockSession.keys).toEqual([]);
    expect(mockKeychain.size).toBe(0);
    expect(service().getActiveSessions()).toEqual([]);
  });

  test('a purge that waits on an initialize that never finishes rejects (the wipe reports it)', async () => {
    jest.useFakeTimers();
    try {
      notStarted();
      mockClientInitialize.mockImplementationOnce(
        () => new Promise<void>(() => {})
      );
      void service().initialize();
      await flush();
      const purge = runWipeResets().pending.find(
        (p) => p.name === 'walletconnect'
      );
      const outcome = purge!.done.then(
        () => 'resolved',
        () => 'rejected'
      );
      await jest.advanceTimersByTimeAsync(6000);
      expect(await outcome).toBe('rejected');
    } finally {
      jest.useRealTimers();
      (service() as unknown as { initializing: unknown }).initializing = null;
    }
  });

  test('an initialize that starts during a wipe does not restore anything until the wipe settles', async () => {
    notStarted();
    openWipeWindow();
    const starting = service().initialize();
    await flush();
    expect(mockClientInitialize).not.toHaveBeenCalled();
    closeWipeWindow();
    await starting;
    expect(mockClientInitialize).toHaveBeenCalledTimes(1);
  });
});

describe('handled-request ledger', () => {
  beforeEach(() => AsyncStorage.clear());

  test('a reset forgets every entry, and a load in flight does not bring them back', async () => {
    const ref = { version: 2, kind: 'request', topic: 't', id: 1 } as const;
    const first = new HandledStore();
    await first.markHandled(ref, 'approved');
    expect(first.isHandled(ref)).toBe(true);
    first.resetForWipe();
    expect(first.isHandled(ref)).toBe(false);

    // A fresh instance whose load of the stored entry is still in flight.
    const second = new HandledStore();
    const loading = second.load();
    second.resetForWipe();
    await loading;
    expect(second.isHandled(ref)).toBe(false);
  });

  test('a mark started before the reset does not write after it, and reports nothing recorded', async () => {
    const store = new HandledStore();
    await store.load();
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    const marking = store.markHandled(
      { version: 2, kind: 'request', topic: 't', id: 1 },
      'approved'
    );
    store.resetForWipe();
    // Not recorded: the caller must not answer the dApp for a wiped wallet.
    await expect(marking).resolves.toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
