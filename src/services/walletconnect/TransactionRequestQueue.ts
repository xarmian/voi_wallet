import AsyncStorage from '@react-native-async-storage/async-storage';

export interface QueuedTransactionRequest {
  id: number | string;
  topic: string;
  params: {
    request: {
      method: string;
      params: any[];
    };
    chainId: number | string;
  };
  timestamp: number;
  version?: number; // 1 for V1, undefined for V2
}

const QUEUE_STORAGE_KEY = '@walletconnect_transaction_queue';
const PROCESSING_STATE_KEY = '@walletconnect_queue_processing';
const REQUEST_TIMEOUT_MS = 60 * 1000; // 1 minute (reduced from 5 minutes)
const MAX_QUEUE_SIZE = 10; // Prevent DOS attacks
// Bound on the in-memory delivery map (claim()/markDisplayed()). Only the
// oldest DISPLAYED entry is ever evicted; see setDelivery.
const MAX_TRACKED_REQUESTS = 5000;

/**
 * In-memory, per app session (TASK-257):
 *  - 'claimed': arrived from WalletConnect and is being shown or is queued;
 *  - 'displayed': handed to the signing screen.
 */
type DeliveryState = 'claimed' | 'displayed';

const requestKey = (id: number | string, topic: string): string =>
  JSON.stringify([topic, id]);

class TransactionRequestQueueService {
  private static instance: TransactionRequestQueueService;
  private queueMutex: Promise<void> = Promise.resolve();
  private processingStateCache: boolean | null = null;
  /** (topic, id) -> delivery state for this app session (TASK-257). */
  private delivery = new Map<string, DeliveryState>();

  private constructor() {}

  public static getInstance(): TransactionRequestQueueService {
    if (!TransactionRequestQueueService.instance) {
      TransactionRequestQueueService.instance =
        new TransactionRequestQueueService();
    }
    return TransactionRequestQueueService.instance;
  }

  /**
   * Execute a function with exclusive queue access to prevent race conditions
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previousOperation = this.queueMutex;
    let resolveLock: () => void;
    this.queueMutex = new Promise((resolve) => {
      resolveLock = resolve;
    });

    try {
      await previousOperation;
      return await fn();
    } finally {
      resolveLock!();
    }
  }

  /**
   * Claim a signing request that just arrived from WalletConnect (TASK-257).
   *
   * Returns true the FIRST time a (topic, id) pair is seen in this app
   * session and false for every repeat, so a duplicate emit (relay
   * redelivery, a second listener) can never surface a second identical
   * group, including while the original is still on screen. Synchronous and
   * in memory: `enqueue`'s own dedupe only sees the persisted queue, not the
   * request currently displayed.
   *
   * A claim means "this request is being shown or is queued". The claimant
   * then either shows it (`markDisplayed`), queues it (the claim stays), or
   * fails to deliver it and calls `releaseClaim` so a redelivery can surface.
   */
  claim(id: number | string, topic: string): boolean {
    const key = requestKey(id, topic);
    if (this.delivery.has(key)) {
      return false;
    }
    this.setDelivery(key, 'claimed');
    return true;
  }

  /**
   * Record that a request has been handed to the signing screen. Returns
   * false if it was ALREADY displayed this session, in which case the caller
   * must not show it again. A request that was only claimed (queued, never
   * shown) is not "displayed": it returns true and is marked displayed now.
   */
  markDisplayed(id: number | string, topic: string): boolean {
    const key = requestKey(id, topic);
    if (this.delivery.get(key) === 'displayed') {
      return false;
    }
    this.setDelivery(key, 'displayed');
    return true;
  }

  /**
   * Undo `claim` for a request whose delivery FAILED (navigation unavailable,
   * enqueue or navigate threw), so a later redelivery of it can still be
   * shown. A request already displayed stays displayed.
   */
  releaseClaim(id: number | string, topic: string): void {
    const key = requestKey(id, topic);
    if (this.delivery.get(key) === 'claimed') {
      this.delivery.delete(key);
    }
  }

