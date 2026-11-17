/**
 * Every messaging network request has a wall-clock deadline (TASK-490).
 *
 * A Supabase or indexer request that never settles used to hang its caller
 * forever. The messages store holds a per-account in-flight guard across such
 * calls, so one stalled request suppressed every later poll and refresh for
 * that account until the app restarted.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// A never-settling Supabase query builder. Every builder method returns the
// builder; awaiting it never resolves. `calls` counts awaited queries.
let mockSupabaseAwaited = 0;
const makeHangingQuery = () => {
  const builder: Record<string, unknown> = {};
  for (const m of [
    'schema',
    'from',
    'select',
    'or',
    'order',
    'limit',
    'gt',
    'lt',
    'eq',
  ]) {
    builder[m] = () => builder;
  }
  builder.maybeSingle = () => {
    mockSupabaseAwaited++;
    return new Promise(() => {});
  };
  builder.then = () => {
    mockSupabaseAwaited++;
    // never calls resolve or reject
  };
  return builder;
};
let mockSupabaseEnabled = true;
jest.mock('@/services/supabase', () => ({
  getSupabaseClient: () => (mockSupabaseEnabled ? makeHangingQuery() : null),
}));

// Indexer: `.do()` either never settles or returns a canned response.
let mockIndexerHangs = true;
let mockIndexerResponse: unknown = { transactions: [] };
const makeIndexerQuery = () => {
  const q: Record<string, unknown> = {};
  for (const m of ['txType', 'limit', 'minRound', 'maxRound']) {
    q[m] = () => q;
  }
  q.do = () =>
    mockIndexerHangs
      ? new Promise(() => {})
      : Promise.resolve(mockIndexerResponse);
  return q;
};
jest.mock('@/services/network', () => ({
  NetworkService: {
    getInstance: () => ({
      getIndexerClient: () => ({
        lookupAccountTransactions: () => makeIndexerQuery(),
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
import { lookupMessagingKey } from '@/services/messaging/keyRegistry';
import { MESSAGING_REQUEST_TIMEOUT_MS } from '@/services/messaging/requestDeadline';

const ADDRESS = 'A'.repeat(58);
const FRIEND = 'B'.repeat(58);
const KEYPAIR = {} as never;

describe('messaging request deadlines (TASK-490)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockSupabaseAwaited = 0;
    mockSupabaseEnabled = true;
    mockIndexerHangs = true;
    mockIndexerResponse = { transactions: [] };
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('key lookup: a stalled Mimir query falls back to the indexer instead of hanging', async () => {
    mockIndexerHangs = false; // the indexer answers: no registration found
    const lookup = lookupMessagingKey(ADDRESS);
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await expect(lookup).resolves.toBeNull();
    expect(mockSupabaseAwaited).toBeGreaterThan(0);
  });

  it('key lookup: Mimir and indexer both stalled resolves to null (unavailable)', async () => {
    const lookup = lookupMessagingKey(ADDRESS);
    // Mimir deadline, then the indexer deadline.
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await expect(lookup).resolves.toBeNull();
  });

  it('fetchAllConversations: a stalled Mimir bootstrap falls back to the indexer', async () => {
    mockIndexerHangs = false;
    const fetched = MessagingService.fetchAllConversations(
      ADDRESS,
      KEYPAIR,
      100,
      undefined
    );
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    const result = await fetched;
    expect(result.maxId).toBeNull();
    expect(result.conversations.size).toBe(0);
  });

  it('fetchAllConversations: a stalled incremental Mimir page falls back to the indexer', async () => {
    mockIndexerHangs = false;
    const fetched = MessagingService.fetchAllConversations(
      ADDRESS,
      KEYPAIR,
      100,
      42
    );
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    const result = await fetched;
    expect(result.maxId).toBeNull();
  });

  it('fetchAllConversations: with the indexer also stalled it rejects at the deadline', async () => {
    const fetched = MessagingService.fetchAllConversations(
      ADDRESS,
      KEYPAIR,
      100,
      undefined
    );
    const settled = fetched.then(
      () => 'resolved',
      (e: Error) => e.message
    );
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await expect(settled).resolves.toMatch(/timed out/i);
  });

  it('fetchMessages: a stalled Mimir query falls back to the indexer', async () => {
    mockIndexerHangs = false;
    const fetched = MessagingService.fetchMessages(ADDRESS, FRIEND, KEYPAIR);
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await expect(fetched).resolves.toEqual([]);
  });

  it('fetchMessages: with the indexer also stalled it rejects at the deadline', async () => {
    const fetched = MessagingService.fetchMessages(ADDRESS, FRIEND, KEYPAIR);
    const settled = fetched.then(
      () => 'resolved',
      (e: Error) => e.message
    );
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await expect(settled).resolves.toMatch(/timed out/i);
  });

  it('the indexer-only path (no Supabase) also has a deadline', async () => {
    mockSupabaseEnabled = false;
    const fetched = MessagingService.fetchAllConversations(
      ADDRESS,
      KEYPAIR,
      100,
      undefined
    );
    const settled = fetched.then(
      () => 'resolved',
      (e: Error) => e.message
    );
    await jest.advanceTimersByTimeAsync(MESSAGING_REQUEST_TIMEOUT_MS + 1);
    await expect(settled).resolves.toMatch(/timed out/i);
  });
});
