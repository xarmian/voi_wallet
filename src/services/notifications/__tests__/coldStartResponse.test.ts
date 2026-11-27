/**
 * Cold-start notification response wiring (DR-10 / TASK-381).
 *
 * The launch notification response is read in notificationService.initialize()
 * AFTER the isSupabaseConfigured() early return, and handed to the tap handler
 * together with its request identifier: the deep-link service keys its route
 * queue on that identifier (pendingRoute dedupe), so the cold-start response
 * and a response-listener event for the same tap route once.
 */

let mockSupabaseConfigured = true;
jest.mock('../../supabase', () => ({
  getSupabaseClient: () => null,
  isSupabaseConfigured: () => mockSupabaseConfigured,
  setDeviceId: jest.fn(),
}));

const mockResponseSubscription = { remove: jest.fn() };
let mockResponseListener: ((response: unknown) => void) | null = null;
// Shared across jest.isolateModules registries (each re-runs this factory), so
// the spies below are the ones the freshly loaded service actually calls.
const mockGetLastResponse = jest.fn(async (): Promise<unknown> => null);
const mockClearLastResponse = jest.fn((): void => {});
const mockAddResponseListener = jest.fn(
  (listener: (response: unknown) => void) => {
    mockResponseListener = listener;
    return mockResponseSubscription;
  }
);
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: (
    listener: (response: unknown) => void
  ) => mockAddResponseListener(listener),
  getLastNotificationResponseAsync: () => mockGetLastResponse(),
  clearLastNotificationResponse: () => mockClearLastResponse(),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));

jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

const mockStorage = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => mockStorage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async () => {}),
  },
}));

jest.mock('../../../platform', () => ({
  deviceId: { getDeviceId: jest.fn(async () => 'device-1') },
}));

const response = (identifier: string, data: Record<string, unknown>) => ({
  notification: { request: { identifier, content: { data } } },
});

/** Fresh singleton per test (it holds the tap handler / pending tap). */
const loadService = () => {
  let service: typeof import('../index').notificationService;
  jest.isolateModules(() => {
    service = require('../index').notificationService;
  });
  return service!;
};

/** A fresh singleton and the wipe gate from the same module registry. */
const loadWithGate = () => {
  let loaded: {
    service: typeof import('../index').notificationService;
    gate: typeof import('@/services/wipe/gate');
  };
  jest.isolateModules(() => {
    loaded = {
      service: require('../index').notificationService,
      gate: require('@/services/wipe/gate'),
    };
  });
  return loaded!;
};

