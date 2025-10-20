import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { SECURITY_CONFIG, SECURITY_MESSAGES } from '@/config/security';

/**
 * Transaction Tracker - Prevents replay attacks and enforces rate limits
 */

const TRANSACTION_CACHE_KEY = 'voi_transaction_cache';
const RATE_LIMIT_KEY = 'voi_rate_limits';

interface TransactionRecord {
  txHash: string;
  timestamp: number;
  amount: number;
  from: string;
  to: string;
}

interface RateLimitRecord {
  hourlyCount: number;
  dailyCount: number;
  lastHourReset: number;
  lastDayReset: number;
}

export class TransactionTracker {
  private static async migrateLegacyItem(key: string): Promise<string | null> {
    try {
      const legacyValue = await SecureStore.getItemAsync(key);
      if (!legacyValue) {
        return null;
      }

      await AsyncStorage.setItem(key, legacyValue);
      await SecureStore.deleteItemAsync(key).catch(() => {});
      return legacyValue;
    } catch (error) {
      console.warn('Failed to migrate legacy SecureStore item', error);
      return null;
    }
  }

  private static async readJson<T>(key: string): Promise<T | null> {
    try {
      let raw = await AsyncStorage.getItem(key);
      if (!raw) {
        raw = await this.migrateLegacyItem(key);
      }
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      console.error(`TransactionTracker read error for ${key}:`, error);
      return null;
    }
  }

  private static async writeJson(key: string, value: unknown): Promise<void> {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  }

