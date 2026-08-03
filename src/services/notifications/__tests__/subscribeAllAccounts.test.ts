/**
 * TASK-192 / F-37: `subscribeAllAccounts` used to issue two Supabase round
 * trips PER ACCOUNT (a `.single()` read, then an upsert) on every cold start.
 * Batching it is trivial; batching it WITHOUT regressing the four behaviours the
 * sequential loop got for free is not. These specs pin those behaviours first
 * and the round-trip count last, deliberately in that order:
 *
 *   - Accounts that already have preferences never enter the payload. A blanket
 *     upsert of defaults would silently reset every user's notification
 *     settings on the next app start.
 *   - `messages` is decided PER ACCOUNT (watch accounts cannot decrypt), not
 *     once for the batch.
 *   - The batch read fails CLOSED. One `.select()` cannot report which account
 *     failed, so a partial result is not a thing: a read error aborts the pass
 *     and writes nothing rather than overwriting real settings with defaults.
 *   - The write is insert-if-absent (ON CONFLICT DO NOTHING), so a row created
 *     or edited on another device between the read and the write survives.
 *
 * Plus the abort token: the pass is launched fire-and-forget over a wallet
 * snapshot, so an unmount or an account deletion mid-flight must drop the
 * write.
 *
 * Supabase is faked rather than mocked call-by-call: the fake owns a row store
 * and implements ON CONFLICT DO NOTHING for real, so "existing preferences
 * survive" is an assertion about stored state, not about arguments.
 */

import algosdk from 'algosdk';

import { AccountMetadata, AccountType } from '@/types/wallet';

const DEVICE_ID = 'test-device-id';

// --- Fake Supabase -------------------------------------------------------

type SubscriptionRow = Record<string, unknown>;

interface SelectResult {
  data: { account_address: string }[] | null;
  error: unknown;
}

interface SelectCall {
  columns: string;
  deviceId?: string;
  addresses?: string[];
}

interface UpsertCall {
  rows: SubscriptionRow[];
  options: Record<string, unknown> | undefined;
}

interface FakeDb {
  /** account_address -> stored row. */
  rows: Map<string, SubscriptionRow>;
  selectCalls: SelectCall[];
  upsertCalls: UpsertCall[];
  /** When set, the batch read resolves with this error and no data. */
  selectError: unknown;
  /** Runs after the read resolves and before the write — the race window. */
  betweenReadAndWrite: (() => void) | null;
}

const mockDb: FakeDb = {
  rows: new Map(),
  selectCalls: [],
  upsertCalls: [],
  selectError: null,
  betweenReadAndWrite: null,
};

