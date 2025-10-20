import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { Directory, File } from 'expo-file-system';
import * as Crypto from 'expo-crypto';

interface CachedAvatar {
  localUri: string;
  originalUrl: string;
  timestamp: number;
  expiresAt: number;
}

class AvatarCacheService {
  private static instance: AvatarCacheService;
  private cache: Map<string, CachedAvatar> = new Map();
  private cacheDirectory: Directory | null = null;
  private readonly CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
  private readonly STORAGE_KEY = 'avatar_cache_index';
  private initialized = false;

  private constructor() {}

  static getInstance(): AvatarCacheService {
    if (!AvatarCacheService.instance) {
      AvatarCacheService.instance = new AvatarCacheService();
    }
    return AvatarCacheService.instance;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create cache directory
      this.cacheDirectory = new Directory(Directory.cacheDirectory, 'avatars');
      await this.cacheDirectory.create();

      // Load cache index from storage
      await this.loadCacheIndex();

      // Clean up expired entries
      await this.cleanupExpiredEntries();

      this.initialized = true;
      console.log('[AvatarCache] Initialized successfully');
    } catch (error) {
      console.warn('[AvatarCache] Failed to initialize:', error);
      this.initialized = true; // Continue without cache
    }
  }

  private async loadCacheIndex(): Promise<void> {
    try {
      const storedCache = await AsyncStorage.getItem(this.STORAGE_KEY);
      if (storedCache) {
        const cacheData: Record<string, CachedAvatar> = JSON.parse(storedCache);
        this.cache = new Map(Object.entries(cacheData));
        console.log('[AvatarCache] Loaded cache index', {
          entries: this.cache.size,
        });
      }
    } catch (error) {
      console.warn('[AvatarCache] Failed to load cache index:', error);
    }
  }

  private async saveCacheIndex(): Promise<void> {
    try {
      const cacheData = Object.fromEntries(this.cache);
      await AsyncStorage.setItem(this.STORAGE_KEY, JSON.stringify(cacheData));
    } catch (error) {
      console.warn('[AvatarCache] Failed to save cache index:', error);
    }
  }

  private async cleanupExpiredEntries(): Promise<void> {
    if (!this.cacheDirectory) return;

    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        expiredKeys.push(key);

        // Delete the cached file
        try {
          const filename = entry.localUri.split('/').pop();
          if (filename) {
            const file = new File(this.cacheDirectory, filename);
            if (await file.exists()) {
              await file.delete();
            }
          }
        } catch (error) {
          console.warn(
            '[AvatarCache] Failed to delete expired file:',
            entry.localUri,
            error
          );
        }
      }
    }

    // Remove from cache
    expiredKeys.forEach((key) => this.cache.delete(key));

    if (expiredKeys.length > 0) {
      console.log('[AvatarCache] Cleaned up expired entries', {
        count: expiredKeys.length,
      });
      await this.saveCacheIndex();
    }
  }

  private generateCacheKey(url: string): string {
    // Create a hash of the URL for the cache key
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, url);
  }

  async getCachedAvatar(url: string): Promise<string | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!url || !this.cacheDirectory) return null;

    try {
      const cacheKey = await this.generateCacheKey(url);
      const cached = this.cache.get(cacheKey);

      if (!cached) {
        return null;
      }

      // Check if expired
      if (Date.now() > cached.expiresAt) {
        await this.removeCachedAvatar(url);
        return null;
      }

      // Check if file still exists
      const filename = cached.localUri.split('/').pop();
      if (filename) {
        const file = new File(this.cacheDirectory, filename);
        if (!(await file.exists())) {
          await this.removeCachedAvatar(url);
          return null;
        }
      }

      console.log('[AvatarCache] Cache hit', {
        url,
        localUri: cached.localUri,
      });
      return cached.localUri;
    } catch (error) {
      console.warn('[AvatarCache] Failed to get cached avatar:', error);
      return null;
    }
  }

  async cacheAvatar(url: string): Promise<string | null> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!url || !this.cacheDirectory) return null;

    try {
      const cacheKey = await this.generateCacheKey(url);

      // Check if already cached
      const existing = await this.getCachedAvatar(url);
      if (existing) {
        return existing;
      }

      console.log('[AvatarCache] Downloading avatar', { url });

      // Generate local filename
      const extension = url.split('.').pop()?.split('?')[0] || 'jpg';
      const filename = `${cacheKey}.${extension}`;
      const file = new File(this.cacheDirectory, filename);

      // Download the image
      const response = await fetch(url);
      if (!response.ok) {
        console.warn('[AvatarCache] Failed to download avatar', {
          url,
          status: response.status,
        });
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();
      await file.write(arrayBuffer);

      // Store in cache
      const now = Date.now();
      const cachedAvatar: CachedAvatar = {
        localUri: file.uri || url, // Fallback to original URL if file.uri is undefined
        originalUrl: url,
        timestamp: now,
        expiresAt: now + this.CACHE_DURATION,
      };

      this.cache.set(cacheKey, cachedAvatar);
      await this.saveCacheIndex();

      console.log('[AvatarCache] Cached avatar successfully', {
        url,
        localUri: file.uri,
      });
      return file.uri;
    } catch (error) {
      console.warn('[AvatarCache] Failed to cache avatar:', url, error);
      return null;
    }
  }

  async removeCachedAvatar(url: string): Promise<void> {
    if (!this.cacheDirectory) return;

    try {
      const cacheKey = await this.generateCacheKey(url);
      const cached = this.cache.get(cacheKey);

      if (cached) {
        // Delete the file
        try {
          const filename = cached.localUri.split('/').pop();
          if (filename) {
            const file = new File(this.cacheDirectory, filename);
            if (await file.exists()) {
              await file.delete();
            }
          }
        } catch (error) {
          console.warn(
            '[AvatarCache] Failed to delete cached file:',
            cached.localUri,
            error
          );
        }

        // Remove from cache
        this.cache.delete(cacheKey);
        await this.saveCacheIndex();
      }
    } catch (error) {
      console.warn('[AvatarCache] Failed to remove cached avatar:', error);
    }
  }

  async clearCache(): Promise<void> {
    try {
      // Delete all cached files
      if (this.cacheDirectory && (await this.cacheDirectory.exists())) {
        await this.cacheDirectory.delete();
        await this.cacheDirectory.create();
      }

      // Clear cache and storage
      this.cache.clear();
      await AsyncStorage.removeItem(this.STORAGE_KEY);

      console.log('[AvatarCache] Cache cleared successfully');
    } catch (error) {
      console.warn('[AvatarCache] Failed to clear cache:', error);
    }
  }

  getCacheStats(): { size: number; entries: number } {
    return {
      size: this.cache.size,
      entries: this.cache.size,
    };
  }
}

export default AvatarCacheService;
