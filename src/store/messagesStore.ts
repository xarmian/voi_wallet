/**
 * Messages Store
 *
 * Zustand store for managing E2E encrypted messaging state.
 * Handles message threads, caching, and polling for new messages.
 *
 * V2: Uses signature-derived encryption. The messaging keypair is derived
 * once per session from signing a challenge message.
 *
 * Message fetching uses MIMIR for efficient queries. Push notifications
 * trigger message refresh when the app is open.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Message,
  MessageThread,
  MessageStatus,
  MessagingKeyPair,
} from '@/services/messaging/types';
import MessagingService from '@/services/messaging';
import { computeSyncCursor } from '@/services/messaging/syncCursor';
import { useFriendsStore } from './friendsStore';

const STORAGE_KEY_PREFIX = '@messages/';
const HIDDEN_THREADS_STORAGE_KEY_PREFIX = '@messages/hidden/';
// Durable committed sync cursor (MIMIR ingestion id), persisted separately from
// message rows so it is NEVER recomputed forward from persisted data.
const COMMITTED_ID_STORAGE_KEY_PREFIX = '@messages/committedid/';

const POLLING_INTERVAL_MS = 30000; // 30 seconds (used when chat is open)

// Page size for conversation fetches. A full sync pulls the newest window of
// this many messages; incremental polls drain every page in the new range.
const CONVERSATION_FETCH_LIMIT = 100;

// Addresses with a fetchAllThreads currently in flight. Concurrent fetches for
// the SAME account (e.g. a focus fetch overlapping a poll or pull-to-refresh)
// are coalesced so two bootstraps can't each commit a different newest window
// and skip the gap between them.
const inFlightThreadFetches = new Set<string>();

// Helper to get storage key for a specific account
const getStorageKey = (userAddress: string) =>
  `${STORAGE_KEY_PREFIX}${userAddress}`;
const getHiddenStorageKey = (userAddress: string) =>
  `${HIDDEN_THREADS_STORAGE_KEY_PREFIX}${userAddress}`;
const getCommittedIdStorageKey = (userAddress: string) =>
  `${COMMITTED_ID_STORAGE_KEY_PREFIX}${userAddress}`;

interface MessagesState {
  // State
  threads: Record<string, MessageThread>;
  currentUserAddress: string | null; // Track which account these threads belong to
  isLoading: boolean;
  isInitialized: boolean;
  isKeyRegistered: boolean; // Whether current user has registered messaging key
  lastError: string | null;
  pollingInterval: NodeJS.Timeout | null;
  // MIMIR ingestion id through which we have provably fetched everything.
  // Advances only when a fetch fully drains its range; persisted separately (see
  // computeSyncCursor) so it is never recomputed forward from held rows. Used as
  // the incremental `afterId` (query `id > committedId`).
  committedId: number | null;
  hiddenThreads: Set<string>; // Set of hidden friend addresses
  showHiddenThreads: boolean; // Toggle to show hidden threads in the list

  // Computed getters
  getTotalUnreadCount: () => number;
  getThread: (friendAddress: string) => MessageThread | null;
  getSortedThreads: () => MessageThread[];

  // Actions
  initialize: () => Promise<void>;
  addMessage: (message: Message) => void;
  addPendingMessage: (message: Message) => void;
  removePendingMessage: (tempId: string) => void;
  updateMessageStatus: (txId: string, status: MessageStatus) => void;
  markThreadAsRead: (friendAddress: string) => Promise<void>;

  // Hidden threads
  hideThread: (friendAddress: string) => Promise<void>;
  unhideThread: (friendAddress: string) => Promise<void>;
  toggleShowHiddenThreads: () => void;

  // Key registration
  checkKeyRegistration: (userAddress: string) => Promise<boolean>;
  registerMessagingKey: (userAddress: string, pin?: string) => Promise<string>;

  // Fetch operations
  loadCachedThreads: (userAddress: string) => Promise<void>;
  fetchThreadMessages: (
    userAddress: string,
    friendAddress: string,
    pin?: string
  ) => Promise<void>;
  fetchOlderMessages: (
    userAddress: string,
    friendAddress: string,
    beforeRound: number,
    pin?: string
  ) => Promise<{ hasMore: boolean }>;
  fetchAllThreads: (userAddress: string, pin?: string) => Promise<void>;

  // Polling
  startPolling: (userAddress: string, intervalMs?: number) => void;
  stopPolling: () => void;

  // Utilities
  clearError: () => void;
  clearCache: () => Promise<void>;
}

export const useMessagesStore = create<MessagesState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    threads: {},
    currentUserAddress: null,
    isLoading: false,
    isInitialized: false,
    isKeyRegistered: false,
    lastError: null,
    pollingInterval: null,
    committedId: null,
    hiddenThreads: new Set<string>(),
    showHiddenThreads: false,

    /**
     * Get total count of unread messages across all threads
     */
    getTotalUnreadCount: () => {
      const { threads } = get();
      return Object.values(threads).reduce(
        (sum, thread) => sum + thread.unreadCount,
        0
      );
    },

    /**
     * Get a specific thread by friend address
     */
    getThread: (friendAddress: string) => {
      return get().threads[friendAddress] || null;
    },

    /**
     * Get all threads sorted by most recent message
     * Filters out hidden threads unless showHiddenThreads is true
     */
    getSortedThreads: () => {
      const { threads, hiddenThreads, showHiddenThreads } = get();
      return Object.values(threads)
        .filter(
          (thread) =>
            showHiddenThreads || !hiddenThreads.has(thread.friendAddress)
        )
        .sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
    },

    /**
     * Initialize the store from AsyncStorage
     */
    initialize: async () => {
      // Just mark as initialized - actual data is loaded per-account in fetchAllThreads
      set({ isInitialized: true });
    },

    /**
     * Add a confirmed message to a thread
     */
    addMessage: (message: Message) => {
      const { threads } = get();
      const thread =
        threads[message.threadId] || createEmptyThread(message.threadId);

      // Check for duplicate
      if (thread.messages.some((m) => m.id === message.id)) {
        return;
      }

      // Get friend's Envoi name if available
      const friend = useFriendsStore
        .getState()
        .friends.find((f) => f.address === message.threadId);

      const updatedMessages = [...thread.messages, message].sort(
        (a, b) => a.timestamp - b.timestamp
      );

      const updatedThread: MessageThread = {
        ...thread,
        friendEnvoiName: friend?.envoiName || thread.friendEnvoiName,
        messages: updatedMessages,
        lastMessage: message,
        lastMessageTimestamp: message.timestamp,
        unreadCount:
          message.direction === 'received'
            ? thread.unreadCount + 1
            : thread.unreadCount,
      };

      set({
        threads: {
          ...threads,
          [message.threadId]: updatedThread,
        },
      });

      // Persist to storage (only if we know the current user)
      const { currentUserAddress, threads: updatedThreads } = get();
      if (currentUserAddress) {
        persistThreads(currentUserAddress, updatedThreads);
      }
    },

    /**
     * Add a pending (optimistic) message before confirmation
     */
    addPendingMessage: (message: Message) => {
      const { threads } = get();
      const thread =
        threads[message.threadId] || createEmptyThread(message.threadId);

      // Get friend's Envoi name if available
      const friend = useFriendsStore
        .getState()
        .friends.find((f) => f.address === message.threadId);

      const updatedMessages = [...thread.messages, message].sort(
        (a, b) => a.timestamp - b.timestamp
      );

      const updatedThread: MessageThread = {
        ...thread,
        friendEnvoiName: friend?.envoiName || thread.friendEnvoiName,
        messages: updatedMessages,
        lastMessage: message,
        lastMessageTimestamp: message.timestamp,
      };

      set({
        threads: {
          ...threads,
          [message.threadId]: updatedThread,
        },
      });

      // Don't persist pending messages
    },

    /**
     * Remove a pending message by ID (used when replacing with confirmed message)
     */
    removePendingMessage: (tempId: string) => {
      const { threads } = get();
      let updated = false;

      const newThreads = { ...threads };

      for (const [addr, thread] of Object.entries(newThreads)) {
        const msgIndex = thread.messages.findIndex((m) => m.id === tempId);
        if (msgIndex >= 0) {
          const newMessages = thread.messages.filter((m) => m.id !== tempId);
          const lastMsg = newMessages[newMessages.length - 1];
          newThreads[addr] = {
            ...thread,
            messages: newMessages,
            lastMessage: lastMsg,
            lastMessageTimestamp: lastMsg?.timestamp || 0,
          };
          updated = true;
          break;
        }
      }

      if (updated) {
        set({ threads: newThreads });
        // Don't persist - pending messages aren't persisted anyway
      }
    },

    /**
     * Update the status of a message (e.g., from pending to confirmed)
     */
    updateMessageStatus: (txId: string, status: MessageStatus) => {
      const { threads } = get();
      let updated = false;

      const newThreads = { ...threads };

      for (const [addr, thread] of Object.entries(newThreads)) {
        const msgIndex = thread.messages.findIndex((m) => m.id === txId);
        if (msgIndex >= 0) {
          const newMessages = [...thread.messages];
          newMessages[msgIndex] = { ...newMessages[msgIndex], status };
          newThreads[addr] = { ...thread, messages: newMessages };
          updated = true;
          break;
        }
      }

      if (updated) {
        set({ threads: newThreads });
        const { currentUserAddress } = get();
        if (currentUserAddress) {
          persistThreads(currentUserAddress, newThreads);
        }
      }
    },

    /**
     * Mark all messages in a thread as read
     */
    markThreadAsRead: async (friendAddress: string) => {
      const { threads } = get();
      const thread = threads[friendAddress];

      if (!thread || thread.unreadCount === 0) {
        return;
      }

      const updatedThread: MessageThread = {
        ...thread,
        unreadCount: 0,
      };

      set({
        threads: {
          ...threads,
          [friendAddress]: updatedThread,
        },
      });

      const { currentUserAddress, threads: updatedThreads } = get();
      if (currentUserAddress) {
        await persistThreads(currentUserAddress, updatedThreads);
      }
    },

    /**
     * Hide a conversation thread from the inbox
     */
    hideThread: async (friendAddress: string) => {
      const { hiddenThreads, currentUserAddress } = get();
      const newHidden = new Set(hiddenThreads);
      newHidden.add(friendAddress);
      set({ hiddenThreads: newHidden });
      if (currentUserAddress) {
        await persistHiddenThreads(currentUserAddress, newHidden);
      }
    },

    /**
     * Unhide a conversation thread
     */
    unhideThread: async (friendAddress: string) => {
      const { hiddenThreads, currentUserAddress } = get();
      const newHidden = new Set(hiddenThreads);
      newHidden.delete(friendAddress);
      set({ hiddenThreads: newHidden });
      if (currentUserAddress) {
        await persistHiddenThreads(currentUserAddress, newHidden);
      }
    },

    /**
     * Toggle showing hidden threads in the list
     */
    toggleShowHiddenThreads: () => {
      set({ showHiddenThreads: !get().showHiddenThreads });
    },

    /**
     * Check if the user has registered their messaging key on-chain
     */
    checkKeyRegistration: async (userAddress: string) => {
      try {
        const isRegistered =
          await MessagingService.isKeyRegistered(userAddress);
        set({ isKeyRegistered: isRegistered });
        return isRegistered;
      } catch (error) {
        console.error('Failed to check key registration:', error);
        return false;
      }
    },

    /**
     * Register the user's messaging key on-chain
     */
    registerMessagingKey: async (userAddress: string, pin?: string) => {
      try {
        set({ isLoading: true, lastError: null });
        const txId = await MessagingService.registerKey(userAddress, pin);
        set({ isKeyRegistered: true, isLoading: false });
        return txId;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        set({ lastError: message, isLoading: false });
        throw error;
      }
    },

    /**
     * Load cached threads from AsyncStorage for a specific account.
     * Call this before fetchThreadMessages when switching accounts.
     */
    loadCachedThreads: async (userAddress: string) => {
      const { currentUserAddress } = get();

      // Only load if switching to a different account
      if (currentUserAddress === userAddress) {
        return;
      }

      const storageKey = getStorageKey(userAddress);
      const storedThreadsJson = await AsyncStorage.getItem(storageKey);
      const rawStoredThreads = storedThreadsJson
        ? JSON.parse(storedThreadsJson)
        : {};

      // Also load hidden threads for the new account
      const hiddenStorageKey = getHiddenStorageKey(userAddress);
      const storedHiddenJson = await AsyncStorage.getItem(hiddenStorageKey);
      const storedHidden = storedHiddenJson
        ? new Set<string>(JSON.parse(storedHiddenJson))
        : new Set<string>();

      // Deduplicate messages for display. The durable sync cursor is loaded
      // from its own key (falling back to the greatest held ingestion id) — NOT
      // recomputed forward from these rows — so a persisted partial drain can't
      // advance it past rows we never fetched.
      const { threads: storedThreads } = deduplicateThreads(rawStoredThreads);
      const committedId = await resolveCommittedCursor(
        userAddress,
        storedThreads
      );

      set({
        threads: storedThreads,
        currentUserAddress: userAddress,
        committedId,
        hiddenThreads: storedHidden,
        showHiddenThreads: false,
      });

      // Re-persist if deduplication changed anything
      if (JSON.stringify(storedThreads) !== JSON.stringify(rawStoredThreads)) {
        await persistThreads(userAddress, storedThreads);
      }
    },

    /**
     * Fetch messages for a specific thread from the blockchain
     */
    fetchThreadMessages: async (userAddress, friendAddress, pin) => {
      try {
        set({ isLoading: true, lastError: null });

        // Derive messaging keypair (automatic for software wallets)
        const messagingKeyPair = await MessagingService.deriveMessagingKeyPair(
          userAddress,
          pin
        );

        const messages = await MessagingService.fetchMessages(
          userAddress,
          friendAddress,
          messagingKeyPair
        );

        const { threads } = get();
        const existingThread = threads[friendAddress];

        // Get friend's Envoi name if available
        const friend = useFriendsStore
          .getState()
          .friends.find((f) => f.address === friendAddress);

        // Merge with existing messages (dedupe by ID; reconcile pending->confirmed)
        const allMessages = mergeMessagesById(
          existingThread?.messages || [],
          messages
        );
        allMessages.sort((a, b) => a.timestamp - b.timestamp);

        const lastMsg = allMessages[allMessages.length - 1];

        // Only create/update thread if there are actual messages
        // This prevents empty threads from being created when navigating to a chat
        if (allMessages.length > 0) {
          set({
            threads: {
              ...threads,
              [friendAddress]: {
                friendAddress,
                friendEnvoiName: friend?.envoiName,
                messages: allMessages,
                lastMessage: lastMsg,
                lastMessageTimestamp: lastMsg?.timestamp || 0,
                unreadCount: 0, // Reset when explicitly fetching
              },
            },
            currentUserAddress: userAddress,
            isLoading: false,
          });

          await persistThreads(userAddress, get().threads);
        } else {
          set({
            currentUserAddress: userAddress,
            isLoading: false,
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        set({ lastError: message, isLoading: false });
      }
    },

    /**
     * Fetch older messages for a thread (pagination - load more when scrolling up)
     * @returns hasMore - whether there might be more messages to load
     */
    fetchOlderMessages: async (
      userAddress,
      friendAddress,
      beforeRound,
      pin
    ) => {
      try {
        // Don't set global isLoading to avoid UI flicker during pagination
        const messagingKeyPair = await MessagingService.deriveMessagingKeyPair(
          userAddress,
          pin
        );

        const messages = await MessagingService.fetchMessages(
          userAddress,
          friendAddress,
          messagingKeyPair,
          50, // limit
          undefined, // afterRound
          beforeRound // beforeRound - fetch older messages
        );

        if (messages.length === 0) {
          return { hasMore: false };
        }

        const { threads } = get();
        const existingThread = threads[friendAddress];

        // Get friend's Envoi name if available
        const friend = useFriendsStore
          .getState()
          .friends.find((f) => f.address === friendAddress);

        // Merge with existing messages (dedupe by ID; reconcile pending->confirmed)
        const allMessages = mergeMessagesById(
          existingThread?.messages || [],
          messages
        );
        allMessages.sort((a, b) => a.timestamp - b.timestamp);

        const lastMsg = allMessages[allMessages.length - 1];

        set({
          threads: {
            ...threads,
            [friendAddress]: {
              ...existingThread,
              friendAddress,
              friendEnvoiName:
                friend?.envoiName || existingThread?.friendEnvoiName,
              messages: allMessages,
              lastMessage: lastMsg,
              lastMessageTimestamp: lastMsg?.timestamp || 0,
              unreadCount: existingThread?.unreadCount || 0,
            },
          },
        });

        await persistThreads(userAddress, get().threads);

        // If we got fewer messages than the limit, there are no more
        return { hasMore: messages.length >= 50 };
      } catch (error) {
        console.error('Failed to fetch older messages:', error);
        return { hasMore: false };
      }
    },

    /**
     * Fetch all conversations from the blockchain
     */
    fetchAllThreads: async (userAddress, pin) => {
      // Coalesce concurrent fetches for the same account so overlapping
      // bootstraps can't each commit a different window and skip the gap.
      if (inFlightThreadFetches.has(userAddress)) {
        return;
      }
      inFlightThreadFetches.add(userAddress);
      try {
        set({ isLoading: true, lastError: null });

        const { currentUserAddress } = get();

        // If account changed, load from storage for the new account
        if (currentUserAddress !== userAddress) {
          const storageKey = getStorageKey(userAddress);
          const storedThreadsJson = await AsyncStorage.getItem(storageKey);
          const rawStoredThreads = storedThreadsJson
            ? JSON.parse(storedThreadsJson)
            : {};

          // Also load hidden threads for the new account
          const hiddenStorageKey = getHiddenStorageKey(userAddress);
          const storedHiddenJson = await AsyncStorage.getItem(hiddenStorageKey);
          const storedHidden = storedHiddenJson
            ? new Set<string>(JSON.parse(storedHiddenJson))
            : new Set<string>();

          // Deduplicate messages for display. The durable sync cursor is
          // loaded from its own key (falling back to the greatest held
          // ingestion id) — NOT recomputed forward from these rows — so a
          // persisted partial drain can't advance it past unfetched rows.
          const { threads: storedThreads } =
            deduplicateThreads(rawStoredThreads);
          const committedId = await resolveCommittedCursor(
            userAddress,
            storedThreads
          );

          set({
            threads: storedThreads,
            currentUserAddress: userAddress,
            committedId,
            isKeyRegistered: false, // Will be checked below
            hiddenThreads: storedHidden,
            showHiddenThreads: false, // Reset to default when switching accounts
          });

          // Re-persist if deduplication changed anything
          if (
            JSON.stringify(storedThreads) !== JSON.stringify(rawStoredThreads)
          ) {
            await persistThreads(userAddress, storedThreads);
          }
        }

        // Check key registration status
        const isRegistered =
          await MessagingService.isKeyRegistered(userAddress);
        set({ isKeyRegistered: isRegistered });

        // If not registered, can't fetch messages (need to register first)
        if (!isRegistered) {
          set({ isLoading: false });
          return;
        }

        // Derive messaging keypair (automatic for software wallets)
        const messagingKeyPair = await MessagingService.deriveMessagingKeyPair(
          userAddress,
          pin
        );

        // Sync from the committed ingestion-id cursor. Once we have committed a
        // cursor for this account, EVERY fetch (poll, focus, pull-to-refresh,
        // post-restart recovery) drains incrementally from it (`id > committedId`)
        // — never a bare newest-window fetch — so any gap between the cursor and
        // the newest window is recovered rather than skipped. An ingestion id is
        // exact/unique, so no boundary overlap is needed. When there is no
        // committed cursor yet (first sync for this account), afterId is
        // undefined and the service bootstraps from the newest window. The
        // service drains the range so a burst of more than the page limit can't
        // be truncated, and returns `complete` + `maxId` so we advance the
        // durable cursor only through a fully-drained range.
        const committed = get().committedId;
        const afterId = committed != null ? committed : undefined;

        const { conversations, complete, maxId } =
          await MessagingService.fetchAllConversations(
            userAddress,
            messagingKeyPair,
            CONVERSATION_FETCH_LIMIT,
            afterId
          );

        // The active account may have changed while this request was in flight
        // (account switch). Abandon the stale result rather than merge it into,
        // or persist its cursor over, another account's state. Everything from
        // here to the set() below runs without awaiting, so the account can't
        // change mid-writeback.
        if (get().currentUserAddress !== userAddress) {
          return;
        }

        const { threads: existingThreads } = get();
        const newThreads: Record<string, MessageThread> = {};

        for (const [friendAddress, messages] of conversations) {
          const existing = existingThreads[friendAddress];
          const friend = useFriendsStore
            .getState()
            .friends.find((f) => f.address === friendAddress);

          // Merge messages (dedupe by ID; reconcile pending->confirmed)
          const allMessages = mergeMessagesById(
            existing?.messages || [],
            messages
          );
          allMessages.sort((a, b) => a.timestamp - b.timestamp);

          const lastMsg = allMessages[allMessages.length - 1];

          // Count new received messages
          const existingUnread = existing?.unreadCount || 0;
          const newReceived = messages.filter(
            (m) =>
              m.direction === 'received' &&
              !existing?.messages.some((em) => em.id === m.id)
          ).length;

          newThreads[friendAddress] = {
            friendAddress,
            friendEnvoiName: friend?.envoiName,
            messages: allMessages,
            lastMessage: lastMsg,
            lastMessageTimestamp: lastMsg?.timestamp || 0,
            unreadCount: existingUnread + newReceived,
          };
        }

        // Preserve threads not in this fetch (they still exist)
        for (const [addr, thread] of Object.entries(existingThreads)) {
          if (!newThreads[addr]) {
            newThreads[addr] = thread;
          }
        }

        // Advance the durable committed cursor ONLY through a fully-drained
        // range, to the greatest ingestion id fetched (see computeSyncCursor).
        // A truncated drain, or the indexer fallback (maxId null), leaves the
        // cursor untouched so nothing below it is skipped.
        const previousCommitted = get().committedId;
        const nextCommitted = computeSyncCursor({
          previous: previousCommitted,
          complete,
          maxId,
        });

        set({
          threads: newThreads,
          currentUserAddress: userAddress,
          committedId: nextCommitted,
          isLoading: false,
        });

        // Persist the message rows BEFORE the cursor, and only advance the
        // durable cursor if the rows actually persisted. The cursor must never
        // be durably ahead of the rows it represents: a stale (lower) cursor
        // just re-fetches on the next sync (dedup-safe), whereas the reverse
        // would skip the just-fetched rows below the advanced cursor.
        const rowsPersisted = await persistThreads(userAddress, newThreads);
        if (rowsPersisted && nextCommitted !== previousCommitted) {
          await persistCommittedId(userAddress, nextCommitted);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        set({ lastError: message, isLoading: false });
      } finally {
        inFlightThreadFetches.delete(userAddress);
      }
    },

    /**
     * Start polling for new messages
     */
    startPolling: (userAddress, intervalMs = POLLING_INTERVAL_MS) => {
      // Stop any existing polling
      get().stopPolling();

      // Start new polling interval. fetchAllThreads drains from the committed
      // sync cursor, so once the initial sync commits a cursor, steady-state
      // polls only fetch/decrypt new messages.
      const interval = setInterval(() => {
        get().fetchAllThreads(userAddress);
      }, intervalMs);

      set({ pollingInterval: interval });
    },

    /**
     * Stop polling for new messages
     */
    stopPolling: () => {
      const { pollingInterval } = get();
      if (pollingInterval) {
        clearInterval(pollingInterval);
        set({ pollingInterval: null });
      }
    },

    /**
     * Clear the last error
     */
    clearError: () => {
      set({ lastError: null });
    },

    /**
     * Clear all cached messages for the current account
     */
    clearCache: async () => {
      get().stopPolling();
      const { currentUserAddress } = get();

      // Clear messaging key cache in the service
      MessagingService.clearKeyCache();

      set({
        threads: {},
        currentUserAddress: null,
        isInitialized: false,
        isKeyRegistered: false,
        committedId: null,
        hiddenThreads: new Set<string>(),
        showHiddenThreads: false,
      });
      if (currentUserAddress) {
        await AsyncStorage.removeItem(getStorageKey(currentUserAddress));
        await AsyncStorage.removeItem(getHiddenStorageKey(currentUserAddress));
        await AsyncStorage.removeItem(
          getCommittedIdStorageKey(currentUserAddress)
        );
      }
    },
  }))
);

