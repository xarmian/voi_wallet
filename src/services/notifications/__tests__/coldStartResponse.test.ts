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
});
