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

class TransactionRequestQueueService {
  private static instance: TransactionRequestQueueService;
  private queueMutex: Promise<void> = Promise.resolve();
  private processingStateCache: boolean | null = null;

  private constructor() {}

  public static getInstance(): TransactionRequestQueueService {
    if (!TransactionRequestQueueService.instance) {
      TransactionRequestQueueService.instance = new TransactionRequestQueueService();
    }
    return TransactionRequestQueueService.instance;
  }

  /**
   * Execute a function with exclusive queue access to prevent race conditions
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previousOperation = this.queueMutex;
    let resolveLock: () => void;
    this.queueMutex = new Promise(resolve => { resolveLock = resolve; });

    try {
      await previousOperation;
      return await fn();
    } finally {
      resolveLock!();
    }
  }

  /**
   * Add a transaction request to the queue
   */
  async enqueue(request: Omit<QueuedTransactionRequest, 'timestamp'>): Promise<void> {
    return this.withLock(async () => {
      try {
        const queue = await this.getAllInternal();

        // Check queue size limit
        if (queue.length >= MAX_QUEUE_SIZE) {
          console.warn('[TransactionRequestQueue] Maximum queue size reached, rejecting request');
          throw new Error('Transaction request queue is full. Please process pending requests first.');
        }

        // Check if request already exists (prevent duplicates)
        const isDuplicate = queue.some(item =>
          item.id === request.id && item.topic === request.topic
        );

        if (isDuplicate) {
          console.log('[TransactionRequestQueue] Request already in queue, skipping:', request.id);
          return;
        }

        const queuedRequest: QueuedTransactionRequest = {
          ...request,
          timestamp: Date.now(),
        };

        queue.push(queuedRequest);
        await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
        console.log('[TransactionRequestQueue] Request enqueued:', request.id, 'Queue size:', queue.length);
      } catch (error) {
        console.error('[TransactionRequestQueue] Failed to enqueue request:', error);
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
          console.log('[TransactionRequestQueue] Request dequeued:', request.id, 'Remaining:', queue.length);
        }

        return request || null;
      } catch (error) {
        console.error('[TransactionRequestQueue] Failed to dequeue request:', error);
        return null;
      }
    });
  }

  /**
   * Atomic operation: dequeue only if the next item matches the expected request
   * This prevents race conditions where the queue changes between peek and dequeue
   */
  async dequeueIfMatch(expectedId: number | string, expectedTopic: string): Promise<QueuedTransactionRequest | null> {
    return this.withLock(async () => {
      try {
        const queue = await this.getAllInternal();

        if (queue.length === 0) {
          console.log('[TransactionRequestQueue] Cannot dequeue: queue is empty');
          return null;
        }

        const first = queue[0];
        if (first.id === expectedId && first.topic === expectedTopic) {
          queue.shift();
          await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
          console.log('[TransactionRequestQueue] Request dequeued (matched):', first.id, 'Remaining:', queue.length);
          return first;
        } else {
          console.warn('[TransactionRequestQueue] Queue changed: expected', expectedId, 'but found', first.id);
          return null;
        }
      } catch (error) {
        console.error('[TransactionRequestQueue] Failed to dequeue with match:', error);
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
        console.error('[TransactionRequestQueue] Corrupted queue detected, clearing:', parseError);
        await AsyncStorage.removeItem(QUEUE_STORAGE_KEY);
        return [];
      }

      if (!Array.isArray(queue)) {
        console.error('[TransactionRequestQueue] Invalid queue format, clearing');
        await AsyncStorage.removeItem(QUEUE_STORAGE_KEY);
        return [];
      }

      // Filter out stale requests (older than timeout)
      const now = Date.now();
      const validQueue = queue.filter(request => {
        const age = now - request.timestamp;
        if (age > REQUEST_TIMEOUT_MS) {
          console.log('[TransactionRequestQueue] Removing stale request:', request.id, 'Age:', Math.round(age / 1000), 'seconds');
          return false;
        }
        return true;
      });

      // If we filtered out any stale requests, save the cleaned queue
      if (validQueue.length !== queue.length) {
        await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(validQueue));
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
      await AsyncStorage.setItem(PROCESSING_STATE_KEY, JSON.stringify(isProcessing));
    } catch (error) {
      console.error('[TransactionRequestQueue] Failed to set processing state:', error);
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
      return this.processingStateCache;
    } catch (error) {
      console.error('[TransactionRequestQueue] Failed to get processing state:', error);
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
          request => !(request.id === id && request.topic === topic)
        );

        if (filteredQueue.length !== queue.length) {
          await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(filteredQueue));
          console.log('[TransactionRequestQueue] Request removed:', id);
        }
      } catch (error) {
        console.error('[TransactionRequestQueue] Failed to remove request:', error);
      }
    });
  }
}

export const TransactionRequestQueue = TransactionRequestQueueService.getInstance();
