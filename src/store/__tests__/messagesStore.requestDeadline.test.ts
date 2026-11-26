/**
 * A messaging request that never settles releases the per-account in-flight
 * guard, so the next poll and a manual refresh both run (TASK-490).
 *
 * Uses the real MessagingService with a Supabase query and an indexer that
 * never answer; only key derivation and registration are stubbed.
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

// Counts the Supabase queries that were actually started.
let mockQueriesStarted = 0;
jest.mock('@/services/supabase', () => ({
  getSupabaseClient: () => {
    const builder: Record<string, unknown> = {};
    for (const m of [
      'schema',
      'from',
      'select',
      'or',
      'order',
      'limit',
      'gt',
    ]) {
      builder[m] = () => builder;
    }
    builder.then = () => {
      mockQueriesStarted++; // never settles
    };
    return builder;
  },
}));
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getIndexerClient: () => ({
        lookupAccountTransactions: () => {
          const q: Record<string, unknown> = {};
          for (const m of ['txType', 'limit']) q[m] = () => q;
          q.do = () => new Promise(() => {});
          return q;
        },
      }),
    }),
  },
}));
jest.mock('@/services/transactions', () => ({ TransactionService: {} }));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {},
}));
jest.mock('@/services/wallet', () => ({ MultiAccountWalletService: {} }));
jest.mock('@/services/wallet/rekeyManager', () => ({}));

import MessagingService from '@/services/messaging';
import { MESSAGING_REQUEST_TIMEOUT_MS } from '@/services/messaging/requestDeadline';
import { useMessagesStore } from '@/store/messagesStore';

const ADDRESS = 'A'.repeat(58);
// Mimir deadline, then the indexer fallback's deadline.
const FULL_ATTEMPT_MS = 2 * MESSAGING_REQUEST_TIMEOUT_MS + 1;

describe('messagesStore: stalled messaging requests release the sync guard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockActiveAddress = ADDRESS;
    mockQueriesStarted = 0;
    jest
      .spyOn(MessagingService, 'isKeyRegistered')
      .mockResolvedValue(true as never);
    jest
      .spyOn(MessagingService, 'deriveMessagingKeyPair')
      .mockResolvedValue({} as never);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a never-settling query ends the sync with an error and the next poll runs', async () => {
    const store = () => useMessagesStore.getState();

    const first = store().fetchAllThreads(ADDRESS);
    await jest.advanceTimersByTimeAsync(FULL_ATTEMPT_MS);
    await first; // settles; before the deadline it never did
    expect(store().isLoading).toBe(false);
    expect(store().lastError).not.toBeNull();
    const startedAfterFirst = mockQueriesStarted;
    expect(startedAfterFirst).toBeGreaterThan(0);

    // The guard was released: a second sync (poll or manual refresh) really
    // issues its own request instead of returning at the guard.
    const second = store().fetchAllThreads(ADDRESS);
    await jest.advanceTimersByTimeAsync(FULL_ATTEMPT_MS);
    await second;
    expect(mockQueriesStarted).toBeGreaterThan(startedAfterFirst);
  });
});
