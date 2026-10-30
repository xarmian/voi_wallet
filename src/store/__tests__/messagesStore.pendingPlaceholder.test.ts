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

import {
  PENDING_PLACEHOLDER_PREFIX,
  PENDING_PLACEHOLDER_TTL_MS,
  useMessagesStore,
} from '@/store/messagesStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Message } from '@/services/messaging/types';

const USER = 'USERADDRESS';
const FRIEND = 'FRIENDADDRESS';
const T0 = 1_700_000_000_000;

const placeholder = (id: string, content: string, timestamp = T0): Message => ({
  id,
  threadId: FRIEND,
  direction: 'sent',
  content,
  timestamp,
  status: 'pending',
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

const thread = () =>
  useMessagesStore.getState().threads[FRIEND]?.messages ?? [];
const load = () =>
  useMessagesStore.getState().fetchThreadMessages(USER, FRIEND);

describe('messagesStore pending placeholders (TASK-454)', () => {
  let now: jest.SpyInstance;

  beforeEach(() => {
    useMessagesStore.setState({ threads: {}, currentUserAddress: USER });
    mockFetchMessages.mockReset().mockResolvedValue([]);
    now = jest.spyOn(Date, 'now').mockReturnValue(T0 + 1000);
  });

  afterEach(() => now.mockRestore());

  it('re-keys a placeholder to its txid, and the chain load confirms it by id', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));

    useMessagesStore.getState().settlePendingMessage(tempId, 'TX1');
    expect(thread()).toEqual([
      expect.objectContaining({ id: 'TX1', status: 'pending' }),
    ]);

    mockFetchMessages.mockResolvedValue([chainSent('TX1', 'hi', T0 + 5000)]);
    await load();
    expect(thread()).toEqual([
      expect.objectContaining({ id: 'TX1', status: 'confirmed' }),
    ]);
  });

  it('keeps a txid-less placeholder pending, never failed, until chain shows it', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));
    useMessagesStore.getState().settlePendingMessage(tempId);

    await load();
    expect(thread()).toEqual([
      expect.objectContaining({ id: tempId, status: 'pending' }),
    ]);

    mockFetchMessages.mockResolvedValue([chainSent('TX9', 'hi', T0 + 5000)]);
    await load();
    expect(thread()).toEqual([
      expect.objectContaining({ id: 'TX9', status: 'confirmed' }),
    ]);
  });

  it('matches one chain message to one placeholder, oldest first', async () => {
    const a = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    const b = `${PENDING_PLACEHOLDER_PREFIX}${T0 + 10}`;
    useMessagesStore.getState().addPendingMessage(placeholder(a, 'ok', T0));
    useMessagesStore
      .getState()
      .addPendingMessage(placeholder(b, 'ok', T0 + 10));
    useMessagesStore.getState().settlePendingMessage(a);
    useMessagesStore.getState().settlePendingMessage(b);

    mockFetchMessages.mockResolvedValue([chainSent('TX-ONE', 'ok', T0 + 5000)]);
    await load();
    // The older placeholder is resolved; the newer one stays pending.
    expect(
      thread()
        .map((m) => m.id)
        .sort()
    ).toEqual(['TX-ONE', b].sort());
    expect(thread().find((m) => m.id === b)?.status).toBe('pending');

    // A second load sees the same chain message again; it is already spent
    // (Codex pass A #4).
    await load();
    expect(thread().find((m) => m.id === b)?.status).toBe('pending');
  });

  it('ignores a chain message older than the placeholder (beyond clock skew)', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'ok'));
    useMessagesStore.getState().settlePendingMessage(tempId);

    mockFetchMessages.mockResolvedValue([
      chainSent('OLD', 'ok', T0 - 60 * 60 * 1000),
    ]);
    await load();
    expect(thread().find((m) => m.id === tempId)?.status).toBe('pending');
  });

  it('resolves at settle time when the chain message merged during the send', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));
    mockFetchMessages.mockResolvedValue([chainSent('TX2', 'hi', T0 + 5000)]);
    // A poll lands the chain record while the placeholder is still in flight
    // (not yet settled): an in-flight placeholder is never matched.
    await load();
    expect(
      thread()
        .map((m) => m.id)
        .sort()
    ).toEqual(['TX2', tempId].sort());

    useMessagesStore.getState().settlePendingMessage(tempId);
    expect(thread()).toEqual([expect.objectContaining({ id: 'TX2' })]);
  });

  it('ages out an unmatched txid-less placeholder once it can no longer land', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));
    useMessagesStore.getState().settlePendingMessage(tempId);

    now.mockReturnValue(T0 + PENDING_PLACEHOLDER_TTL_MS);
    await load();
    expect(thread().find((m) => m.id === tempId)?.status).toBe('pending');

    now.mockReturnValue(T0 + PENDING_PLACEHOLDER_TTL_MS + 1);
    await load();
    expect(thread().find((m) => m.id === tempId)).toBeUndefined();
  });

  it('never ages out a txid-keyed pending message on a timer', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));
    useMessagesStore.getState().settlePendingMessage(tempId, 'TX3');

    now.mockReturnValue(T0 + 10 * PENDING_PLACEHOLDER_TTL_MS);
    await load();
    expect(thread()).toEqual([
      expect.objectContaining({ id: 'TX3', status: 'pending' }),
    ]);
  });

  // The poll only returns threads with new messages, so it must also age out
  // a placeholder in a quiet thread, or an open chat would spin until reopened.
  it('the poll ages out a placeholder in a thread with no new messages', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));
    useMessagesStore.getState().settlePendingMessage(tempId);
    mockFetchAllConversations.mockResolvedValue({
      conversations: new Map(),
      complete: true,
      maxId: null,
    });

    await useMessagesStore.getState().fetchAllThreads(USER);
    expect(thread().find((m) => m.id === tempId)?.status).toBe('pending');

    now.mockReturnValue(T0 + PENDING_PLACEHOLDER_TTL_MS + 1);
    await useMessagesStore.getState().fetchAllThreads(USER);
    expect(useMessagesStore.getState().threads[FRIEND]).toBeUndefined();
  });

  // Codex pass A #3: a retry is a new attempt, aged from when it started.
  it('ages a retried placeholder from its new attempt, not the old bubble', async () => {
    const old = T0 - 3 * 60 * 60 * 1000;
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${old}`;
    useMessagesStore.getState().addPendingMessage({
      ...placeholder(tempId, 'retry me', old),
      status: 'failed',
    });
    useMessagesStore.getState().settlePendingMessage(tempId, undefined, {
      attemptedAt: T0,
      excludeIds: [],
    });

    await load();
    expect(thread().find((m) => m.id === tempId)?.status).toBe('pending');

    // A same-content send that confirmed between the attempts doesn't match.
    mockFetchMessages.mockResolvedValue([
      chainSent('TX-BETWEEN', 'retry me', old + 60 * 60 * 1000),
    ]);
    await load();
    expect(thread().find((m) => m.id === tempId)?.status).toBe('pending');
  });

  // Codex pass A #2: placeholders are memory-only, so storage never holds a
  // spinner that a restart could reload and nothing could resolve.
  it('never stores a pending placeholder, and strips one stored by an older build', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    mockFetchMessages.mockResolvedValue([
      chainSent('TX-KEEP', 'kept', T0 - 5000),
    ]);
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));
    await load(); // persists while the send is in flight
    useMessagesStore.getState().settlePendingMessage(tempId);
    await load();

    const stored = JSON.parse(
      (await AsyncStorage.getItem(`@messages/${USER}`)) ?? '{}'
    );
    expect(stored[FRIEND].messages.map((m: Message) => m.id)).toEqual([
      'TX-KEEP',
    ]);

    await AsyncStorage.setItem(
      `@messages/${USER}`,
      JSON.stringify({
        [FRIEND]: {
          ...stored[FRIEND],
          messages: [
            ...stored[FRIEND].messages,
            placeholder('pending-legacy', 'x'),
          ],
        },
      })
    );
    useMessagesStore.setState({
      threads: {},
      currentUserAddress: null as never,
    });
    await useMessagesStore.getState().loadCachedThreads(USER);
    expect(thread().map((m) => m.id)).toEqual(['TX-KEEP']);
  });

  it('keeps a failed placeholder in storage, so its retry survives a restart', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore
      .getState()
      .addPendingMessage({ ...placeholder(tempId, 'oops'), status: 'failed' });
    await load();
    const stored = JSON.parse(
      (await AsyncStorage.getItem(`@messages/${USER}`)) ?? '{}'
    );
    expect(stored[FRIEND].messages.map((m: Message) => m.id)).toEqual([tempId]);
  });

  // Codex pass A #1: an open chat expires locally, without a fetch.
  it('expires an unsettled placeholder locally, with no network call', () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));
    useMessagesStore.getState().settlePendingMessage(tempId, undefined, {
      attemptedAt: T0,
      excludeIds: [],
    });

    useMessagesStore.getState().expireUnsettledPlaceholders(FRIEND);
    expect(thread().find((m) => m.id === tempId)?.status).toBe('pending');

    now.mockReturnValue(T0 + PENDING_PLACEHOLDER_TTL_MS + 1);
    useMessagesStore.getState().expireUnsettledPlaceholders(FRIEND);
    expect(useMessagesStore.getState().threads[FRIEND]).toBeUndefined();
    expect(mockFetchMessages).not.toHaveBeenCalled();
  });

  // Codex pass B #3: a send already known when this attempt started (an
  // earlier same-text send, or a txid-known one confirming later) never
  // resolves it.
  it('never resolves against a send known when the attempt started', async () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'ok'));
    useMessagesStore.getState().settlePendingMessage(tempId, undefined, {
      attemptedAt: T0,
      excludeIds: ['KNOWN-TX'],
    });

    mockFetchMessages.mockResolvedValue([
      chainSent('KNOWN-TX', 'ok', T0 + 5000),
    ]);
    await load();
    expect(thread().find((m) => m.id === tempId)?.status).toBe('pending');

    mockFetchMessages.mockResolvedValue([
      chainSent('KNOWN-TX', 'ok', T0 + 5000),
      chainSent('NEW-TX', 'ok', T0 + 6000),
    ]);
    await load();
    expect(thread().find((m) => m.id === tempId)).toBeUndefined();
  });

  // Codex pass B #5: spent-once state lives on the rows, so the same chain
  // fixture behaves identically in a fresh run.
  it('resolves the same fixture again from a clean store', async () => {
    for (let run = 0; run < 2; run++) {
      useMessagesStore.setState({ threads: {}, currentUserAddress: USER });
      const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
      useMessagesStore
        .getState()
        .addPendingMessage(placeholder(tempId, 'same'));
      useMessagesStore.getState().settlePendingMessage(tempId);
      mockFetchMessages.mockResolvedValue([
        chainSent('SAME-FIXTURE', 'same', T0 + 5000),
      ]);
      await load();
      expect(thread().map((m) => m.id)).toEqual(['SAME-FIXTURE']);
    }
  });

  // Codex pass B #2: a genuine failure from another attempt must not turn an
  // unsettled row back into a retryable 'failed' one.
  it('never fails a row another attempt left unsettled', () => {
    const tempId = `${PENDING_PLACEHOLDER_PREFIX}${T0}`;
    useMessagesStore.getState().addPendingMessage(placeholder(tempId, 'hi'));
    useMessagesStore.getState().settlePendingMessage(tempId);

    useMessagesStore.getState().failPendingMessage(tempId);
    expect(thread()[0]).toEqual(
      expect.objectContaining({ status: 'pending', unsettled: true })
    );

    const other = `${PENDING_PLACEHOLDER_PREFIX}${T0 + 1}`;
    useMessagesStore.getState().addPendingMessage(placeholder(other, 'x'));
    useMessagesStore.getState().failPendingMessage(other);
    expect(thread().find((m) => m.id === other)?.status).toBe('failed');
  });
});
