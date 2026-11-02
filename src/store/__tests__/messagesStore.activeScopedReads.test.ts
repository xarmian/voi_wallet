/**
 * Thread read selectors show only the wallet's active account's threads
 * (TASK-464): after a switch to an account that can't fetch, the previous
 * account's in-memory threads must not render.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/services/messaging', () => ({
  __esModule: true,
  default: { clearKeyCache: jest.fn() },
}));
jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: { isUnlocked: () => true },
}));

jest.mock('@/store/walletStore', () => {
  const { create } = require('zustand');
  return { useWalletStore: create(() => ({ wallet: null })) };
});

import { act, renderHook } from '@testing-library/react-native';
import {
  useMessagesStore,
  useIsThreadHidden,
  useSortedThreads,
  useThread,
  useTotalUnreadCount,
} from '@/store/messagesStore';
import { useWalletStore } from '@/store/walletStore';
import type { MessageThread } from '@/services/messaging/types';

const A = 'ACCOUNTA';
const B = 'ACCOUNTB';
const FRIEND = 'FRIENDOFA';

const thread = (): MessageThread =>
  ({
    friendAddress: FRIEND,
    messages: [],
    unreadCount: 3,
    lastMessageTimestamp: 1,
  }) as unknown as MessageThread;

const setActive = (address: string) =>
  (useWalletStore as any).setState({
    wallet: {
      activeAccountId: address,
      accounts: [
        { id: A, address: A },
        { id: B, address: B },
      ],
    },
  });

describe('messagesStore read selectors follow the active account (TASK-464)', () => {
  beforeEach(() => {
    setActive(A);
    useMessagesStore.setState({
      currentUserAddress: A,
      threads: { [FRIEND]: thread() },
    });
  });

  it('shows the owner account threads while it is active', async () => {
    expect(
      (await renderHook(() => useThread(FRIEND))).result.current
    ).not.toBeNull();
    expect(
      (await renderHook(() => useSortedThreads())).result.current
    ).toHaveLength(1);
    expect((await renderHook(() => useTotalUnreadCount())).result.current).toBe(
      3
    );
  });

  it('renders nothing for threads owned by a non-active account, and re-renders on the switch', async () => {
    const thr = await renderHook(() => useThread(FRIEND));
    const sorted = await renderHook(() => useSortedThreads());
    const unread = await renderHook(() => useTotalUnreadCount());

    await act(async () => setActive(B));

    expect(thr.result.current).toBeNull();
    expect(sorted.result.current).toEqual([]);
    expect(unread.result.current).toBe(0);

    await act(async () => setActive(A));
    expect(thr.result.current).not.toBeNull();
  });

  it('renders nothing when the wallet has no active account', async () => {
    (useWalletStore as any).setState({ wallet: null });
    expect(
      (await renderHook(() => useThread(FRIEND))).result.current
    ).toBeNull();
  });

  it('reports a thread hidden only while its owner account is active', async () => {
    useMessagesStore.setState({ hiddenThreads: new Set([FRIEND]) });
    const hidden = await renderHook(() => useIsThreadHidden(FRIEND));
    expect(hidden.result.current).toBe(true);

    await act(async () => setActive(B));
    expect(hidden.result.current).toBe(false);
  });
});
