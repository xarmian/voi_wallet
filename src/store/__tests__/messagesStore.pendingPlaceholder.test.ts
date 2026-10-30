/**
 * A chat send that may have landed keeps its placeholder pending, never
 * 'failed', and the placeholder can't spin forever (TASK-454).
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockFetchMessages = jest.fn();
const mockFetchAllConversations = jest.fn();
jest.mock('@/services/messaging', () => ({
  __esModule: true,
  default: {
    deriveMessagingKeyPair: jest.fn(async () => ({})),
    isKeyRegistered: jest.fn(async () => true),
    fetchMessages: (...args: unknown[]) => mockFetchMessages(...args),
    fetchAllConversations: (...args: unknown[]) =>
      mockFetchAllConversations(...args),
  },
}));
jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: { isUnlocked: () => true },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  PENDING_PLACEHOLDER_PREFIX,
  PENDING_PLACEHOLDER_TTL_MS,
  useMessagesStore,
} from '@/store/messagesStore';
import type { Message } from '@/services/messaging/types';

const USER = 'USERADDRESS';
const FRIEND = 'FRIENDADDRESS';
const T0 = 1_700_000_000_000;
const TEMP = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;

const placeholder = (
  id: string,
  content: string,
  timestamp = T0,
  status: Message['status'] = 'pending'
): Message => ({
  id,
  threadId: FRIEND,
  direction: 'sent',
  content,
  timestamp,
  status,
  fee: 1000,
});

const chainSent = (
  id: string,
  content: string,
  timestamp: number
): Message => ({
  id,
  threadId: FRIEND,
  direction: 'sent',
  content,
  timestamp,
  status: 'confirmed',
  fee: 1000,
  confirmedRound: 42,
});

const store = () => useMessagesStore.getState();
const thread = () => store().threads[FRIEND]?.messages ?? [];
const row = (id: string) => thread().find((m) => m.id === id);
const load = () => store().fetchThreadMessages(USER, FRIEND);
const stored = async () =>
  JSON.parse((await AsyncStorage.getItem(`@messages/${USER}`)) ?? '{}');

describe('messagesStore pending placeholders (TASK-454)', () => {
  let now: jest.SpyInstance;

  beforeEach(async () => {
    await AsyncStorage.clear();
    useMessagesStore.setState({ threads: {}, currentUserAddress: USER });
    mockFetchMessages.mockReset().mockResolvedValue([]);
    mockFetchAllConversations.mockReset().mockResolvedValue({
      conversations: new Map(),
      complete: true,
      maxId: null,
    });
    now = jest.spyOn(Date, 'now').mockReturnValue(T0 + 1000);
  });

  afterEach(() => now.mockRestore());

  it('re-keys a placeholder to its txid, and the chain load confirms it by id', async () => {
    store().addPendingMessage(placeholder(TEMP, 'hi'));
    store().settlePendingMessage(TEMP, 'TX1');
    expect(thread()).toEqual([
      expect.objectContaining({ id: 'TX1', status: 'pending' }),
    ]);

    mockFetchMessages.mockResolvedValue([chainSent('TX1', 'hi', T0 + 5000)]);
    await load();
    expect(thread()).toEqual([
      expect.objectContaining({ id: 'TX1', status: 'confirmed' }),
    ]);
  });

  // Codex pass C: content can't tell two same-text attempts apart, so a
  // txid-less placeholder is never resolved by a chain record's content.
  it('keeps a txid-less placeholder pending, never failed, beside a same-text chain record', async () => {
    store().addPendingMessage(placeholder(TEMP, 'ok'));
    store().settlePendingMessage(TEMP, undefined, T0);

    mockFetchMessages.mockResolvedValue([chainSent('TX9', 'ok', T0 + 5000)]);
    await load();
    await load();
    expect(row(TEMP)).toEqual(
      expect.objectContaining({ status: 'pending', unsettled: true })
    );
    expect(row('TX9')?.status).toBe('confirmed');
  });

  it('ages a txid-less placeholder out at the end of its window', async () => {
    store().addPendingMessage(placeholder(TEMP, 'hi'));
    store().settlePendingMessage(TEMP, undefined, T0);

    now.mockReturnValue(T0 + PENDING_PLACEHOLDER_TTL_MS);
    await load();
    expect(row(TEMP)?.status).toBe('pending');

    now.mockReturnValue(T0 + PENDING_PLACEHOLDER_TTL_MS + 1);
    await load();
    expect(store().threads[FRIEND]).toBeUndefined();
  });

  // Codex pass A #3: a retry is a new attempt, aged from when it started.
  it('ages a retried placeholder from its new attempt, not the old bubble', async () => {
    const old = T0 - 3 * 60 * 60 * 1000;
    const id = `${PENDING_PLACEHOLDER_PREFIX}${old}`;
    store().addPendingMessage(placeholder(id, 'retry me', old, 'failed'));
    store().settlePendingMessage(id, undefined, T0);

    await load();
    expect(row(id)?.status).toBe('pending');
  });

  it('never ages out a txid-keyed pending message on a timer', async () => {
    store().addPendingMessage(placeholder(TEMP, 'hi'));
    store().settlePendingMessage(TEMP, 'TX3');

    now.mockReturnValue(T0 + 10 * PENDING_PLACEHOLDER_TTL_MS);
    await load();
    expect(thread()).toEqual([
      expect.objectContaining({ id: 'TX3', status: 'pending' }),
    ]);
  });

  // The poll only returns threads with new messages, so it must also age out
  // a placeholder in a quiet thread.
  it('the poll ages out a placeholder in a thread with no new messages', async () => {
    store().addPendingMessage(placeholder(TEMP, 'hi'));
    store().settlePendingMessage(TEMP, undefined, T0);

    await store().fetchAllThreads(USER);
    expect(row(TEMP)?.status).toBe('pending');

    now.mockReturnValue(T0 + PENDING_PLACEHOLDER_TTL_MS + 1);
    await store().fetchAllThreads(USER);
    expect(store().threads[FRIEND]).toBeUndefined();
  });

  // Codex pass A #1: an open chat expires locally, without a fetch.
  it('expires an unsettled placeholder locally, with no network call', () => {
    store().addPendingMessage(placeholder(TEMP, 'hi'));
    store().settlePendingMessage(TEMP, undefined, T0);

    store().expireUnsettledPlaceholders(FRIEND);
    expect(row(TEMP)?.status).toBe('pending');

    now.mockReturnValue(T0 + PENDING_PLACEHOLDER_TTL_MS + 1);
    store().expireUnsettledPlaceholders(FRIEND);
    expect(store().threads[FRIEND]).toBeUndefined();
    expect(mockFetchMessages).not.toHaveBeenCalled();
  });

  // Codex pass A #2: placeholders are memory-only, so storage never holds a
  // spinner that a restart could reload and nothing could resolve.
  it('never stores a pending placeholder, and strips one stored by an older build', async () => {
    mockFetchMessages.mockResolvedValue([
      chainSent('TX-KEEP', 'kept', T0 - 5000),
    ]);
    store().addPendingMessage(placeholder(TEMP, 'hi'));
    await load(); // persists while the send is in flight
    store().settlePendingMessage(TEMP, undefined, T0);
    await load();

    const saved = await stored();
    expect(saved[FRIEND].messages.map((m: Message) => m.id)).toEqual([
      'TX-KEEP',
    ]);

    await AsyncStorage.setItem(
      `@messages/${USER}`,
      JSON.stringify({
        [FRIEND]: {
          ...saved[FRIEND],
          messages: [
            ...saved[FRIEND].messages,
            placeholder('pending-legacy', 'x'),
          ],
        },
      })
    );
    useMessagesStore.setState({
      threads: {},
      currentUserAddress: null as never,
    });
    await store().loadCachedThreads(USER);
    expect(thread().map((m) => m.id)).toEqual(['TX-KEEP']);
  });

  it('keeps a failed placeholder in storage, so its retry survives a restart', async () => {
    store().addPendingMessage(placeholder(TEMP, 'oops', T0, 'failed'));
    await load();
    const saved = await stored();
    expect(saved[FRIEND].messages.map((m: Message) => m.id)).toEqual([TEMP]);
  });

  // Codex pass B #2: a genuine failure from another attempt must not turn an
  // unsettled row back into a retryable 'failed' one.
  it('never fails a row another attempt left unsettled', () => {
    store().addPendingMessage(placeholder(TEMP, 'hi'));
    store().settlePendingMessage(TEMP, undefined, T0);

    store().failPendingMessage(TEMP);
    expect(row(TEMP)).toEqual(
      expect.objectContaining({ status: 'pending', unsettled: true })
    );

    const other = `${PENDING_PLACEHOLDER_PREFIX}${T0 + 1}`;
    store().addPendingMessage(placeholder(other, 'x'));
    store().failPendingMessage(other);
    expect(row(other)?.status).toBe('failed');
  });
});
