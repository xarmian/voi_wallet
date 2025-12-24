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
import { Message, MessageThread, MessageStatus, MessagingKeyPair } from '@/services/messaging/types';
import MessagingService from '@/services/messaging';
import { useFriendsStore } from './friendsStore';

const STORAGE_KEY_PREFIX = '@messages/';
const HIDDEN_THREADS_STORAGE_KEY_PREFIX = '@messages/hidden/';

const POLLING_INTERVAL_MS = 30000; // 30 seconds (used when chat is open)

// Helper to get storage key for a specific account
const getStorageKey = (userAddress: string) => `${STORAGE_KEY_PREFIX}${userAddress}`;
const getHiddenStorageKey = (userAddress: string) => `${HIDDEN_THREADS_STORAGE_KEY_PREFIX}${userAddress}`;

interface MessagesState {
  // State
  threads: Record<string, MessageThread>;
  currentUserAddress: string | null; // Track which account these threads belong to
  isLoading: boolean;
  isInitialized: boolean;
  isKeyRegistered: boolean; // Whether current user has registered messaging key
  lastError: string | null;
  pollingInterval: NodeJS.Timeout | null;
  lastSyncRound: number | null;
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
    lastSyncRound: null,
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
        .filter(thread => showHiddenThreads || !hiddenThreads.has(thread.friendAddress))
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
      const thread = threads[message.threadId] || createEmptyThread(message.threadId);

      // Check for duplicate
      if (thread.messages.some((m) => m.id === message.id)) {
        return;
      }

      // Get friend's Envoi name if available
      const friend = useFriendsStore.getState().friends.find(
        (f) => f.address === message.threadId
      );

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
      const thread = threads[message.threadId] || createEmptyThread(message.threadId);

      // Get friend's Envoi name if available
      const friend = useFriendsStore.getState().friends.find(
        (f) => f.address === message.threadId
      );

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
        const isRegistered = await MessagingService.isKeyRegistered(userAddress);
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
        const message = error instanceof Error ? error.message : 'Unknown error';
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
      const rawStoredThreads = storedThreadsJson ? JSON.parse(storedThreadsJson) : {};

      // Also load hidden threads for the new account
      const hiddenStorageKey = getHiddenStorageKey(userAddress);
      const storedHiddenJson = await AsyncStorage.getItem(hiddenStorageKey);
      const storedHidden = storedHiddenJson ? new Set<string>(JSON.parse(storedHiddenJson)) : new Set<string>();

      // Deduplicate messages and calculate lastSyncRound
      const { threads: storedThreads, maxRound } = deduplicateThreads(rawStoredThreads);

