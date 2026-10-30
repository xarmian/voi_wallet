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

    mockFetchMessages.mockResolvedValue([chainSent('TX1', 'ok', T0 + 5000)]);
    await load();
    // The older placeholder is resolved; the newer one stays pending.
    expect(
      thread()
        .map((m) => m.id)
        .sort()
    ).toEqual(['TX1', b].sort());
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
});