  private static async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
    await SecureStore.deleteItemAsync(key).catch(() => {});
  }

  /**
   * Check if transaction is allowed (not a replay, within rate limits)
   */
  static async validateNewTransaction(
    from: string,
    to: string,
    amount: number,
    txHash?: string
  ): Promise<string[]> {
    const errors: string[] = [];

    try {
      // Check rate limits
      const rateLimitErrors = await this.checkRateLimits();
      errors.push(...rateLimitErrors);

      // Check for replay attacks if transaction hash is provided
      if (txHash) {
        const isReplay = await this.checkReplayAttack(txHash);
        if (isReplay) {
          errors.push(SECURITY_MESSAGES.REPLAY_ATTACK);
        }
      }

      // Additional validation
      await this.checkTransactionPattern(from, to, amount, errors);
    } catch (error) {
      console.error('Transaction validation error:', error);
      errors.push('Failed to validate transaction security');
    }

    return errors;
  }

  /**
   * Record a successful transaction
   */
  static async recordTransaction(
    txHash: string,
    from: string,
    to: string,
    amount: number
  ): Promise<void> {
    try {
      // Add to transaction cache
      await this.addToCache({
        txHash,
        timestamp: Date.now(),
        amount,
        from,
        to,
      });

      // Update rate limits
      await this.updateRateLimits();
    } catch (error) {
      console.error('Failed to record transaction:', error);
    }
  }

  /**
   * Check transaction rate limits
   */
  private static async checkRateLimits(): Promise<string[]> {
    const errors: string[] = [];

    try {
      const rateLimits = await this.getRateLimits();
      const now = Date.now();

      // Reset counters if time windows have passed
      if (now - rateLimits.lastHourReset > 3600000) {
        // 1 hour
        rateLimits.hourlyCount = 0;
        rateLimits.lastHourReset = now;
      }

      if (now - rateLimits.lastDayReset > 86400000) {
        // 24 hours
        rateLimits.dailyCount = 0;
        rateLimits.lastDayReset = now;
      }

      // Check limits
      if (rateLimits.hourlyCount >= SECURITY_CONFIG.MAX_HOURLY_TRANSACTIONS) {
        errors.push(SECURITY_MESSAGES.RATE_LIMITED);
      }

      if (rateLimits.dailyCount >= SECURITY_CONFIG.MAX_DAILY_TRANSACTIONS) {
        errors.push(SECURITY_MESSAGES.TRANSACTION_LIMIT_EXCEEDED);
      }

      // Save updated rate limits
      await this.saveRateLimits(rateLimits);
    } catch (error) {
      console.error('Rate limit check failed:', error);
    }

    return errors;
  }

  /**
   * Check for replay attacks
   */
  private static async checkReplayAttack(txHash: string): Promise<boolean> {
    try {
      const cache = await this.getTransactionCache();
      const now = Date.now();

      // Clean old transactions first
      const validTransactions = cache.filter(
        (tx) => now - tx.timestamp < SECURITY_CONFIG.TRANSACTION_TIMEOUT
      );

      // Check if transaction hash already exists
      return validTransactions.some((tx) => tx.txHash === txHash);
    } catch (error) {
      console.error('Replay check failed:', error);
      return false;
    }
  }

  /**
   * Check for suspicious transaction patterns
   */
  private static async checkTransactionPattern(
    from: string,
    to: string,
    amount: number,
    errors: string[]
  ): Promise<void> {
    try {
      const cache = await this.getTransactionCache();
      const now = Date.now();
      const recentWindow = 300000; // 5 minutes

      // Get recent transactions from this address
      const recentTransactions = cache.filter(
        (tx) => tx.from === from && now - tx.timestamp < recentWindow
      );

      // Check for rapid identical transactions (potential replay pattern)
      const identicalTransactions = recentTransactions.filter(
        (tx) => tx.to === to && tx.amount === amount
      );

      if (identicalTransactions.length >= 3) {
        errors.push(
          'Multiple identical transactions detected. Please wait before retrying.'
        );
      }

      // Check for high-frequency transactions (potential bot activity)
      if (recentTransactions.length >= 10) {
        errors.push(
          'Too many transactions in short period. Please wait before retrying.'
        );
      }
    } catch (error) {
      console.error('Pattern check failed:', error);
    }
  }

  /**
   * Get transaction cache
   */
  private static async getTransactionCache(): Promise<TransactionRecord[]> {
    try {
      const cacheData = await this.readJson<TransactionRecord[]>(
        TRANSACTION_CACHE_KEY
      );
      return cacheData ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Add transaction to cache
   */
  private static async addToCache(
    transaction: TransactionRecord
  ): Promise<void> {
    try {
      let cache = await this.getTransactionCache();

      // Add new transaction
      cache.push(transaction);

      // Keep only recent transactions and limit cache size
      const now = Date.now();
      cache = cache
        .filter(
          (tx) => now - tx.timestamp < SECURITY_CONFIG.TRANSACTION_TIMEOUT
        )
        .slice(-SECURITY_CONFIG.MAX_TRANSACTION_CACHE);

      await this.writeJson(TRANSACTION_CACHE_KEY, cache);
    } catch (error) {
      console.error('Failed to update transaction cache:', error);
    }
  }

  /**
   * Get rate limits
   */
  private static async getRateLimits(): Promise<RateLimitRecord> {
    try {
      const rateLimitData = await this.readJson<RateLimitRecord>(RATE_LIMIT_KEY);
      return rateLimitData ?? {
        hourlyCount: 0,
        dailyCount: 0,
        lastHourReset: Date.now(),
        lastDayReset: Date.now(),
      };
    } catch {
      return {
        hourlyCount: 0,
        dailyCount: 0,
        lastHourReset: Date.now(),
        lastDayReset: Date.now(),
      };
    }
  }

  /**
   * Save rate limits
   */
  private static async saveRateLimits(
    rateLimits: RateLimitRecord
  ): Promise<void> {
    try {
      await this.writeJson(RATE_LIMIT_KEY, rateLimits);
    } catch (error) {
      console.error('Failed to save rate limits:', error);
    }
  }

  /**
   * Update rate limits after successful transaction
   */
  private static async updateRateLimits(): Promise<void> {
    try {
      const rateLimits = await this.getRateLimits();
      rateLimits.hourlyCount++;
      rateLimits.dailyCount++;
      await this.saveRateLimits(rateLimits);
    } catch (error) {
      console.error('Failed to update rate limits:', error);
    }
  }

  /**
   * Clear all tracking data
   */
  static async clearAll(): Promise<void> {
    try {
      await Promise.all([
        this.removeItem(TRANSACTION_CACHE_KEY),
        this.removeItem(RATE_LIMIT_KEY),
      ]);
    } catch (error) {
      console.error('Failed to clear transaction tracking data:', error);
    }
  }
}