  private setDelivery(key: string, state: DeliveryState): void {
    // Re-insert so eviction order follows the latest transition.
    this.delivery.delete(key);
    this.delivery.set(key, state);
    if (this.delivery.size > MAX_TRACKED_REQUESTS) {
      // Evict the request displayed longest ago. A 'claimed' entry (queued,
      // not yet shown) is never evicted: forgetting it would let a
      // redelivery show it while its queued copy is still waiting. Claimed
      // entries are bounded by the queue itself (MAX_QUEUE_SIZE, and a stale
      // or failed one releases its claim).
      for (const [oldKey, oldState] of this.delivery) {
        if (oldState === 'displayed' && oldKey !== key) {
          this.delivery.delete(oldKey);
          break;
        }
      }
    }
  }

  /**
   * Undo every delivery mark for a request whose ANSWER could not be sent
   * (the approve response or the rejection failed), so a relay redelivery of
   * it surfaces again and the dApp can still get an answer (TASK-257). Unlike
   * `releaseClaim`, this also clears 'displayed'.
   */
  forgetDelivery(id: number | string, topic: string): void {
    this.delivery.delete(requestKey(id, topic));
  }

  /**
   * Take the next queued request that has NOT been displayed this session and
   * show it with `show` (a navigate or replace), atomically (TASK-257).
   *
   * Under the queue lock, in one step: drop head requests already displayed
   * this session (a persisted request the relay redelivered and the app
   * showed directly: the copy on screen is the one the user answers), mark
   * the next head displayed, call `show`, then remove it from the queue. A
   * concurrent taker (the startup drain racing a screen completion) waits on
   * the lock and finds it gone, so a request is shown at most once.
   *
   * If `show` throws, the mark goes back to 'claimed' (queued, not shown),
   * the request stays queued so it is never lost, and the error propagates.
   *
   * Returns the request shown (or null if none was waiting) and how many
   * requests remain queued after it.
   */
  async takeNext(
    show: (request: QueuedTransactionRequest) => void
  ): Promise<{ request: QueuedTransactionRequest | null; remaining: number }> {
    return this.withLock(async () => {
      const { queue, dropped } = await this.dropDisplayedHead();
      const persist = async () => {
        try {
          await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
        } catch (error) {
          // A displayed copy left behind is dropped by the next take.
          console.error(
            '[TransactionRequestQueue] Failed to persist queue after take:',
            error
          );
        }
      };

      const next = queue[0];
      if (!next) {
        if (dropped > 0) await persist();
        return { request: null, remaining: 0 };
      }

      const key = requestKey(next.id, next.topic);
      this.setDelivery(key, 'displayed');
      try {
        show(next);
      } catch (error) {
        this.setDelivery(key, 'claimed');
        if (dropped > 0) await persist();
        throw error;
      }
      queue.shift();
      await persist();
      return { request: next, remaining: queue.length };
    });
  }

  /** Lock held by the caller. Removes (in memory) displayed head entries. */
  private async dropDisplayedHead(): Promise<{
    queue: QueuedTransactionRequest[];
    dropped: number;
  }> {
    const queue = await this.getAllInternal();
    let dropped = 0;
    while (
      queue.length > 0 &&
      this.delivery.get(requestKey(queue[0].id, queue[0].topic)) === 'displayed'
    ) {
      queue.shift();
      dropped++;
    }
    if (dropped > 0) {
      console.log(
        '[TransactionRequestQueue] Dropped already-displayed request(s):',
        dropped
      );
    }
    return { queue, dropped };
  }

  /**
   * Add a transaction request to the queue
   */
  async enqueue(
    request: Omit<QueuedTransactionRequest, 'timestamp'>
  ): Promise<void> {
    return this.withLock(async () => {
      try {
        const queue = await this.getAllInternal();

        // Check queue size limit
        if (queue.length >= MAX_QUEUE_SIZE) {
          console.warn(
            '[TransactionRequestQueue] Maximum queue size reached, rejecting request'
          );
          throw new Error(
            'Transaction request queue is full. Please process pending requests first.'
          );
        }

        // Check if request already exists (prevent duplicates)
        const isDuplicate = queue.some(
          (item) => item.id === request.id && item.topic === request.topic
        );

        if (isDuplicate) {
          console.log(
            '[TransactionRequestQueue] Request already in queue, skipping:',
            request.id
          );
          return;
        }

        const queuedRequest: QueuedTransactionRequest = {
          ...request,
          timestamp: Date.now(),
        };

        queue.push(queuedRequest);
        await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
        console.log(
          '[TransactionRequestQueue] Request enqueued:',
          request.id,
          'Queue size:',
          queue.length
        );
      } catch (error) {
        console.error(
          '[TransactionRequestQueue] Failed to enqueue request:',
          error
        );
        throw error;
      }
    });
  }

