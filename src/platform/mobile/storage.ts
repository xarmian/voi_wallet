/**
 * Mobile Storage Adapter
 * Uses @react-native-async-storage/async-storage for general storage
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { StorageAdapter } from '../types';

export class MobileStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    return await AsyncStorage.getItem(key);
  }

  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  }

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  }

  async multiGet(keys: string[]): Promise<[string, string | null][]> {
    const result = await AsyncStorage.multiGet(keys);
    return result as [string, string | null][];
  }

  async multiRemove(keys: string[]): Promise<void> {
    await AsyncStorage.multiRemove(keys);
  }

  async getAllKeys(): Promise<string[]> {
    const keys = await AsyncStorage.getAllKeys();
    return keys as string[];
  }
}

// Singleton instance
export const mobileStorage = new MobileStorageAdapter();
