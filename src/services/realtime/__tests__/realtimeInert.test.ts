// TASK-190 / F-26: Supabase realtime is intended to be OFF, but it was only
// "off" by convention — nothing calls subscribeToAddresses, yet the singleton
// was constructed at module import time and its constructor registered a
// permanent AppState listener. walletStore.addAddress() (account create /
// import / watch / rekey / remote-signer add) then populated the address set,
// and the next background→foreground transition opened a real, unfiltered
// WebSocket with no handlers attached.
//
// These specs pin the two halves of the fix:
//   1. INERTNESS — importing the module, and adding addresses to it, opens
//      nothing. Asserted against a fake Supabase client, not eyeballed.
//   2. CHANNEL LIFECYCLE — for when realtime is re-enabled: concurrent installs
//      leave exactly one live channel, a channel is always removed through the
//      client that CREATED it (setDeviceId replaces the client), and emptying
//      the address set tears the channel down.
//
// Supabase is faked rather than mocked ad hoc so each client carries its own
// channel registry — "no orphan" is then a real assertion about what is still
// live on a client, which is exactly what leaked in production.

type StatusCallback = (status: string, err?: Error) => void;
type EventCallback = (payload: { new: Record<string, unknown> }) => void;

interface FakeChannel {
  topic: string;
  on: jest.Mock;
  subscribe: jest.Mock;
  /** Drive the realtime status callback the service registered. */
  emit: (status: string, err?: Error) => void;
  /** Deliver a postgres_changes INSERT to the handler the service registered. */
  emitEvent: (row: Record<string, unknown>) => void;
}

interface FakeClient {
  id: string;
  /** Channels currently in this client's registry. */
  live: FakeChannel[];
  /** Every channel this client ever created, in order. */
  created: FakeChannel[];
  /** Channels handed to removeChannel(). */
  removed: FakeChannel[];
  channel: jest.Mock;
  removeChannel: jest.Mock;
}

let mockClientSeq = 0;

const mockCreateClient = (): FakeClient => {
  mockClientSeq += 1;
  const client: FakeClient = {
    id: `client-${mockClientSeq}`,
    live: [],
    created: [],
    removed: [],
    channel: jest.fn(),
    removeChannel: jest.fn(),
  };

  client.channel.mockImplementation((topic: string) => {
    let statusCallback: StatusCallback | null = null;
    let eventCallback: EventCallback | null = null;
    const channel: FakeChannel = {
      topic,
      on: jest.fn((_event: string, _filter: unknown, cb: EventCallback) => {
        eventCallback = cb;
        return channel;
      }),
      subscribe: jest.fn((cb: StatusCallback) => {
        statusCallback = cb;
        return channel;
      }),
      emit: (status, err) => statusCallback?.(status, err),
      emitEvent: (row) => eventCallback?.({ new: row }),
    };
    client.created.push(channel);
    client.live.push(channel);
    return channel;
  });

  client.removeChannel.mockImplementation(async (channel: FakeChannel) => {
    client.removed.push(channel);
    const index = client.live.indexOf(channel);
    if (index >= 0) client.live.splice(index, 1);
    return 'ok';
  });

  return client;
};

let mockCurrentClient: FakeClient | null = null;

jest.mock('../../supabase', () => ({
  getSupabaseClient: () => mockCurrentClient,
  isSupabaseConfigured: () => mockCurrentClient !== null,
  // Mirrors services/supabase/index.ts setDeviceId(): it RECREATES the client
  // to change the x-device-id header, so any channel created before the call
  // stays bound to the previous instance.
  setDeviceId: () => {
    mockCurrentClient = mockCreateClient();
  },
}));

type AppStateHandler = (status: string) => unknown;

const mockAppStateHandlers: AppStateHandler[] = [];

const mockAddEventListener = jest.fn(
  (_event: string, handler: AppStateHandler) => {
    mockAppStateHandlers.push(handler);
    return {
      remove: () => {
        const index = mockAppStateHandlers.indexOf(handler);
        if (index >= 0) mockAppStateHandlers.splice(index, 1);
      },
    };
  }
);

