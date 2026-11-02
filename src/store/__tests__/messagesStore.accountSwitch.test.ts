/**
 * A load or fetch for one account never merges into, persists over, or
 * re-installs itself over another account's state (TASK-460).
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockFetchMessages = jest.fn();
const mockIsKeyRegistered = jest.fn();
const mockFetchAllConversations = jest.fn();
const mockRegisterKey = jest.fn();
jest.mock('@/services/messaging', () => ({
  __esModule: true,
  default: {
    deriveMessagingKeyPair: jest.fn(async () => ({})),
    isKeyRegistered: (...args: unknown[]) => mockIsKeyRegistered(...args),
    fetchMessages: (...args: unknown[]) => mockFetchMessages(...args),
    fetchAllConversations: (...args: unknown[]) =>
      mockFetchAllConversations(...args),
    registerKey: (...args: unknown[]) => mockRegisterKey(...args),
    clearKeyCache: jest.fn(),
  },
}));
jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: { isUnlocked: () => true },
}));

// The wallet's active account: the store adopts only this one (TASK-462).
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

// Holds the first write of `key` until `until` resolves; `reached` resolves
// once that write has started.
function holdWriteOf(
  key: string,
  until: Promise<void>
): { reached: Promise<void>; restore: () => void } {
  const setItem = AsyncStorage.setItem as jest.Mock;
  const real = setItem.getMockImplementation()!;
  const reached = deferred<void>();
  let held = false;
  setItem.mockImplementation(async (k: string, ...rest: unknown[]) => {
    if (k === key && !held) {
      held = true;
      reached.resolve();
      await until;
    }
    return real(k, ...rest);
  });
  return {
    reached: reached.promise,
    restore: () => setItem.mockImplementation(real),
  };
}

const CURSOR_KEY = `@messages/committedid/${A}`;
const drain = (maxId: number, messages: Message[]) => ({
  conversations: new Map([[FA, messages]]),
  complete: true,
  maxId,
});

const store = () => useMessagesStore.getState();
const activate = (address: string) => {
  mockActiveAddress = address;
};
// The user switches to an account: it becomes active, then the store loads it.
const switchTo = (address: string) => {
  activate(address);
  return store().loadCachedThreads(address);
};
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
    mockActiveAddress = null;
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
    mockFetchAllConversations.mockReset().mockResolvedValue({
      conversations: new Map(),
      complete: true,
      maxId: null,
    });
  });

  // The task's probe: start A's fetch, switch to B, then resolve A's response.
  it("drops A's thread fetch that resolves after the switch to B", async () => {
    await switchTo(A);
    const aResponse = deferred<Message[]>();
    mockFetchMessages.mockReturnValueOnce(aResponse.promise);
    activate(A);
    const aFetch = store().fetchThreadMessages(A, FA);
    await flush();

    await switchTo(B);
    aResponse.resolve([msg('A-NEW', FA)]);
    await aFetch;

    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds()).toEqual(['B-OLD']);
    expect(await storedIds(A)).toEqual(['A-OLD']);
    expect(await storedIds(B)).toEqual(['B-OLD']);
  });

  // No race at all: the store holds A and a chat for B opens directly.
  it("loads B's own cache before merging B's thread, never A's map", async () => {
    await switchTo(A);
    mockFetchMessages.mockResolvedValueOnce([msg('B-NEW', FB, 2000)]);

    activate(B);
    await store().fetchThreadMessages(B, FB);

    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds().sort()).toEqual(['B-NEW', 'B-OLD']);
    expect((await storedIds(B)).sort()).toEqual(['B-NEW', 'B-OLD']);
    expect(await storedIds(A)).toEqual(['A-OLD']);
  });

  it("drops A's older-page fetch that resolves after the switch to B", async () => {
    await switchTo(A);
    const aPage = deferred<Message[]>();
    mockFetchMessages.mockReturnValueOnce(aPage.promise);
    const aFetch = store().fetchOlderMessages(A, FA, 100);
    await flush();

    await switchTo(B);
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
      const aLoad = switchTo(A);
      await switchTo(B);
      aRead.resolve();
      await aLoad;
    } finally {
      restore();
    }

    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds()).toEqual(['B-OLD']);
  });

  it("does not let A's poll tick supersede a pending adoption of B (TASK-462)", async () => {
    jest.useFakeTimers();
    await switchTo(A);
    store().startPolling(A, 1000);
    const bRead = deferred<void>();
    const restore = holdReadOf(`@messages/${B}`, bRead.promise);
    const bLoad = switchTo(B);
    await Promise.resolve();
    try {
      jest.advanceTimersByTime(1000);
      expect(mockFetchAllConversations).not.toHaveBeenCalled();
      bRead.resolve();
      await bLoad;
    } finally {
      restore();
      store().stopPolling();
      jest.useRealTimers();
    }
    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds()).toEqual(['B-OLD']);
  });

  it('marks read only for the adopted account and persists the matching account (TASK-462)', async () => {
    await switchTo(A);
    const unread = threadOf(FA, [msg('A-OLD', FA)]);
    unread.unreadCount = 4;
    useMessagesStore.setState({ threads: { [FA]: unread } });
    await AsyncStorage.setItem(
      `@messages/${A}`,
      JSON.stringify({ [FA]: unread })
    );
    const before = await AsyncStorage.getItem(`@messages/${A}`);

    await store().markThreadAsRead(FA, B);
    expect(store().threads[FA].unreadCount).toBe(4);
    expect(await AsyncStorage.getItem(`@messages/${A}`)).toBe(before);

    await store().markThreadAsRead(FA, A);
    expect(store().threads[FA].unreadCount).toBe(0);
    const persisted = JSON.parse(
      (await AsyncStorage.getItem(`@messages/${A}`))!
    );
    expect(persisted[FA].unreadCount).toBe(0);
  });

  it('does not re-install an account whose load was in flight at clearCache', async () => {
    const aRead = deferred<void>();
    const restore = holdReadOf(`@messages/${A}`, aRead.promise);
    try {
      const aLoad = switchTo(A);
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
    await switchTo(A);
    const aResponse = deferred<Message[]>();
    mockFetchMessages.mockReturnValueOnce(aResponse.promise);
    activate(A);
    const aFetch = store().fetchThreadMessages(A, FA);
    await flush();

    await switchTo(B);
    await switchTo(A);
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
    await switchTo(A);
    const aCheck = deferred<boolean>();
    mockIsKeyRegistered.mockReturnValueOnce(aCheck.promise);
    const aSync = store().fetchAllThreads(A);
    await flush();

    await switchTo(B);
    mockIsKeyRegistered.mockResolvedValueOnce(false);
    await store().checkKeyRegistration(B);
    aCheck.resolve(true);
    await aSync;

    expect(store().currentUserAddress).toBe(B);
    expect(store().isKeyRegistered).toBe(false);
  });
  // Codex pass A #1: the rows were written, then cleared, so the cursor must
  // not be written after them.
  it('writes no durable cursor when clearCache lands while the rows persist', async () => {
    await switchTo(A);
    mockFetchAllConversations.mockResolvedValueOnce(
      drain(500, [msg('A-NEW', FA, 2000)])
    );
    const rowsWrite = deferred<void>();
    const hold = holdWriteOf(`@messages/${A}`, rowsWrite.promise);
    try {
      const sync = store().fetchAllThreads(A);
      await hold.reached;
      await store().clearCache();
      rowsWrite.resolve();
      await sync;
    } finally {
      hold.restore();
    }

    expect(await AsyncStorage.getItem(CURSOR_KEY)).toBeNull();
  });

  // Codex pass A #5: a drain from cursor 100 that lands after a clear and
  // reload of A is not the whole range above A's new cursor.
  it('drops a drain whose starting cursor moved under it (clear, then reload A)', async () => {
    await AsyncStorage.setItem(CURSOR_KEY, JSON.stringify(100));
    await switchTo(A);
    expect(store().committedId).toBe(100);
    const response = deferred<ReturnType<typeof drain>>();
    mockFetchAllConversations.mockReturnValueOnce(response.promise);
    const sync = store().fetchAllThreads(A);
    await flush();

    await store().clearCache();
    await switchTo(A);
    response.resolve(drain(500, [msg('A-NEW', FA, 2000)]));
    await sync;

    expect(store().committedId).toBeNull();
    expect(await AsyncStorage.getItem(CURSOR_KEY)).toBeNull();
    expect(memoryIds()).toEqual([]);
  });

  // Codex pass A #3.
  it('clears isLoading when its fetch is superseded by a plain cache load', async () => {
    await switchTo(B);
    const aRead = deferred<void>();
    const restore = holdReadOf(`@messages/${A}`, aRead.promise);
    try {
      activate(A);
      const aFetch = store().fetchThreadMessages(A, FA);
      expect(store().isLoading).toBe(true);
      await switchTo(B);
      aRead.resolve();
      await aFetch;
    } finally {
      restore();
    }

    expect(store().currentUserAddress).toBe(B);
    expect(store().isLoading).toBe(false);
  });

  it('leaves isLoading to a newer fetch that still owns it', async () => {
    await switchTo(A);
    const aResponse = deferred<Message[]>();
    const bResponse = deferred<Message[]>();
    mockFetchMessages
      .mockReturnValueOnce(aResponse.promise)
      .mockReturnValueOnce(bResponse.promise);
    activate(A);
    const aFetch = store().fetchThreadMessages(A, FA);
    await flush();
    activate(B);
    const bFetch = store().fetchThreadMessages(B, FB);
    await flush();

    aResponse.resolve([msg('A-NEW', FA)]);
    await aFetch;
    expect(store().isLoading).toBe(true);

    bResponse.resolve([]);
    await bFetch;
    expect(store().isLoading).toBe(false);
  });
  // Codex pass B #2.
  it("doesn't end a newer fetch's spinner or error when a registration settles", async () => {
    await switchTo(A);
    const registration = deferred<string>();
    mockRegisterKey.mockReturnValueOnce(
      registration.promise.then(() => Promise.reject(new Error('rejected')))
    );
    const register = store().registerMessagingKey(A);
    const response = deferred<Message[]>();
    mockFetchMessages.mockReturnValueOnce(response.promise);
    activate(A);
    const fetch = store().fetchThreadMessages(A, FA);
    await flush();

    registration.resolve('');
    await expect(register).rejects.toThrow('rejected');
    expect(store().isLoading).toBe(true);
    expect(store().lastError).toBeNull();

    response.resolve([]);
    await fetch;
    expect(store().isLoading).toBe(false);
  });

  it("doesn't let A's slow registration mark B registered after B's check", async () => {
    const registration = deferred<string>();
    mockRegisterKey.mockReturnValueOnce(registration.promise);
    const register = store().registerMessagingKey(A);
    mockIsKeyRegistered.mockResolvedValueOnce(false);
    await store().checkKeyRegistration(B);

    registration.resolve('TXID');
    await register;
    expect(store().isKeyRegistered).toBe(false);
  });
  // Codex pass C #1, and the rest of its class: every completion write.
  it("doesn't let A's failed fetch end B's spinner or set B's error", async () => {
    await switchTo(A);
    const aResponse = deferred<Message[]>();
    const bResponse = deferred<Message[]>();
    mockFetchMessages
      .mockReturnValueOnce(aResponse.promise)
      .mockReturnValueOnce(bResponse.promise);
    activate(A);
    const aFetch = store().fetchThreadMessages(A, FA);
    await flush();
    activate(B);
    const bFetch = store().fetchThreadMessages(B, FB);
    await flush();

    aResponse.resolve(Promise.reject(new Error('A failed')) as never);
    await aFetch;
    expect(store().isLoading).toBe(true);
    expect(store().lastError).toBeNull();

    bResponse.resolve([]);
    await bFetch;
    expect(store().isLoading).toBe(false);
  });

  it("clears the spinner but sets no error on B when A's fetch fails after a plain switch", async () => {
    await switchTo(A);
    const aResponse = deferred<Message[]>();
    mockFetchMessages.mockReturnValueOnce(aResponse.promise);
    activate(A);
    const aFetch = store().fetchThreadMessages(A, FA);
    await flush();

    await switchTo(B);
    aResponse.resolve(Promise.reject(new Error('A failed')) as never);
    await aFetch;

    expect(store().currentUserAddress).toBe(B);
    expect(store().isLoading).toBe(false);
    expect(store().lastError).toBeNull();
  });

  it("still reports a fetch's own failure on its own account", async () => {
    await switchTo(A);
    mockFetchMessages.mockRejectedValueOnce(new Error('A failed'));

    activate(A);
    await store().fetchThreadMessages(A, FA);

    expect(store().isLoading).toBe(false);
    expect(store().lastError).toBe('A failed');
  });

  it("doesn't let an older same-account fetch's success end a newer one's spinner", async () => {
    await switchTo(A);
    const first = deferred<Message[]>();
    const second = deferred<Message[]>();
    mockFetchMessages
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    activate(A);
    const older = store().fetchThreadMessages(A, FA);
    await flush();
    activate(A);
    const newer = store().fetchThreadMessages(A, FA);
    await flush();

    first.resolve([msg('A-NEW', FA, 2000)]);
    await older;
    expect(store().isLoading).toBe(true);

    second.resolve([]);
    await newer;
    expect(store().isLoading).toBe(false);
  });
  // Codex pass D #1: no newer check, just a switch.
  it("doesn't let A's check land on B after a switch with no newer check", async () => {
    await switchTo(A);
    const aCheck = deferred<boolean>();
    mockIsKeyRegistered.mockReturnValueOnce(aCheck.promise);
    const check = store().checkKeyRegistration(A);

    await switchTo(B);
    aCheck.resolve(true);
    await expect(check).resolves.toBe(true);

    expect(store().isKeyRegistered).toBe(false);
  });

  it("doesn't let A's registration mark B registered after a switch", async () => {
    await switchTo(A);
    const registration = deferred<string>();
    mockRegisterKey.mockReturnValueOnce(registration.promise);
    const register = store().registerMessagingKey(A);

    await switchTo(B);
    registration.resolve('TXID');
    await register;

    expect(store().isKeyRegistered).toBe(false);
  });

  // The inbox checks an unregistered account while the store still holds the
  // previous one (it never syncs it); that result must land.
  it("lands B's check while the store still holds A", async () => {
    await switchTo(A);
    useMessagesStore.setState({ isKeyRegistered: true });
    mockIsKeyRegistered.mockResolvedValueOnce(false);

    await store().checkKeyRegistration(B);

    expect(store().currentUserAddress).toBe(A);
    expect(store().isKeyRegistered).toBe(false);
  });

  it('lands a check for the account a switch installed while it was pending', async () => {
    await switchTo(A);
    const bCheck = deferred<boolean>();
    mockIsKeyRegistered.mockReturnValueOnce(bCheck.promise);
    const check = store().checkKeyRegistration(B);

    await switchTo(B);
    bCheck.resolve(true);
    await check;

    expect(store().isKeyRegistered).toBe(true);
  });

  // TASK-462: the store adopts only the wallet's active account, so stale
  // screen work for A can neither install A nor cancel the pending switch to B.
  it('refuses a stale call for a non-active account without cancelling a pending switch', async () => {
    await switchTo(A);
    const bRead = deferred<void>();
    const restore = holdReadOf(`@messages/${B}`, bRead.promise);
    try {
      const bLoad = switchTo(B);
      await store().loadCachedThreads(A);
      await store().fetchThreadMessages(A, FA);
      expect(store().currentUserAddress).toBe(A);
      bRead.resolve();
      await bLoad;
    } finally {
      restore();
    }

    expect(mockFetchMessages).not.toHaveBeenCalled();
    expect(store().currentUserAddress).toBe(B);
    expect(memoryIds()).toEqual(['B-OLD']);
    expect(store().isLoading).toBe(false);
  });

  it('refuses a load that lands after its account stopped being active', async () => {
    const aRead = deferred<void>();
    const restore = holdReadOf(`@messages/${A}`, aRead.promise);
    try {
      const aLoad = switchTo(A);
      activate(B);
      aRead.resolve();
      await aLoad;
    } finally {
      restore();
    }

    expect(store().currentUserAddress).toBeNull();
    expect(memoryIds()).toEqual([]);
  });
});