interface SelectQuery {
  eq(column: string, value: string): SelectQuery;
  in(column: string, values: string[]): SelectQuery;
  then<TResult1 = SelectResult, TResult2 = never>(
    onfulfilled?:
      | ((value: SelectResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>;
}

const mockMakeSelectQuery = (columns: string): SelectQuery => {
  const call: SelectCall = { columns };

  const run = async (): Promise<SelectResult> => {
    mockDb.selectCalls.push(call);

    if (mockDb.selectError) {
      // Read failed wholesale — the caller cannot know which account this
      // covered, which is exactly why it must abort.
      mockDb.betweenReadAndWrite?.();
      return { data: null, error: mockDb.selectError };
    }

    const scope = call.addresses ?? Array.from(mockDb.rows.keys());
    const data = scope
      .filter((address) => mockDb.rows.has(address))
      .map((address) => ({ account_address: address }));

    mockDb.betweenReadAndWrite?.();
    return { data, error: null };
  };

  const query: SelectQuery = {
    eq(column, value) {
      if (column === 'device_id') call.deviceId = value;
      return query;
    },
    in(column, values) {
      if (column === 'account_address') call.addresses = values;
      return query;
    },
    then: (onfulfilled, onrejected) => run().then(onfulfilled, onrejected),
  };

  return query;
};

const mockSupabaseClient = {
  schema: (schemaName: string) => ({
    from: (table: string) => ({
      select: (columns: string) => {
        if (schemaName !== 'voiwallet' || table !== 'account_subscriptions') {
          throw new Error(`Unexpected read of ${schemaName}.${table}`);
        }
        return mockMakeSelectQuery(columns);
      },
      upsert: async (
        rows: SubscriptionRow | SubscriptionRow[],
        options?: Record<string, unknown>
      ) => {
        const list = Array.isArray(rows) ? rows : [rows];
        mockDb.upsertCalls.push({ rows: list, options });

        for (const row of list) {
          const address = row.account_address as string;
          const existing = mockDb.rows.get(address);
          // ON CONFLICT DO NOTHING when ignoreDuplicates is set; otherwise the
          // row is overwritten (which is what must NOT happen here).
          if (existing && options?.ignoreDuplicates) continue;
          mockDb.rows.set(address, { ...(existing ?? {}), ...row });
        }

        return { error: null };
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
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../types';
import {
  invalidateAccountSubscribePasses,
  takeAccountSubscribeToken,
} from '../subscribePass';

// --- Fixtures ------------------------------------------------------------

/** A real, checksum-valid Algorand address (deterministic per seed byte). */
const address = (seed: number): string =>
  algosdk.encodeAddress(new Uint8Array(32).fill(seed));

const STANDARD_A = address(1);
const STANDARD_B = address(2);
const WATCH_A = address(3);
const EXISTING_A = address(4);
const LEDGER_A = address(5);

const account = (
  addr: string,
  type: AccountType = AccountType.STANDARD
): AccountMetadata =>
  ({
    id: `id-${addr.slice(0, 6)}`,
    address: addr,
    publicKey: '00',
    type,
  }) as AccountMetadata;

/** Seed a row as if this account had been subscribed on a previous run. */
const seedExisting = (addr: string, overrides: SubscriptionRow = {}): void => {
  mockDb.rows.set(addr, {
    device_id: DEVICE_ID,
    account_address: addr,
    notify_messages: false,
    notify_voi_payments: false,
    notify_arc200_transfers: false,
    notify_arc72_transfers: false,
    notify_outgoing_confirmations: false,
    notify_price_alerts: false,
    min_voi_amount: 42,
    min_arc200_amount: 7,
    price_alert_threshold_percent: 99,
    ...overrides,
  });
};

const writtenAddresses = (): string[] =>
  mockDb.upsertCalls.flatMap((call) =>
    call.rows.map((row) => row.account_address as string)
  );

const writtenRow = (addr: string): SubscriptionRow | undefined =>
  mockDb.upsertCalls
    .flatMap((call) => call.rows)
    .find((row) => row.account_address === addr);

// The device ID is normally assigned by initialize(); the specs only need it
// present, and driving the full Expo init would add nothing they assert on.
beforeAll(() => {
  (notificationService as unknown as { deviceId: string | null }).deviceId =
    DEVICE_ID;
});

beforeEach(() => {
  mockDb.rows.clear();
  mockDb.selectCalls = [];
  mockDb.upsertCalls = [];
  mockDb.selectError = null;
  mockDb.betweenReadAndWrite = null;
});

describe('subscribeAllAccounts — existing preferences are never overwritten', () => {
  it('excludes accounts that already have preferences from the payload entirely', async () => {
    seedExisting(EXISTING_A);

    await notificationService.subscribeAllAccounts([
      account(EXISTING_A),
      account(STANDARD_A),
    ]);

    expect(writtenAddresses()).toEqual([STANDARD_A]);
    expect(writtenRow(EXISTING_A)).toBeUndefined();
  });

  it('leaves the stored preferences of an already-subscribed account byte-for-byte unchanged', async () => {
    seedExisting(EXISTING_A);
    const before = { ...mockDb.rows.get(EXISTING_A) };

    await notificationService.subscribeAllAccounts([
      account(EXISTING_A),
      account(STANDARD_A),
    ]);

    expect(mockDb.rows.get(EXISTING_A)).toEqual(before);
  });

  it('writes nothing at all when every account is already subscribed', async () => {
    seedExisting(EXISTING_A);
    seedExisting(STANDARD_A);

    await notificationService.subscribeAllAccounts([
      account(EXISTING_A),
      account(STANDARD_A),
    ]);

    expect(mockDb.upsertCalls).toHaveLength(0);
  });
});

describe('subscribeAllAccounts — defaults are decided per account', () => {
  it('disables messages for watch accounts and enables them for every other type', async () => {
    await notificationService.subscribeAllAccounts([
      account(STANDARD_A, AccountType.STANDARD),
      account(WATCH_A, AccountType.WATCH),
      account(LEDGER_A, AccountType.LEDGER),
    ]);

    expect(writtenRow(STANDARD_A)?.notify_messages).toBe(true);
    expect(writtenRow(WATCH_A)?.notify_messages).toBe(false);
    expect(writtenRow(LEDGER_A)?.notify_messages).toBe(true);
  });

  it('produces exactly the right payload for a mixed batch (existing + new + watch + non-watch)', async () => {
    seedExisting(EXISTING_A);

    await notificationService.subscribeAllAccounts([
      account(EXISTING_A, AccountType.STANDARD),
      account(STANDARD_A, AccountType.STANDARD),
      account(WATCH_A, AccountType.WATCH),
      account(STANDARD_B, AccountType.REKEYED),
    ]);

    expect(mockDb.upsertCalls).toHaveLength(1);
    expect(mockDb.upsertCalls[0].rows).toHaveLength(3);
    expect(writtenAddresses()).toEqual([STANDARD_A, WATCH_A, STANDARD_B]);

    expect(writtenRow(STANDARD_A)).toMatchObject({
      device_id: DEVICE_ID,
      account_address: STANDARD_A,
      notify_messages: true,
      notify_voi_payments: DEFAULT_NOTIFICATION_PREFERENCES.voiPayments,
      notify_price_alerts: DEFAULT_NOTIFICATION_PREFERENCES.priceAlerts,
      price_alert_threshold_percent:
        DEFAULT_NOTIFICATION_PREFERENCES.priceAlertThreshold,
    });
    expect(writtenRow(WATCH_A)).toMatchObject({
      account_address: WATCH_A,
      notify_messages: false,
      // Only `messages` differs for a watch account; the rest are defaults.
      notify_voi_payments: DEFAULT_NOTIFICATION_PREFERENCES.voiPayments,
    });
    expect(writtenRow(STANDARD_B)?.notify_messages).toBe(true);
  });
});

describe('subscribeAllAccounts — the batch read fails CLOSED', () => {
  it('aborts the whole pass and writes nothing when the batch read errors', async () => {
    mockDb.selectError = { message: 'network down' };

    await notificationService.subscribeAllAccounts([
      account(STANDARD_A),
      account(WATCH_A, AccountType.WATCH),
      account(EXISTING_A),
    ]);

    expect(mockDb.upsertCalls).toHaveLength(0);
  });

  it('leaves every account’s stored preferences unchanged when the read errors', async () => {
    seedExisting(EXISTING_A);
    seedExisting(WATCH_A, { notify_messages: true });
    const snapshot = new Map(
      Array.from(mockDb.rows, ([key, row]) => [key, { ...row }])
    );
    mockDb.selectError = { message: 'network down' };

    await notificationService.subscribeAllAccounts([
      account(EXISTING_A),
      account(WATCH_A, AccountType.WATCH),
      account(STANDARD_A),
    ]);

    expect(mockDb.rows.size).toBe(snapshot.size);
    for (const [addr, row] of snapshot) {
      expect(mockDb.rows.get(addr)).toEqual(row);
    }
  });
});

describe('subscribeAllAccounts — writes are insert-if-absent', () => {
  it('does not clobber a preference changed on another device between the read and the write', async () => {
    // STANDARD_A is absent when the batch read runs, so it lands in the
    // payload; another device then subscribes it with messages OFF.
    mockDb.betweenReadAndWrite = () => {
      seedExisting(STANDARD_A, { notify_messages: false, min_voi_amount: 123 });
    };

    await notificationService.subscribeAllAccounts([account(STANDARD_A)]);

    // The write went out (the pass could not have known) but resolved to
    // ON CONFLICT DO NOTHING, so the other device's values survive.
    expect(mockDb.upsertCalls).toHaveLength(1);
    expect(mockDb.upsertCalls[0].options).toMatchObject({
      onConflict: 'device_id,account_address',
      ignoreDuplicates: true,
    });
    expect(mockDb.rows.get(STANDARD_A)).toMatchObject({
      notify_messages: false,
      min_voi_amount: 123,
    });
  });
});

describe('subscribeAllAccounts — the abort token drops stale writes', () => {
  it('performs no write when a teardown invalidates the pass mid-flight', async () => {
    // Exactly what serviceBootstrap's unmount teardown calls.
    mockDb.betweenReadAndWrite = () => invalidateAccountSubscribePasses();

    await notificationService.subscribeAllAccounts([
      account(STANDARD_A),
      account(WATCH_A, AccountType.WATCH),
    ]);

    expect(mockDb.upsertCalls).toHaveLength(0);
    expect(mockDb.rows.size).toBe(0);
  });

  it('performs no write when an account is deleted mid-flight (session still mounted)', async () => {
    // Distinct path from teardown: walletStore.deleteAccount invalidates while
    // the session is very much alive, because the snapshot below still names
    // the account being removed.
    const snapshot = [account(STANDARD_A), account(STANDARD_B)];
    mockDb.betweenReadAndWrite = () => {
      // The account is gone from storage; the snapshot is now a lie.
      invalidateAccountSubscribePasses();
    };

    await notificationService.subscribeAllAccounts(snapshot);

    expect(mockDb.upsertCalls).toHaveLength(0);
    expect(mockDb.rows.has(STANDARD_B)).toBe(false);
  });

  it('honours a token taken at launch rather than at entry', async () => {
    // serviceBootstrap takes the token synchronously at launch and passes it
    // in; an invalidation before subscribeAllAccounts is even entered must
    // still drop the write.
    const launchToken = takeAccountSubscribeToken();
    invalidateAccountSubscribePasses();

    await notificationService.subscribeAllAccounts(
      [account(STANDARD_A)],
      launchToken
    );

    expect(mockDb.upsertCalls).toHaveLength(0);
  });

  it('still writes when nothing invalidated the pass', async () => {
    await notificationService.subscribeAllAccounts([account(STANDARD_A)]);

    expect(mockDb.upsertCalls).toHaveLength(1);
  });
});

describe('subscribeAllAccounts — address validation is a real checksum check', () => {
  it('rejects a 58-character string that fails the checksum before the payload is built', async () => {
    // 58 chars of valid base32 — the old length-only check accepted this.
    const bogus = 'A'.repeat(58);
    expect(bogus).toHaveLength(58);
    expect(algosdk.isValidAddress(bogus)).toBe(false);

    await notificationService.subscribeAllAccounts([
      account(bogus),
      account(STANDARD_A),
    ]);

    expect(writtenAddresses()).toEqual([STANDARD_A]);
    // ...and it was never even asked about in the read.
    expect(mockDb.selectCalls[0].addresses).toEqual([STANDARD_A]);
  });

  it('writes nothing and issues no query when every address is invalid', async () => {
    await notificationService.subscribeAllAccounts([
      account('A'.repeat(58)),
      account('not-an-address'),
    ]);

    expect(mockDb.selectCalls).toHaveLength(0);
    expect(mockDb.upsertCalls).toHaveLength(0);
  });
});

describe('subscribeAllAccounts — round-trip count', () => {
  it('issues exactly one read and one write for N accounts', async () => {
    const accounts = [
      account(STANDARD_A),
      account(STANDARD_B),
      account(WATCH_A, AccountType.WATCH),
      account(LEDGER_A, AccountType.LEDGER),
      account(EXISTING_A),
    ];

    await notificationService.subscribeAllAccounts(accounts);

    expect(mockDb.selectCalls).toHaveLength(1);
    expect(mockDb.upsertCalls).toHaveLength(1);
    expect(mockDb.selectCalls[0]).toMatchObject({
      deviceId: DEVICE_ID,
      addresses: accounts.map((a) => a.address),
    });
    expect(mockDb.upsertCalls[0].rows).toHaveLength(accounts.length);
  });

  it('issues no query at all for an empty account list', async () => {
    await notificationService.subscribeAllAccounts([]);

    expect(mockDb.selectCalls).toHaveLength(0);
    expect(mockDb.upsertCalls).toHaveLength(0);
  });
});