describe('notificationService cold-start response (TASK-381)', () => {
  beforeEach(() => {
    mockSupabaseConfigured = true;
    mockResponseListener = null;
    mockStorage.clear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hands the cold-start response to the tap handler with its identifier', async () => {
    mockGetLastResponse.mockResolvedValueOnce(
      response('notif-1', { type: 'payment' })
    );
    const service = loadService();
    const handler = jest.fn();
    service.setNotificationTapHandler(handler);

    await service.initialize();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: 'payment' }, 'notif-1');
    service.cleanup();
  });

  it('a response that arrives before the tap handler is set keeps its identifier', async () => {
    mockGetLastResponse.mockResolvedValueOnce(
      response('notif-2', { type: 'message' })
    );
    const service = loadService();

    await service.initialize();
    const handler = jest.fn();
    service.setNotificationTapHandler(handler);

    expect(handler).toHaveBeenCalledWith({ type: 'message' }, 'notif-2');
    service.cleanup();
  });

  it('the response listener passes the identifier too, and teardown removes it', async () => {
    const service = loadService();
    const handler = jest.fn();
    service.setNotificationTapHandler(handler);
    await service.initialize();

    mockResponseListener!(response('notif-3', { type: 'payment' }));
    expect(handler).toHaveBeenCalledWith({ type: 'payment' }, 'notif-3');

    service.cleanup();
    expect(mockResponseSubscription.remove).toHaveBeenCalledTimes(1);
  });

  it('without Supabase it neither reads the last response nor delivers anything', async () => {
    mockSupabaseConfigured = false;
    mockGetLastResponse.mockResolvedValueOnce(
      response('notif-4', { type: 'payment' })
    );
    const service = loadService();
    const handler = jest.fn();
    service.setNotificationTapHandler(handler);

    await service.initialize();

    expect(mockGetLastResponse).not.toHaveBeenCalled();
    expect(mockAddResponseListener).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  describe('a wipe (TASK-469)', () => {
    // A launch response queued by an earlier test that never read it must not
    // leak in here.
    beforeEach(() => {
      mockGetLastResponse.mockReset();
      mockGetLastResponse.mockImplementation(async () => null);
      mockClearLastResponse.mockReset();
    });

    // expo-notifications holds the launch response natively for the whole
    // process: every read returns it until it is cleared.
    const holdLaunchResponse = (held: unknown) => {
      let current = held;
      mockGetLastResponse.mockImplementation(async () => current);
      mockClearLastResponse.mockImplementation(() => {
        current = null;
      });
    };

    it('a launch tap is not delivered again by an initialize after a wipe', async () => {
      holdLaunchResponse(
        response('notif-11', { type: 'payment', txId: 'TXOLD' })
      );
      const { service, gate } = loadWithGate();
      const handler = jest.fn();
      service.setNotificationTapHandler(handler);
      await service.initialize();
      expect(handler).toHaveBeenCalledTimes(1);

      // The wipe: the resets run, then the sweep removes the last-handled id.
      gate.openWipeWindow();
      const run = gate.runWipeResets();
      mockStorage.clear();
      gate.closeWipeWindow();
      expect(run.failed).toEqual([]);

      // Re-enabling notifications in Settings runs initialize() again.
      await service.initialize();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockClearLastResponse).toHaveBeenCalledTimes(1);
      service.cleanup();
    });

    it('a failed native clear is reported as the notifications reset failing, and the queued tap is still dropped', async () => {
      holdLaunchResponse(response('notif-12', { type: 'payment' }));
      mockClearLastResponse.mockImplementation(() => {
        throw new Error('native clear failed');
      });
      const { service, gate } = loadWithGate();
      await service.initialize();
      expect(service.getPendingNotificationTap()).not.toBeNull();

      const run = gate.runWipeResets();
      expect(run.failed).toEqual(['notifications']);
      expect(service.getPendingNotificationTap()).toBeNull();
      service.cleanup();
    });

    it('drops a tap queued before the wipe, so a later tap handler does not get it', async () => {
      mockGetLastResponse.mockResolvedValueOnce(
        response('notif-5', { type: 'payment', txId: 'TX1' })
      );
      const { service, gate } = loadWithGate();
      await service.initialize();
      expect(service.getPendingNotificationTap()).not.toBeNull();

      gate.runWipeResets();
      expect(service.getPendingNotificationTap()).toBeNull();
      const handler = jest.fn();
      service.setNotificationTapHandler(handler);
      expect(handler).not.toHaveBeenCalled();
      service.cleanup();
    });

    it('does not queue a launch tap read while a wipe runs', async () => {
      const read: { answer?: (value: unknown) => void } = {};
      mockGetLastResponse.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            read.answer = resolve;
          })
      );
      const { service, gate } = loadWithGate();
      const starting = service.initialize();
      for (let i = 0; i < 50 && !read.answer; i++) await Promise.resolve();
      expect(read.answer).toBeDefined();
      gate.openWipeWindow();
      gate.runWipeResets();
      read.answer!(response('notif-9', { type: 'payment' }));
      await starting;
      gate.closeWipeWindow();

      expect(service.getPendingNotificationTap()).toBeNull();
      const handler = jest.fn();
      service.setNotificationTapHandler(handler);
      expect(handler).not.toHaveBeenCalled();
      service.cleanup();
    });

    it('a tap dropped by the wipe logs one fixed line and none of its payload', async () => {
      const { service, gate } = loadWithGate();
      await service.initialize();
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        gate.openWipeWindow();
        mockResponseListener!(
          response('notif-10', { type: 'payment', txId: 'TXSECRET' })
        );
        gate.closeWipeWindow();
        const logged = JSON.stringify(log.mock.calls);
        expect(logged).not.toContain('TXSECRET');
        const tapLines = log.mock.calls.filter((call) =>
          /tap/i.test(String(call[0]))
        );
        expect(tapLines).toEqual([['[Notifications] Tap dropped by a wipe']]);
      } finally {
        log.mockRestore();
        service.cleanup();
      }
    });

    it('ignores a tap that arrives while the wipe runs, queued or delivered', async () => {
      const { service, gate } = loadWithGate();
      await service.initialize();

      gate.openWipeWindow();
      mockResponseListener!(response('notif-6', { type: 'payment' }));
      gate.closeWipeWindow();
      expect(service.getPendingNotificationTap()).toBeNull();
      const handler = jest.fn();
      service.setNotificationTapHandler(handler);
      expect(handler).not.toHaveBeenCalled();

      gate.openWipeWindow();
      mockResponseListener!(response('notif-7', { type: 'payment' }));
      gate.closeWipeWindow();
      expect(handler).not.toHaveBeenCalled();

      // Once the wipe has settled, taps are delivered again.
      mockResponseListener!(response('notif-8', { type: 'payment' }));
      expect(handler).toHaveBeenCalledWith({ type: 'payment' }, 'notif-8');
      service.cleanup();
    });
  });
});
