/**
 * Mobile Secure Storage Adapter
 * Uses expo-secure-store for hardware-backed encrypted storage
 */

import * as SecureStore from 'expo-secure-store';
import type { SecureStoreOptions } from 'expo-secure-store';
import { Platform } from 'react-native';
import type { SecureStorageAdapter } from '../types';

const SECURE_STORE_OPTIONS: SecureStoreOptions =
  Platform.OS === 'ios'
    ? { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
    : {};

export class MobileSecureStorageAdapter implements SecureStorageAdapter {
  async setItem(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value, SECURE_STORE_OPTIONS);
  }

  async getItem(key: string): Promise<string | null> {
    return await SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS);
  }

  async deleteItem(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
  }

  async getItemWithAuth(
    key: string,
    options: { prompt: string }
  ): Promise<string | null> {
    return await SecureStore.getItemAsync(key, {
      ...SECURE_STORE_OPTIONS,
      requireAuthentication: true,
      authenticationPrompt: options.prompt,
    });
  }
}

// Singleton instance
export const mobileSecureStorage = new MobileSecureStorageAdapter();