// The module under test only reaches for AppState; replacing react-native
// wholesale keeps the fake listener registry authoritative.
jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (event: string, handler: AppStateHandler) =>
      mockAddEventListener(event, handler),
  },
}));

type RealtimeModule = typeof import('../index');
type RealtimeInstance = ReturnType<RealtimeModule['getRealtimeService']>;

/** Reaches the private members the lifecycle assertions need. */
interface RealtimeInternals {
  resubscribe(): Promise<boolean>;
  installed: { channel: FakeChannel } | null;
}

const internals = (service: RealtimeInstance): RealtimeInternals =>
  service as unknown as RealtimeInternals;

/** Load the module in a fresh registry so each spec gets a fresh singleton. */
const loadModule = (): RealtimeModule => {
  let mod!: RealtimeModule;
  jest.isolateModules(() => {
    mod = require('../index');
  });
  return mod;
};

/** Let queued microtasks and zero-delay work settle (real timers only). */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Deliver an AppState transition to every listener the service registered. */
const fireAppState = async (status: string): Promise<void> => {
  for (const handler of [...mockAppStateHandlers]) {
    await handler(status);
  }
  await flush();
};

const ADDRESS_A = 'A'.repeat(58);
const ADDRESS_B = 'B'.repeat(58);

/** The service's currently installed channel, if any. */
const installedChannel = (service: RealtimeInstance): FakeChannel | null =>
  internals(service).installed?.channel ?? null;

describe('realtime service — inertness while realtime is off', () => {
  beforeEach(() => {
    mockAppStateHandlers.length = 0;
    mockCurrentClient = mockCreateClient();
  });

  it('registers no AppState listener at module import time', () => {
    loadModule();

    expect(mockAddEventListener).not.toHaveBeenCalled();
  });

  it('opens zero realtime connections after an account is added and the app is backgrounded/foregrounded', async () => {
    const client = mockCurrentClient!;
    const { realtimeService } = loadModule();

    // Exactly what walletStore does on account create/import/watch/rekey/
    // remote-signer add.
    realtimeService.addAddress(ADDRESS_A);
    realtimeService.addAddress(ADDRESS_B);

    expect(mockAddEventListener).not.toHaveBeenCalled();

    // Background → foreground. Nothing is listening, and even if something
    // were, no connection may be opened.
    await fireAppState('background');
    await fireAppState('active');

    expect(client.channel).not.toHaveBeenCalled();
    expect(client.created).toHaveLength(0);
    expect(client.live).toHaveLength(0);
    expect(realtimeService.isRealtimeConnected()).toBe(false);
  });

  it('arms the AppState listener only on a genuine subscribe, and drops it on unsubscribe', async () => {
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();

    service.addAddress(ADDRESS_A);
    expect(mockAddEventListener).not.toHaveBeenCalled();

    await service.subscribeToAddresses([ADDRESS_A]);
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockAppStateHandlers).toHaveLength(1);

    await service.unsubscribe();
    expect(mockAppStateHandlers).toHaveLength(0);

    // And a foreground after the stop reopens nothing.
    const client = mockCurrentClient!;
    const createdBefore = client.created.length;
    await fireAppState('active');
    expect(client.created).toHaveLength(createdBefore);
  });
});