/**
 * Merge chain-fetched messages into an existing list, deduplicating by ID.
 *
 * When an incoming message matches an existing one, the chain record is the
 * source of truth for confirmation state: a locally pending (or failed)
 * message is upgraded to the confirmed chain record (carrying confirmedRound).
 * This is what resolves an optimistic "pending" sent message to "confirmed"
 * on the next load — without it, the dedup would keep skipping the confirmed
 * record and the message would stay pending forever.
 */
function mergeMessagesById(
  existing: Message[],
  incoming: Message[]
): Message[] {
  const merged = [...existing];
  for (const msg of incoming) {
    const idx = merged.findIndex((m) => m.id === msg.id);
    if (idx === -1) {
      merged.push(msg);
    } else if (
      merged[idx].status !== 'confirmed' &&
      msg.status === 'confirmed'
    ) {
      merged[idx] = {
        ...merged[idx],
        status: 'confirmed',
        ...(msg.confirmedRound !== undefined
          ? { confirmedRound: msg.confirmedRound }
          : {}),
      };
    }
  }
  return merged;
}

/**
 * Create an empty thread for a new conversation
 */
function createEmptyThread(friendAddress: string): MessageThread {
  return {
    friendAddress,
    lastMessageTimestamp: 0,
    unreadCount: 0,
    messages: [],
  };
}