      set({
        threads: storedThreads,
        currentUserAddress: userAddress,
        lastSyncRound: maxRound || null,
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
        const friend = useFriendsStore.getState().friends.find(
          (f) => f.address === friendAddress
        );

        // Merge with existing messages (deduplicate by ID)
        const allMessages = [...(existingThread?.messages || [])];
        for (const msg of messages) {
          if (!allMessages.some((m) => m.id === msg.id)) {
            allMessages.push(msg);
          }
        }
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
    fetchOlderMessages: async (userAddress, friendAddress, beforeRound, pin) => {
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
        const friend = useFriendsStore.getState().friends.find(
          (f) => f.address === friendAddress
        );

        // Merge with existing messages (deduplicate by ID)
        const allMessages = [...(existingThread?.messages || [])];
        for (const msg of messages) {
          if (!allMessages.some((m) => m.id === msg.id)) {
            allMessages.push(msg);
          }
        }
        allMessages.sort((a, b) => a.timestamp - b.timestamp);

        const lastMsg = allMessages[allMessages.length - 1];

        set({
          threads: {
            ...threads,
            [friendAddress]: {
              ...existingThread,
              friendAddress,
              friendEnvoiName: friend?.envoiName || existingThread?.friendEnvoiName,
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
      try {
        set({ isLoading: true, lastError: null });

        const { currentUserAddress } = get();

        // If account changed, load from storage for the new account
        if (currentUserAddress !== userAddress) {
          const storageKey = getStorageKey(userAddress);
          const storedThreadsJson = await AsyncStorage.getItem(storageKey);
          const rawStoredThreads = storedThreadsJson ? JSON.parse(storedThreadsJson) : {};

          // Also load hidden threads for the new account
          const hiddenStorageKey = getHiddenStorageKey(userAddress);
          const storedHiddenJson = await AsyncStorage.getItem(hiddenStorageKey);
          const storedHidden = storedHiddenJson ? new Set<string>(JSON.parse(storedHiddenJson)) : new Set<string>();

          // Deduplicate messages and calculate lastSyncRound from cached messages
          const { threads: storedThreads, maxRound: cachedMaxRound } = deduplicateThreads(rawStoredThreads);

          set({
            threads: storedThreads,
            currentUserAddress: userAddress,
            lastSyncRound: cachedMaxRound || null,
            isKeyRegistered: false, // Will be checked below
            hiddenThreads: storedHidden,
            showHiddenThreads: false, // Reset to default when switching accounts
          });

          // Re-persist if deduplication changed anything
          if (JSON.stringify(storedThreads) !== JSON.stringify(rawStoredThreads)) {
            await persistThreads(userAddress, storedThreads);
          }
        }

        // Check key registration status
        const isRegistered = await MessagingService.isKeyRegistered(userAddress);
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

        const conversationMap = await MessagingService.fetchAllConversations(
          userAddress,
          messagingKeyPair,
          100
        );

        const { threads: existingThreads } = get();
        const newThreads: Record<string, MessageThread> = {};

        for (const [friendAddress, messages] of conversationMap) {
          const existing = existingThreads[friendAddress];
          const friend = useFriendsStore.getState().friends.find(
            (f) => f.address === friendAddress
          );

          // Merge messages (deduplicate by ID)
          const allMessages = [...(existing?.messages || [])];
          for (const msg of messages) {
            if (!allMessages.some((m) => m.id === msg.id)) {
              allMessages.push(msg);
            }
          }
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

        // Update last sync round from the most recent message
        let maxRound = get().lastSyncRound || 0;
        for (const thread of Object.values(newThreads)) {
          for (const msg of thread.messages) {
            if (msg.confirmedRound && msg.confirmedRound > maxRound) {
              maxRound = msg.confirmedRound;
            }
          }
        }

        set({
          threads: newThreads,
          currentUserAddress: userAddress,
          lastSyncRound: maxRound || null,
          isLoading: false,
        });

        // Persist to per-account storage
        await persistThreads(userAddress, newThreads);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        set({ lastError: message, isLoading: false });
      }
    },

    /**
     * Start polling for new messages
     */
    startPolling: (userAddress, intervalMs = POLLING_INTERVAL_MS) => {
      // Stop any existing polling
      get().stopPolling();

      // Start new polling interval
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
        lastSyncRound: null,
        hiddenThreads: new Set<string>(),
        showHiddenThreads: false,
      });
      if (currentUserAddress) {
        await AsyncStorage.removeItem(getStorageKey(currentUserAddress));
        await AsyncStorage.removeItem(getHiddenStorageKey(currentUserAddress));
      }
    },
  }))
);

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
 * Deduplicate messages in threads loaded from storage
 * Returns the deduplicated threads and the max round for lastSyncRound
 */
function deduplicateThreads(threads: Record<string, MessageThread>): {
  threads: Record<string, MessageThread>;
  maxRound: number;
} {
  let maxRound = 0;
  const deduped: Record<string, MessageThread> = {};

  for (const [friendAddress, thread] of Object.entries(threads)) {
    // Deduplicate messages by ID
    const seen = new Set<string>();
    const uniqueMessages: Message[] = [];
    for (const msg of thread.messages) {
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        uniqueMessages.push(msg);
        if (msg.confirmedRound && msg.confirmedRound > maxRound) {
          maxRound = msg.confirmedRound;
        }
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

  return { threads: deduped, maxRound };
}

/**
 * Persist threads to AsyncStorage for a specific account
 * Filters out empty threads (threads with no messages) to prevent clutter
 */
async function persistThreads(
  userAddress: string,
  threads: Record<string, MessageThread>
): Promise<void> {
  try {
    const storageKey = getStorageKey(userAddress);
    // Only persist threads that have actual messages
    const threadsToSave = Object.fromEntries(
      Object.entries(threads).filter(([, thread]) => thread.messages.length > 0)
    );
    await AsyncStorage.setItem(storageKey, JSON.stringify(threadsToSave));
  } catch (error) {
    console.error('Failed to persist messages:', error);
  }
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
  const showHiddenThreads = useMessagesStore((state) => state.showHiddenThreads);

  return Object.values(threads)
    .filter(thread => showHiddenThreads || !hiddenThreads.has(thread.friendAddress))
    .sort((a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp);
}

/**
 * Hook to get count of hidden threads (reactive)
 */
export function useHiddenThreadsCount(): number {
  const threads = useMessagesStore((state) => state.threads);
  const hiddenThreads = useMessagesStore((state) => state.hiddenThreads);
  return Object.keys(threads).filter(addr => hiddenThreads.has(addr)).length;
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
