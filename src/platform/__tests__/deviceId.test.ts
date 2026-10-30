// TASK-449 — the device-id adapter runs one load at a time. Callers bound the
// read (AccountSecureStorage.getStableDeviceId), so an abandoned load can still
// be running when the next call arrives. If that call started a second load,
// both could read absence and mint different ids, and the later write would
// replace the id earlier keys were derived from.

const mockStore = new Map<string, string>();
const mockPendingReads: ((value: string | null) => void)[] = [];
let mockWedgeReads = false;
let mockFailNextRead = false;

jest.mock('../mobile/secureStorage', () => ({
  mobileSecureStorage: {
    getItem: jest.fn((k: string) => {
      if (mockFailNextRead) {
        mockFailNextRead = false;
        return Promise.reject(new Error('keychain unavailable'));
      }
      if (mockWedgeReads) {
        return new Promise<string | null>((resolve) => {
          mockPendingReads.push(resolve);
        });
      }
      return Promise.resolve(mockStore.get(k) ?? null);
    }),
    setItem: jest.fn(async (k: string, v: string) => {
      mockStore.set(k, v);
    }),
  },
}));

jest.mock('expo-application', () => ({}));

let mockRandomCounter = 0;
jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: jest.fn(async (n: number) => {
    mockRandomCounter += 1;
    return new Uint8Array(n).fill(mockRandomCounter);
  }),
}));

import { MobileDeviceIdAdapter } from '../mobile/deviceId';
import { mobileSecureStorage } from '../mobile/secureStorage';

const DEVICE_ID_KEY = 'voi_device_installation_id';

beforeEach(() => {
  mockStore.clear();
  mockPendingReads.length = 0;
  mockWedgeReads = false;
  mockFailNextRead = false;
  mockRandomCounter = 0;
  jest.clearAllMocks();
});

describe('TASK-449 MobileDeviceIdAdapter: one load at a time', () => {
  it('a call made while a load is pending joins it instead of minting a second id', async () => {
    const adapter = new MobileDeviceIdAdapter();
    mockWedgeReads = true;

    const first = adapter.getDeviceId(); // abandoned by its caller's deadline
    const second = adapter.getDeviceId();
    await Promise.resolve();

    expect(mobileSecureStorage.getItem).toHaveBeenCalledTimes(1);

    mockPendingReads[0](null); // the stalled read finally reports absence
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(mobileSecureStorage.setItem).toHaveBeenCalledTimes(1);
    expect(mockStore.get(DEVICE_ID_KEY)).toBe(a);
    await expect(adapter.getDeviceId()).resolves.toBe(a);
  });

  it('a failed load is not cached: the next call reads again', async () => {
    const adapter = new MobileDeviceIdAdapter();
    mockStore.set(DEVICE_ID_KEY, 'stored-id');
    mockFailNextRead = true;

    await expect(adapter.getDeviceId()).rejects.toThrow('keychain unavailable');
    await expect(adapter.getDeviceId()).resolves.toBe('stored-id');
    expect(mobileSecureStorage.getItem).toHaveBeenCalledTimes(2);
    expect(mobileSecureStorage.setItem).not.toHaveBeenCalled();
  });
});