/**
 * Deduplicate messages (by ID) in threads loaded from storage, for display.
 * Note: this intentionally does NOT derive the durable sync cursor — that is
 * persisted separately so a partial persisted drain can't advance it forward.
 */
function deduplicateThreads(threads: Record<string, MessageThread>): {
  threads: Record<string, MessageThread>;
} {
  const deduped: Record<string, MessageThread> = {};

  for (const [friendAddress, thread] of Object.entries(threads)) {
    // Deduplicate messages by ID
    const seen = new Set<string>();
    const uniqueMessages: Message[] = [];
    for (const msg of thread.messages) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        uniqueMessages.push(msg);
      }
    }

    // Sort by timestamp
    uniqueMessages.sort((a, b) => a.timestamp - b.timestamp);
    const lastMsg = uniqueMessages[uniqueMessages.length - 1];

    deduped[friendAddress] = {
      ...thread,
      messages: uniqueMessages,
      lastMessage: lastMsg,
      lastMessageTimestamp: lastMsg?.timestamp || 0,
    };
  }

  return { threads: deduped };
}

/**
 * Persist threads to AsyncStorage for a specific account.
 * Filters out empty threads (threads with no messages) to prevent clutter.
 * Returns whether the write succeeded — the caller uses this to avoid advancing
 * the durable cursor ahead of rows that failed to persist.
 */
