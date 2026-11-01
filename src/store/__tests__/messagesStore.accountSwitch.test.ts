/**
 * A load or fetch for one account never merges into, persists over, or
 * re-installs itself over another account's state (TASK-460).
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockFetchMessages = jest.fn();
const mockIsKeyRegistered = jest.fn();
jest.mock('@/services/messaging', () => ({
  __esModule: true,
  default: {
    deriveMessagingKeyPair: jest.fn(async () => ({})),
    isKeyRegistered: (...args: unknown[]) => mockIsKeyRegistered(...args),
    fetchMessages: (...args: unknown[]) => mockFetchMessages(...args),
    fetchAllConversations: jest.fn(async () => ({
      conversations: new Map(),
      complete: true,
      maxId: null,
    })),
    clearKeyCache: jest.fn(),
  },
}));
jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: { isUnlocked: () => true },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useMessagesStore } from '@/store/messagesStore';
import type { Message, MessageThread } from '@/services/messaging/types';

const A = 'ACCOUNTA';
const B = 'ACCOUNTB';
const FA = 'FRIENDOFA';
const FB = 'FRIENDOFB';

const msg = (id: string, threadId: string, timestamp = 1000): Message => ({
  id,
  threadId,
  direction: 'received',
  content: id,
  timestamp,
  status: 'confirmed',
  fee: 1000,
  confirmedRound: 7,
});

const threadOf = (friend: string, messages: Message[]): MessageThread => ({
  friendAddress: friend,
  messages,
  lastMessage: messages[messages.length - 1],
  lastMessageTimestamp: messages[messages.length - 1].timestamp,
  unreadCount: 0,
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// The async-storage mock's getItem is itself a jest.fn, so wrap its own
// implementation rather than spying (a spy would call back into itself).
function holdReadOf(key: string, until: Promise<void>): () => void {
  const getItem = AsyncStorage.getItem as jest.Mock;
  const real = getItem.getMockImplementation()!;
  getItem.mockImplementation(async (k: string, ...rest: unknown[]) => {
    if (k === key) await until;
    return real(k, ...rest);
  });
  return () => getItem.mockImplementation(real);
}

const store = () => useMessagesStore.getState();
const stored = async (account: string) =>
  JSON.parse((await AsyncStorage.getItem(`@messages/${account}`)) ?? '{}');
const storedIds = async (account: string) =>
  Object.values(await stored(account)).flatMap((t) =>
    (t as MessageThread).messages.map((m) => m.id)
  );
const memoryIds = () =>
  Object.values(store().threads).flatMap((t) => t.messages.map((m) => m.id));
const flush = () => new Promise((r) => setImmediate(r));

describe('messagesStore account switches (TASK-460)', () => {
  beforeEach(async () => {
    await store().clearCache();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(
      `@messages/${A}`,
      JSON.stringify({ [FA]: threadOf(FA, [msg('A-OLD', FA)]) })
    );
    await AsyncStorage.setItem(
      `@messages/${B}`,
      JSON.stringify({ [FB]: threadOf(FB, [msg('B-OLD', FB)]) })
    );
    useMessagesStore.setState({ isLoading: false, isKeyRegistered: false });
    mockFetchMessages.mockReset().mockResolvedValue([]);
    mockIsKeyRegistered.mockReset().mockResolvedValue(true);
  });

  // The task's probe: start A's fetch, switch to B, then resolve A's response.
  it("drops A's thread fetch that resolves after the switch to B", async () => {
    await store().loadCachedThreads(A);
    const aResponse = deferred<Message[]>();
    mockFetchMessages.mockReturnValueOnce(aResponse.promise);
    const aFetch = store().fetchThreadMessages(A, FA);
    await flush();

    await store().loadCachedThreads(B);
    aResponse.resolve([msg('A-NEW', FA)]);
    await aFetch;

    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds()).toEqual(['B-OLD']);
    expect(await storedIds(A)).toEqual(['A-OLD']);
    expect(await storedIds(B)).toEqual(['B-OLD']);
  });

  // No race at all: the store holds A and a chat for B opens directly.
  it("loads B's own cache before merging B's thread, never A's map", async () => {
    await store().loadCachedThreads(A);
    mockFetchMessages.mockResolvedValueOnce([msg('B-NEW', FB, 2000)]);

    await store().fetchThreadMessages(B, FB);

    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds().sort()).toEqual(['B-NEW', 'B-OLD']);
    expect((await storedIds(B)).sort()).toEqual(['B-NEW', 'B-OLD']);
    expect(await storedIds(A)).toEqual(['A-OLD']);
  });

  it("drops A's older-page fetch that resolves after the switch to B", async () => {
    await store().loadCachedThreads(A);
    const aPage = deferred<Message[]>();
    mockFetchMessages.mockReturnValueOnce(aPage.promise);
    const aFetch = store().fetchOlderMessages(A, FA, 100);
    await flush();

    await store().loadCachedThreads(B);
    aPage.resolve([msg('A-PAGE', FA, 10)]);
    await aFetch;

    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds()).toEqual(['B-OLD']);
    expect(await storedIds(A)).toEqual(['A-OLD']);
    expect(await storedIds(B)).toEqual(['B-OLD']);
  });

  it("does not install A's slow cache load over the later switch to B", async () => {
    const aRead = deferred<void>();
    const restore = holdReadOf(`@messages/${A}`, aRead.promise);
    try {
      const aLoad = store().loadCachedThreads(A);
      await store().loadCachedThreads(B);
      aRead.resolve();
      await aLoad;
    } finally {
      restore();
    }

    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds()).toEqual(['B-OLD']);
  });

  it('does not re-install an account whose load was in flight at clearCache', async () => {
    const aRead = deferred<void>();
    const restore = holdReadOf(`@messages/${A}`, aRead.promise);
    try {
      const aLoad = store().loadCachedThreads(A);
      await store().clearCache();
      aRead.resolve();
      await aLoad;
    } finally {
      restore();
    }

    expect(store().currentUserAddress).toBeNull();
    expect(store().threads).toEqual({});
  });

  // A→B→A: the stale completion is A's data landing on A's own map, which is
  // correct, so it is kept rather than dropped.
  it("keeps A's fetch that resolves after a switch to B and back to A", async () => {
    await store().loadCachedThreads(A);
    const aResponse = deferred<Message[]>();
    mockFetchMessages.mockReturnValueOnce(aResponse.promise);
    const aFetch = store().fetchThreadMessages(A, FA);
    await flush();

    await store().loadCachedThreads(B);
    await store().loadCachedThreads(A);
    aResponse.resolve([msg('A-NEW', FA, 2000)]);
    await aFetch;

    expect(store().currentUserAddress).toBe(A);
    expect(memoryIds().sort()).toEqual(['A-NEW', 'A-OLD']);
    expect((await storedIds(A)).sort()).toEqual(['A-NEW', 'A-OLD']);
    expect(await storedIds(B)).toEqual(['B-OLD']);
  });

  it("keeps B's registration flag when A's slower check resolves last", async () => {
    const aCheck = deferred<boolean>();
    mockIsKeyRegistered
      .mockReturnValueOnce(aCheck.promise)
      .mockResolvedValueOnce(false);

    const first = store().checkKeyRegistration(A);
    await store().checkKeyRegistration(B);
    aCheck.resolve(true);

    await expect(first).resolves.toBe(true);
    expect(store().isKeyRegistered).toBe(false);
  });

  it("does not let A's thread sync write B's registration flag", async () => {
    await store().loadCachedThreads(A);
    const aCheck = deferred<boolean>();
    mockIsKeyRegistered.mockReturnValueOnce(aCheck.promise);
    const aSync = store().fetchAllThreads(A);
    await flush();

    await store().loadCachedThreads(B);
    mockIsKeyRegistered.mockResolvedValueOnce(false);
    await store().checkKeyRegistration(B);
    aCheck.resolve(true);
    await aSync;

    expect(store().currentUserAddress).toBe(B);
    expect(store().isKeyRegistered).toBe(false);
  });
});
