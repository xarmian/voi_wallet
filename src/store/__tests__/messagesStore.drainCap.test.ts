/**
 * A sync whose drain stops at the page cap still advances the durable cursor
 * (TASK-491).
 *
 * Before: a capped drain left the cursor untouched, so with more than
 * cap x limit of the user's rows above the cursor every poll refetched the same
 * prefix and never reached anything newer. Anyone can write rows into a
 * victim's feed, so that was a cheap, permanent wedge.
 *
 * Uses the real MessagingService against a fake Supabase that honours
 * `id > cursor ORDER BY id ASC LIMIT n`. The cap is lowered to 3 pages; the
 * rows are spam the wallet skips (version 1), so only the cursor matters.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: { isUnlocked: () => true },
}));

let mockActiveAddress: string | null = null;
jest.mock('@/store/walletStore', () => ({
  useWalletStore: {
    getState: () => ({
      wallet: mockActiveAddress
        ? {
            activeAccountId: 'active',
            accounts: [{ id: 'active', address: mockActiveAddress }],
          }
        : null,
    }),
  },
}));

const TEST_CAP_PAGES = 3;
jest.mock('@/services/messaging/pagination', () => {
  const actual = jest.requireActual('@/services/messaging/pagination');
  return {
    ...actual,
    drainByCursor: (
      limit: number,
      fetchPage: never,
      getCursor: never,
      maxPages?: number
    ) =>
      actual.drainByCursor(
        limit,
        fetchPage,
        getCursor,
        maxPages ?? TEST_CAP_PAGES
      ),
  };
});

// Fake Supabase: rows are kept in `mockRows`; each query records its `gt` bound.
let mockRows: { id: number }[] = [];
let mockGtBounds: number[] = [];
jest.mock('@/services/supabase', () => ({
  getSupabaseClient: () => {
    const q = { gt: -1, limit: 0 };
    const builder: Record<string, unknown> = {};
    for (const m of ['schema', 'from', 'select', 'or', 'order']) {
      builder[m] = () => builder;
    }
    builder.gt = (_col: string, v: number) => {
      q.gt = v;
      mockGtBounds.push(v);
      return builder;
    };
    builder.limit = (n: number) => {
      q.limit = n;
      return builder;
    };
    builder.then = (resolve: (r: unknown) => void) =>
      resolve({
        data: mockRows
          .filter((r) => r.id > q.gt)
          .sort((a, b) => a.id - b.id)
          .slice(0, q.limit),
        error: null,
      });
    return builder;
  },
}));
jest.mock('@/services/network', () => ({
  NetworkService: { getInstance: () => ({}) },
}));
jest.mock('@/services/transactions', () => ({ TransactionService: {} }));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {},
}));
jest.mock('@/services/wallet', () => ({ MultiAccountWalletService: {} }));
jest.mock('@/services/wallet/rekeyManager', () => ({}));

import MessagingService from '@/services/messaging';
import { useMessagesStore } from '@/store/messagesStore';

const ADDRESS = 'A'.repeat(58);
const LIMIT = 100; // CONVERSATION_FETCH_LIMIT in the store
const NEWEST = TEST_CAP_PAGES * LIMIT + 150; // more than cap x limit rows

const spamRow = (id: number) => ({
  id,
  txid: `tx${id}`,
  sender: 'S'.repeat(58),
  receiver: ADDRESS,
  round: id,
  intra: 0,
  timestamp: 1,
  version: 1, // the wallet only reads v2, so these are skipped
  note: '',
  created_at: '',
});

describe('messagesStore: a drain stopped at the page cap advances the cursor (TASK-491)', () => {
  beforeEach(() => {
    mockActiveAddress = ADDRESS;
    mockGtBounds = [];
    mockRows = Array.from({ length: NEWEST }, (_, i) =>
      spamRow(i + 1)
    ) as never;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest
      .spyOn(MessagingService, 'isKeyRegistered')
      .mockResolvedValue(true as never);
    jest
      .spyOn(MessagingService, 'deriveMessagingKeyPair')
      .mockResolvedValue({ secretKey: new Uint8Array(32) } as never);
    // An existing cursor, so the sync drains incrementally (null = bootstrap).
    useMessagesStore.setState({ currentUserAddress: ADDRESS, committedId: 0 });
  });
  afterEach(() => jest.restoreAllMocks());

  it('the first sync advances to the last row it fetched; the second starts there and reaches the newest row', async () => {
    const store = () => useMessagesStore.getState();

    await store().fetchAllThreads(ADDRESS);
    expect(store().lastError).toBeNull();
    // Cap stop: pages 1..3 fetched rows 1..300.
    expect(store().committedId).toBe(TEST_CAP_PAGES * LIMIT);

    mockGtBounds = [];
    await store().fetchAllThreads(ADDRESS);
    // The second sync's first page starts at the advanced cursor, not at 0.
    expect(mockGtBounds[0]).toBe(TEST_CAP_PAGES * LIMIT);
    // 150 rows left: a short page, a complete drain, the newest row reached.
    expect(store().committedId).toBe(NEWEST);
  });
});