async function persistThreads(
  userAddress: string,
  threads: Record<string, MessageThread>
): Promise<boolean> {
  try {
    const storageKey = getStorageKey(userAddress);
    // Only persist threads that have actual messages
    const threadsToSave = Object.fromEntries(
      Object.entries(threads).filter(([, thread]) => thread.messages.length > 0)
    );
    await AsyncStorage.setItem(storageKey, JSON.stringify(threadsToSave));
    return true;
  } catch (error) {
    console.error('Failed to persist messages:', error);
    return false;
  }
}

/**
 * Resolve the durable committed sync cursor (MIMIR ingestion id) at load time.
 *
 * Prefers the explicitly-persisted cursor. If it is absent — a fresh account, a
 * crash between the row write and the (later) cursor write, or a legacy blob —
 * it falls back to the GREATEST held ingestion id rather than null. Because
 * ingestion id is monotonic, that is a safe watermark: everything with a higher
 * id (including anything that arrived during the gap) is still fetched by the
 * next `id > cursor` drain, so no message is skipped. Held rows without a
 * `sourceId` (indexer-sourced / pending) are ignored; if none have one, we fall
 * through to a bootstrap.
 */
async function resolveCommittedCursor(
  userAddress: string,
  threads: Record<string, MessageThread>
): Promise<number | null> {
  const explicit = await loadCommittedId(userAddress);
  if (explicit != null) return explicit;
  return maxSourceIdOfThreads(threads);
}