describe('realtime service — channel lifecycle', () => {
  beforeEach(() => {
    mockAppStateHandlers.length = 0;
    mockCurrentClient = mockCreateClient();
  });

  it('leaves exactly one channel and no orphan when three resubscribes race', async () => {
    const client = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();
    service.addAddress(ADDRESS_A);

    await Promise.all([
      internals(service).resubscribe(),
      internals(service).resubscribe(),
      internals(service).resubscribe(),
    ]);

    expect(client.live).toHaveLength(1);
    // The one live channel is the one the service holds — no channel is live
    // in the registry that the service has forgotten about.
    expect(client.live[0]).toBe(installedChannel(service));
    // Anything else that got created was explicitly removed.
    expect(client.created.length - client.removed.length).toBe(1);
  });

  it('leaves exactly one channel when an explicit subscribe races a resubscribe', async () => {
    const client = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();

    await Promise.all([
      service.subscribeToAddresses([ADDRESS_A]),
      internals(service).resubscribe(),
    ]);

    expect(client.live).toHaveLength(1);
    expect(client.live[0]).toBe(installedChannel(service));
    expect(client.created.length - client.removed.length).toBe(1);
  });

  it('leaves exactly one channel when a resubscribe races an explicit subscribe (reverse order)', async () => {
    const client = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();
    service.addAddress(ADDRESS_A);

    await Promise.all([
      internals(service).resubscribe(),
      service.subscribeToAddresses([ADDRESS_B]),
    ]);

    expect(client.live).toHaveLength(1);
    expect(client.live[0]).toBe(installedChannel(service));
    expect(client.created.length - client.removed.length).toBe(1);
  });

  it('removes the channel from the client that created it after setDeviceId swaps the client', async () => {
    const clientA = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const { setDeviceId } = require('../../supabase');
    const service = getRealtimeService();

    await service.subscribeToAddresses([ADDRESS_A]);
    expect(clientA.live).toHaveLength(1);

    // setDeviceId replaces the Supabase singleton; the live channel is still
    // bound to clientA.
    setDeviceId('device-2');
    const clientB = mockCurrentClient!;
    expect(clientB).not.toBe(clientA);
    expect(clientB.live).toHaveLength(0);

    await service.unsubscribe();

    // No channel remains on EITHER client.
    expect(clientA.live).toHaveLength(0);
    expect(clientB.live).toHaveLength(0);
    expect(clientA.removeChannel).toHaveBeenCalledTimes(1);
    expect(clientB.removeChannel).not.toHaveBeenCalled();
    expect(installedChannel(service)).toBeNull();
  });

  it('tears the channel down through the old client when a reinstall lands after setDeviceId', async () => {
    const clientA = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const { setDeviceId } = require('../../supabase');
    const service = getRealtimeService();

    await service.subscribeToAddresses([ADDRESS_A]);
    setDeviceId('device-2');
    const clientB = mockCurrentClient!;

    await internals(service).resubscribe();

    expect(clientA.live).toHaveLength(0);
    expect(clientB.live).toHaveLength(1);
    expect(clientB.live[0]).toBe(installedChannel(service));
  });

  it('tears the channel down when the subscribed-address set becomes empty', async () => {
    const client = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();

    await service.subscribeToAddresses([ADDRESS_A, ADDRESS_B]);
    expect(client.live).toHaveLength(1);

    // One address left: the subscription must survive.
    service.removeAddress(ADDRESS_A);
    await flush();
    expect(client.live).toHaveLength(1);

    // Last address gone: nothing to receive events for.
    service.removeAddress(ADDRESS_B);
    await flush();
    expect(client.live).toHaveLength(0);
    expect(installedChannel(service)).toBeNull();
    expect(mockAppStateHandlers).toHaveLength(0);
  });

  it('does not accumulate channels across the reconnect backoff loop', async () => {
    jest.useFakeTimers();
    try {
      const client = mockCurrentClient!;
      const { getRealtimeService } = loadModule();
      const service = getRealtimeService();

      await service.subscribeToAddresses([ADDRESS_A]);
      expect(client.live).toHaveLength(1);

      // Five CHANNEL_ERROR → scheduleReconnect cycles: the pre-fix code pushed
      // one un-removed RealtimeChannel into the registry per cycle.
      for (let attempt = 0; attempt < 5; attempt++) {
        client.live[0].emit('CHANNEL_ERROR');
        await jest.advanceTimersByTimeAsync(60_000);
      }

      expect(client.created.length).toBeGreaterThan(1);
      expect(client.live).toHaveLength(1);
      expect(client.live[0]).toBe(installedChannel(service));
      expect(client.removed).toHaveLength(client.created.length - 1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores status callbacks from a superseded channel', async () => {
    const client = mockCurrentClient!;
    const onConnectionChange = jest.fn();
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();
    service.setHandlers({ onConnectionChange });

    await service.subscribeToAddresses([ADDRESS_A]);
    const stale = client.created[0];

    await internals(service).resubscribe();
    onConnectionChange.mockClear();

    // The stale channel was removed; its late status updates must not touch
    // shared state or schedule a reconnect.
    stale.emit('SUBSCRIBED');
    stale.emit('CHANNEL_ERROR');
    await flush();

    expect(onConnectionChange).not.toHaveBeenCalled();
    expect(service.isRealtimeConnected()).toBe(false);
    expect(client.live).toHaveLength(1);
    expect(client.live[0]).toBe(installedChannel(service));
  });

  it('drops wallet events that arrive on a superseded channel', async () => {
    const client = mockCurrentClient!;
    const onAnyEvent = jest.fn();
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();
    service.setHandlers({ onAnyEvent });

    await service.subscribeToAddresses([ADDRESS_A]);
    const stale = client.created[0];

    await internals(service).resubscribe();

    const row = {
      id: 1,
      event_type: 'voi_payment',
      sender: ADDRESS_B,
      receiver: ADDRESS_A,
    };

    // In flight on the channel that was just torn down: delivering it would
    // double-fire the handlers (or fire them after an unsubscribe).
    stale.emitEvent(row);
    expect(onAnyEvent).not.toHaveBeenCalled();

    // The current channel still delivers — the guard must not over-block.
    client.live[0].emitEvent(row);
    expect(onAnyEvent).toHaveBeenCalledTimes(1);

    // And nothing is delivered after an explicit stop.
    const current = client.live[0];
    await service.unsubscribe();
    current.emitEvent(row);
    expect(onAnyEvent).toHaveBeenCalledTimes(1);
  });

  it('retries removal when the client reports an error, so nothing is orphaned', async () => {
    const client = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();

    await service.subscribeToAddresses([ADDRESS_A]);

    // realtime-js resolves 'error' WITHOUT running the channel's close hook,
    // so RealtimeClient._remove() never runs and the channel stays registered.
    // The retry hits the `leaving` state and resolves locally.
    let attempts = 0;
    client.removeChannel.mockImplementation(async (channel: FakeChannel) => {
      attempts += 1;
      if (attempts === 1) return 'error';
      client.removed.push(channel);
      const index = client.live.indexOf(channel);
      if (index >= 0) client.live.splice(index, 1);
      return 'ok';
    });

    await service.unsubscribe();

    expect(attempts).toBe(2);
    expect(client.live).toHaveLength(0);
    expect(installedChannel(service)).toBeNull();
  });

  it('cleanup leaves no channel, no listener and no addresses', async () => {
    const client = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();

    await service.subscribeToAddresses([ADDRESS_A]);
    expect(client.live).toHaveLength(1);
    expect(mockAppStateHandlers).toHaveLength(1);

    await service.cleanup();

    expect(client.live).toHaveLength(0);
    expect(mockAppStateHandlers).toHaveLength(0);
    expect(installedChannel(service)).toBeNull();

    // Address set cleared, so a foreground cannot resurrect anything.
    await fireAppState('active');
    expect(client.created).toHaveLength(1);
  });
});

// Round 3 of the full-diff Codex pass over PLAN-275. cleanup() awaited
// unsubscribe() and cleared state only afterwards, so an install that completed
// DURING that await survived: its channel stayed live while the addresses,
// handlers and AppState listener were wiped out from under it — a channel
// nothing would ever tear down. The generation bump does not cover this, because
// such an install starts AFTER the bump and is therefore the newest.
describe('cleanup() racing a concurrent subscribe (TASK-190)', () => {
  it('leaves no channel behind when a subscribe lands mid-cleanup', async () => {
    const client = mockCurrentClient!;
    const { getRealtimeService } = loadModule();
    const service = getRealtimeService();

    await service.subscribeToAddresses([ADDRESS_A]);
    expect(client.live).toHaveLength(1);

    // Race an explicit subscribe into cleanup's teardown await.
    const cleaning = service.cleanup();
    const racing = service.subscribeToAddresses([ADDRESS_B]);
    await Promise.all([cleaning, racing]);
    await flush();

    expect(client.live).toHaveLength(0);
    expect(installedChannel(service)).toBeNull();
    expect(client.created.length - client.removed.length).toBe(0);
  });
});
