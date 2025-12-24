/**
 * Extension Storage Adapter
 * Uses chrome.storage.local for general storage
 * Falls back to localStorage if chrome APIs not available
 */

import type { StorageAdapter } from '../types';

// Check if chrome.storage is available
const hasChromeStorage = typeof chrome !== 'undefined' &&
  chrome.storage &&
  chrome.storage.local;

export class ExtensionStorageAdapter implements StorageAdapter {
  async getItem(key: string): Promise<string | null> {
    if (!hasChromeStorage) {
      // Fallback to localStorage for web builds
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }

    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result[key] ?? null);
      });
    });
  }

  async setItem(key: string, value: string): Promise<void> {
    if (!hasChromeStorage) {
      try {
        localStorage.setItem(key, value);
        return;
      } catch (e) {
        throw new Error(`localStorage setItem failed: ${e}`);
      }
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  async removeItem(key: string): Promise<void> {
    if (!hasChromeStorage) {
      try {
        localStorage.removeItem(key);
        return;
      } catch {
        return;
      }
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.remove([key], () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  async multiGet(keys: string[]): Promise<[string, string | null][]> {
    if (!hasChromeStorage) {
      return keys.map((key) => {
        try {
          return [key, localStorage.getItem(key)] as [string, string | null];
        } catch {
          return [key, null] as [string, string | null];
        }
      });
    }

    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => {
        const entries: [string, string | null][] = keys.map((key) => [
          key,
          result[key] ?? null,
        ]);
        resolve(entries);
      });
    });
  }

  async multiRemove(keys: string[]): Promise<void> {
    if (!hasChromeStorage) {
      keys.forEach((key) => {
        try {
          localStorage.removeItem(key);
        } catch {
          // ignore
        }
      });
      return;
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  async getAllKeys(): Promise<string[]> {
    if (!hasChromeStorage) {
      try {
        return Object.keys(localStorage);
      } catch {
        return [];
      }
    }

    return new Promise((resolve) => {
      chrome.storage.local.get(null, (result) => {
        resolve(Object.keys(result));
      });
    });
  }
}

// Singleton instance
export const extensionStorage = new ExtensionStorageAdapter();
