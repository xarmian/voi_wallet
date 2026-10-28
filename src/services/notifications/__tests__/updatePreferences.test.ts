import algosdk from 'algosdk';

const DEVICE_ID = 'test-device-id';
const ADDRESS = algosdk.encodeAddress(new Uint8Array(32).fill(1));

type SubscriptionRow = Record<string, unknown>;

const mockDb = {
  rows: [] as SubscriptionRow[],
  updates: [] as SubscriptionRow[],
  error: null as { message: string } | null,
};

// Apply the actual device/account filters to a small in-memory row store.
const mockSupabaseClient = {
  schema: (schemaName: string) => ({
    from: (table: string) => ({
      select: (columns: string) => {
        if (schemaName !== 'voiwallet' || table !== 'account_subscriptions') {
          throw new Error(`Unexpected read of ${schemaName}.${table}`);
        }
        expect(columns).toBe('*');
        const filters: Record<string, string> = {};
        const query = {
          eq(column: string, value: string) {
            filters[column] = value;
            return query;
          },
          async single() {
            if (mockDb.error) return { data: null, error: mockDb.error };
            const data = mockDb.rows.find((row) =>
              Object.entries(filters).every(
                ([key, value]) => row[key] === value
              )
            );
            return { data: data ?? null, error: null };
          },
        };
        return query;
      },
      update: (updates: SubscriptionRow) => {
        if (schemaName !== 'voiwallet' || table !== 'account_subscriptions') {
          throw new Error(`Unexpected update of ${schemaName}.${table}`);
        }
        mockDb.updates.push(updates);
        const filters: Record<string, string> = {};
        const query = {
          eq(column: string, value: string) {
            filters[column] = value;
            return query;
          },
          async select(columns: string) {
            expect(columns).toBe('account_address');
            if (mockDb.error) return { data: null, error: mockDb.error };
            const matched = mockDb.rows.filter((row) =>
              Object.entries(filters).every(
                ([key, value]) => row[key] === value
              )
            );
            for (const row of matched) Object.assign(row, updates);
            return {
              data: matched.map((row) => ({
                account_address: row.account_address,
              })),
              error: null,
            };
          },
        };
        return query;
      },
    }),
  }),
};

jest.mock('../../supabase', () => ({
  getSupabaseClient: () => mockSupabaseClient,
  isSupabaseConfigured: () => true,
  setDeviceId: jest.fn(),
}));

// The service reaches for these at import/init time only; none of them carry
// behaviour these specs depend on.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({
    remove: jest.fn(),
  })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'token' })),
  setBadgeCountAsync: jest.fn(async () => {}),
  setNotificationChannelAsync: jest.fn(async () => {}),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));

jest.mock('expo-device', () => ({ isDevice: true }));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));

jest.mock('../../../platform', () => ({
  deviceId: { getDeviceId: jest.fn(async () => DEVICE_ID) },
}));

import { notificationService } from '../index';
import { microVoiToVoi, voiToMicroVoi } from '../types';

beforeAll(() => {
  (notificationService as unknown as { deviceId: string | null }).deviceId =
    DEVICE_ID;
});

beforeEach(() => {
  mockDb.rows = [];
  mockDb.updates = [];
  mockDb.error = null;
});

describe('updatePreferences', () => {
  it.each([false, true])(
    'stores explicit blockRewards %s as notify_proposer_payouts',
    async (enabled) => {
      const row = {
        device_id: DEVICE_ID,
        account_address: ADDRESS,
        notify_proposer_payouts: !enabled,
      };
      mockDb.rows.push(row);

      await expect(
        notificationService.updatePreferences(ADDRESS, {
          blockRewards: enabled,
        })
      ).resolves.toBe(true);

      expect(mockDb.updates).toEqual([
        expect.objectContaining({ notify_proposer_payouts: enabled }),
      ]);
      expect(row).toMatchObject({ notify_proposer_payouts: enabled });
    }
  );

  it('returns true for one matched row and stores the threshold in micro-VOI', async () => {
    const row = { device_id: DEVICE_ID, account_address: ADDRESS };
    mockDb.rows.push(row);
    // Other devices and accounts must not receive this update.
    const otherDevice = { device_id: 'other-device', account_address: ADDRESS };
    const otherAccount = {
      device_id: DEVICE_ID,
      account_address: algosdk.encodeAddress(new Uint8Array(32).fill(2)),
    };
    mockDb.rows.push(otherDevice, otherAccount);

    const saved = await notificationService.updatePreferences(ADDRESS, {
      minVoiAmount: voiToMicroVoi(100),
    });

    expect(saved).toBe(true);
    expect(mockDb.updates).toEqual([
      expect.objectContaining({ min_voi_amount: 100000000 }),
    ]);
    expect(row).toMatchObject({ min_voi_amount: 100000000 });
    expect(otherDevice).not.toHaveProperty('min_voi_amount');
    expect(otherAccount).not.toHaveProperty('min_voi_amount');
  });

  it('returns false for 0 matched rows', async () => {
    await expect(
      notificationService.updatePreferences(ADDRESS, { messages: false })
    ).resolves.toBe(false);
  });

  it('returns false when the update errors', async () => {
    mockDb.error = { message: 'update denied' };

    await expect(
      notificationService.updatePreferences(ADDRESS, { messages: false })
    ).resolves.toBe(false);
  });
});

describe('getPreferences', () => {
  it.each([
    [null, false],
    [undefined, false],
    [false, false],
    [true, true],
  ])(
    'maps notify_proposer_payouts %s to blockRewards %s',
    async (stored, expected) => {
      mockDb.rows.push(
        {
          device_id: 'other-device',
          account_address: ADDRESS,
          notify_proposer_payouts: !expected,
        },
        {
          device_id: DEVICE_ID,
          account_address: ADDRESS,
          notify_proposer_payouts: stored,
        }
      );

      await expect(
        notificationService.getPreferences(ADDRESS)
      ).resolves.toMatchObject({
        blockRewards: expected,
      });
    }
  );
});

describe('VOI and micro-VOI conversion', () => {
  it('round-trips VOI and preserves single micro-VOI and decimal amounts', () => {
    expect(voiToMicroVoi(100)).toBe(100000000);
    expect(voiToMicroVoi(0.000001)).toBe(1);
    expect(microVoiToVoi(100000000)).toBe(100);
    expect(voiToMicroVoi(1.1)).toBe(1100000);
    expect(microVoiToVoi(voiToMicroVoi(100))).toBe(100);
  });
});