  /**
   * Remove and return the oldest request from the queue
   */
  async dequeue(): Promise<QueuedTransactionRequest | null> {
    return this.withLock(async () => {
      try {
        const queue = await this.getAllInternal();

        if (queue.length === 0) {
          return null;
        }

        const request = queue.shift();
        await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));

        if (request) {
          console.log(
            '[TransactionRequestQueue] Request dequeued:',
            request.id,
            'Remaining:',
            queue.length
          );
        }

        return request || null;
      } catch (error) {
        console.error(
          '[TransactionRequestQueue] Failed to dequeue request:',
          error
        );
        return null;
      }
    });
  }

  /**
   * Atomic operation: dequeue only if the next item matches the expected request
   * This prevents race conditions where the queue changes between peek and dequeue
   */
  async dequeueIfMatch(
    expectedId: number | string,
    expectedTopic: string
  ): Promise<QueuedTransactionRequest | null> {
    return this.withLock(async () => {
      try {
        const queue = await this.getAllInternal();

        if (queue.length === 0) {
          console.log(
            '[TransactionRequestQueue] Cannot dequeue: queue is empty'
          );
          return null;
        }

        const first = queue[0];
        if (first.id === expectedId && first.topic === expectedTopic) {
          queue.shift();
          await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
          console.log(
            '[TransactionRequestQueue] Request dequeued (matched):',
            first.id,
            'Remaining:',
            queue.length
          );
          return first;
        } else {
          console.warn(
            '[TransactionRequestQueue] Queue changed: expected',
            expectedId,
            'but found',
            first.id
          );
          return null;
        }
      } catch (error) {
        console.error(
          '[TransactionRequestQueue] Failed to dequeue with match:',
          error
        );
        return null;
      }
    });
  }

  /**
   * Get the next request without removing it
   */
  async peek(): Promise<QueuedTransactionRequest | null> {
    try {
      const queue = await this.getAll();
      return queue.length > 0 ? queue[0] : null;
    } catch (error) {
      console.error('[TransactionRequestQueue] Failed to peek queue:', error);
      return null;
    }
  }

  /**
   * Internal method to get all requests (without lock, for use within locked operations)
   */
  private async getAllInternal(): Promise<QueuedTransactionRequest[]> {
    try {
      const queueJson = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);

      if (!queueJson) {
        return [];
      }

      let queue: QueuedTransactionRequest[];
      try {
        queue = JSON.parse(queueJson);
      } catch (parseError) {
        console.error(
          '[TransactionRequestQueue] Corrupted queue detected, clearing:',
          parseError
        );
        await AsyncStorage.removeItem(QUEUE_STORAGE_KEY);
        return [];
      }

      if (!Array.isArray(queue)) {
        console.error(
          '[TransactionRequestQueue] Invalid queue format, clearing'
        );
        await AsyncStorage.removeItem(QUEUE_STORAGE_KEY);
        return [];
      }

      // Filter out stale requests (older than timeout)
      const now = Date.now();
      const validQueue = queue.filter((request) => {
        const age = now - request.timestamp;
        if (age > REQUEST_TIMEOUT_MS) {
          console.log(
            '[TransactionRequestQueue] Removing stale request:',
            request.id,
            'Age:',
            Math.round(age / 1000),
            'seconds'
          );
          // No longer queued: a redelivery of it may surface again.
          this.releaseClaim(request.id, request.topic);
          return false;
        }
        return true;
      });

      // If we filtered out any stale requests, save the cleaned queue
      if (validQueue.length !== queue.length) {
        await AsyncStorage.setItem(
          QUEUE_STORAGE_KEY,
          JSON.stringify(validQueue)
        );
      }

      return validQueue;
    } catch (error) {
      console.error('[TransactionRequestQueue] Failed to get queue:', error);
      return [];
    }
  }

  /**
   * Get all requests in the queue
   */
  async getAll(): Promise<QueuedTransactionRequest[]> {
    return this.withLock(async () => {
      return await this.getAllInternal();
    });
  }

  /**
   * Check if queue is empty
   */
  async isEmpty(): Promise<boolean> {
    const queue = await this.getAll();
    return queue.length === 0;
  }

  /**
   * Get the size of the queue
   */
  async size(): Promise<number> {
    const queue = await this.getAll();
    return queue.length;
  }

  /**
   * Clear all requests from the queue
   */
  async clear(): Promise<void> {
    try {
      await AsyncStorage.removeItem(QUEUE_STORAGE_KEY);
      console.log('[TransactionRequestQueue] Queue cleared');
    } catch (error) {
      console.error('[TransactionRequestQueue] Failed to clear queue:', error);
    }
  }

  /**
   * Set processing state (to prevent concurrent processing)
   */
  async setProcessing(isProcessing: boolean): Promise<void> {
    try {
      this.processingStateCache = isProcessing;
      await AsyncStorage.setItem(
        PROCESSING_STATE_KEY,
        JSON.stringify(isProcessing)
      );
    } catch (error) {
      console.error(
        '[TransactionRequestQueue] Failed to set processing state:',
        error
      );
    }
  }

  /**
   * Get processing state
   */
  async isProcessing(): Promise<boolean> {
    if (this.processingStateCache !== null) {
      return this.processingStateCache;
    }

    try {
      const state = await AsyncStorage.getItem(PROCESSING_STATE_KEY);
      this.processingStateCache = state ? JSON.parse(state) : false;
      return this.processingStateCache ?? false;
    } catch (error) {
      console.error(
        '[TransactionRequestQueue] Failed to get processing state:',
        error
      );
      return false;
    }
  }

  /**
   * Remove a specific request by id and topic
   */
  async remove(id: number | string, topic: string): Promise<void> {
    return this.withLock(async () => {
      try {
        const queue = await this.getAllInternal();
        const filteredQueue = queue.filter(
          (request) => !(request.id === id && request.topic === topic)
        );

        if (filteredQueue.length !== queue.length) {
          await AsyncStorage.setItem(
            QUEUE_STORAGE_KEY,
            JSON.stringify(filteredQueue)
          );
          console.log('[TransactionRequestQueue] Request removed:', id);
        }
      } catch (error) {
        console.error(
          '[TransactionRequestQueue] Failed to remove request:',
          error
        );
      }
    });
  }

  /**
   * Remove every queued request belonging to a topic (PLAN-260, DR-14).
   *
   * Called when a WalletConnect session is DROPPED — e.g. a v1 session whose
   * key is unreadable or no longer matches. Without this, a queued request for
   * that topic survives, gets dequeued unconditionally at startup, finds no
   * approved live session, and errors out — having already been removed from
   * the queue, so the request is simply lost behind a confusing message.
   *
   * Returns the number of requests dropped, so callers can log it.
   */
  async removeByTopic(topic: string): Promise<number> {
    return this.withLock(async () => {
      try {
        const queue = await this.getAllInternal();
        const filteredQueue = queue.filter(
          (request) => request.topic !== topic
        );
        const removed = queue.length - filteredQueue.length;
        // No longer queued: release their claims (TASK-257).
        for (const request of queue) {
          if (request.topic === topic) {
            this.releaseClaim(request.id, request.topic);
          }
        }

        if (removed > 0) {
          await AsyncStorage.setItem(
            QUEUE_STORAGE_KEY,
            JSON.stringify(filteredQueue)
          );
          console.log(
            '[TransactionRequestQueue] Dropped requests for dead session:',
            removed
          );
        }

        return removed;
      } catch (error) {
        console.error(
          '[TransactionRequestQueue] Failed to remove requests by topic:',
          error
        );
        return 0;
      }
    });
  }
}

export const TransactionRequestQueue =
  TransactionRequestQueueService.getInstance();