/**
 * Load the explicitly-persisted committed ingestion-id cursor, or null. Kept
 * separate from message rows so it is never recomputed forward from a persisted
 * partial drain.
 */
async function loadCommittedId(userAddress: string): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(
      getCommittedIdStorageKey(userAddress)
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === 'number' ? parsed : null;
  } catch (error) {
    console.error('Failed to load committed id:', error);
    return null;
  }
}

/**
 * Persist the durable committed ingestion-id cursor for an account (or clear).
 */
async function persistCommittedId(
  userAddress: string,
  id: number | null
): Promise<void> {
  try {
    const storageKey = getCommittedIdStorageKey(userAddress);
    if (id == null) {
      await AsyncStorage.removeItem(storageKey);
    } else {
      await AsyncStorage.setItem(storageKey, JSON.stringify(id));
    }
  } catch (error) {
    console.error('Failed to persist committed id:', error);
  }
}

/**
 * Greatest MIMIR ingestion id (`sourceId`) across all held threads, or null.
 * Used as the safe cursor watermark when an explicit cursor is missing on load.
 */
function maxSourceIdOfThreads(
  threads: Record<string, MessageThread>
): number | null {
  let max: number | null = null;
  for (const thread of Object.values(threads)) {
    for (const msg of thread.messages) {
      if (msg.sourceId != null && (max === null || msg.sourceId > max)) {
        max = msg.sourceId;
      }
    }
  }
  return max;
}

/**
 * Persist hidden threads to AsyncStorage for a specific account
 */
async function persistHiddenThreads(
  userAddress: string,
  hiddenThreads: Set<string>
): Promise<void> {
  try {
    const storageKey = getHiddenStorageKey(userAddress);
    // Convert Set to array for JSON serialization
    await AsyncStorage.setItem(storageKey, JSON.stringify([...hiddenThreads]));
  } catch (error) {
    console.error('Failed to persist hidden threads:', error);
  }
}

/**
 * Hook to get the total unread count (reactive)
 * Uses stable selector that doesn't create new objects
 */
export function useTotalUnreadCount(): number {
  const threads = useMessagesStore((state) => state.threads);
  return Object.values(threads).reduce(
    (sum, thread) => sum + thread.unreadCount,
    0
  );
}

/**
 * Hook to get a specific thread (reactive)
 */
export function useThread(friendAddress: string): MessageThread | null {
  return useMessagesStore((state) => state.threads[friendAddress] || null);
}

/**
 * Hook to get sorted threads (reactive)
 * Filters out hidden threads unless showHiddenThreads is true
 */
export function useSortedThreads(): MessageThread[] {
  const threads = useMessagesStore((state) => state.threads);
  const hiddenThreads = useMessagesStore((state) => state.hiddenThreads);
  const showHiddenThreads = useMessagesStore(
    (state) => state.showHiddenThreads
  );

  return Object.values(threads)
    .filter(
      (thread) => showHiddenThreads || !hiddenThreads.has(thread.friendAddress)
    )
    .sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
}

/**
 * Hook to get count of hidden threads (reactive)
 */
export function useHiddenThreadsCount(): number {
  const threads = useMessagesStore((state) => state.threads);
  const hiddenThreads = useMessagesStore((state) => state.hiddenThreads);
  return Object.keys(threads).filter((addr) => hiddenThreads.has(addr)).length;
}

/**
 * Hook to check if a specific thread is hidden (reactive)
 */
export function useIsThreadHidden(friendAddress: string): boolean {
  const hiddenThreads = useMessagesStore((state) => state.hiddenThreads);
  return hiddenThreads.has(friendAddress);
}

/**
 * Hook to get showHiddenThreads state (reactive)
 */
export function useShowHiddenThreads(): boolean {
  return useMessagesStore((state) => state.showHiddenThreads);
}
