/**
 * Platform Abstraction Layer
 *
 * This module automatically selects the appropriate adapter implementations
 * based on the current platform (mobile app vs Chrome extension).
 *
 * Usage:
 * ```typescript
 * import { crypto, secureStorage, storage, biometrics } from '@/platform';
 *
 * // These work identically on both platforms
 * await secureStorage.setItem('key', 'value');
 * const randomBytes = await crypto.getRandomBytes(32);
 * ```
 */

export * from './types';
export * from './detection';

import { isMobile, isExtension, getCachedPlatform } from './detection';
import type {
  CryptoAdapter,
  SecureStorageAdapter,
  StorageAdapter,
  BiometricAdapter,
  DeviceIdAdapter,
  ClipboardAdapter,
  AlertAdapter,
} from './types';

// Lazy-loaded adapters to avoid importing platform-specific code on wrong platform
let _crypto: CryptoAdapter | null = null;
let _secureStorage: SecureStorageAdapter | null = null;
let _storage: StorageAdapter | null = null;
let _biometrics: BiometricAdapter | null = null;
let _deviceId: DeviceIdAdapter | null = null;
let _clipboard: ClipboardAdapter | null = null;
let _alert: AlertAdapter | null = null;

/**
 * Get the crypto adapter for the current platform
 */
export function getCrypto(): CryptoAdapter {
  if (!_crypto) {
    if (isMobile()) {
      const { mobileCrypto } = require('./mobile/crypto');
      _crypto = mobileCrypto;
    } else {
      const { extensionCrypto } = require('./extension/crypto');
      _crypto = extensionCrypto;
    }
  }
  return _crypto!;
}

/**
 * Get the secure storage adapter for the current platform
 */
export function getSecureStorage(): SecureStorageAdapter {
  if (!_secureStorage) {
    if (isMobile()) {
      const { mobileSecureStorage } = require('./mobile/secureStorage');
      _secureStorage = mobileSecureStorage;
    } else {
      const { extensionSecureStorage } = require('./extension/secureStorage');
      _secureStorage = extensionSecureStorage;
    }
  }
  return _secureStorage!;
}

/**
 * Get the general storage adapter for the current platform
 */
export function getStorage(): StorageAdapter {
  if (!_storage) {
    if (isMobile()) {
      const { mobileStorage } = require('./mobile/storage');
      _storage = mobileStorage;
    } else {
      const { extensionStorage } = require('./extension/storage');
      _storage = extensionStorage;
    }
  }
  return _storage!;
}

/**
 * Get the biometrics/WebAuthn adapter for the current platform
 */
export function getBiometrics(): BiometricAdapter {
  if (!_biometrics) {
    if (isMobile()) {
      const { mobileBiometrics } = require('./mobile/biometrics');
      _biometrics = mobileBiometrics;
    } else {
      const { extensionBiometrics } = require('./extension/biometrics');
      _biometrics = extensionBiometrics;
    }
  }
  return _biometrics!;
}

/**
 * Get the device ID adapter for the current platform
 */
export function getDeviceId(): DeviceIdAdapter {
  if (!_deviceId) {
    if (isMobile()) {
      const { mobileDeviceId } = require('./mobile/deviceId');
      _deviceId = mobileDeviceId;
    } else {
      const { extensionDeviceId } = require('./extension/deviceId');
      _deviceId = extensionDeviceId;
    }
  }
  return _deviceId!;
}

/**
 * Get the clipboard adapter for the current platform
 */
export function getClipboard(): ClipboardAdapter {
  if (!_clipboard) {
    if (isMobile()) {
      const { mobileClipboard } = require('./mobile/clipboard');
      _clipboard = mobileClipboard;
    } else {
      const { extensionClipboard } = require('./extension/clipboard');
      _clipboard = extensionClipboard;
    }
  }
  return _clipboard!;
}

/**
 * Get the alert adapter for the current platform
 */
export function getAlert(): AlertAdapter {
  if (!_alert) {
    if (isMobile()) {
      const { mobileAlert } = require('./mobile/alert');
      _alert = mobileAlert;
    } else {
      const { extensionAlert } = require('./extension/alert');
      _alert = extensionAlert;
    }
  }
  return _alert!;
}

// Convenience exports for direct access (use getter functions for lazy loading)
// These are resolved at first access

/**
 * Platform-specific crypto operations
 */
export const crypto = {
  getRandomBytes: (byteCount: number) => getCrypto().getRandomBytes(byteCount),
  getRandomBytesSync: (byteCount: number) => {
    const adapter = getCrypto();
    if (adapter.getRandomBytesSync) {
      return adapter.getRandomBytesSync(byteCount);
    }
    throw new Error('Synchronous random bytes not available on this platform');
  },
  randomUUID: () => getCrypto().randomUUID(),
  sha256: (input: string) => getCrypto().sha256(input),
};

/**
 * Platform-specific secure storage (encrypted)
 */
export const secureStorage = {
  setItem: (key: string, value: string) => getSecureStorage().setItem(key, value),
  getItem: (key: string) => getSecureStorage().getItem(key),
  deleteItem: (key: string) => getSecureStorage().deleteItem(key),
  getItemWithAuth: (key: string, options: { prompt: string }) => {
    const adapter = getSecureStorage();
    if (adapter.getItemWithAuth) {
      return adapter.getItemWithAuth(key, options);
    }
    return adapter.getItem(key);
  },
};

/**
 * Platform-specific general storage
 */
export const storage = {
  getItem: (key: string) => getStorage().getItem(key),
  setItem: (key: string, value: string) => getStorage().setItem(key, value),
  removeItem: (key: string) => getStorage().removeItem(key),
  multiGet: (keys: string[]) => {
    const adapter = getStorage();
    if (adapter.multiGet) {
      return adapter.multiGet(keys);
    }
    return Promise.all(keys.map(async (key) => [key, await adapter.getItem(key)] as [string, string | null]));
  },
  multiRemove: (keys: string[]) => {
    const adapter = getStorage();
    if (adapter.multiRemove) {
      return adapter.multiRemove(keys);
    }
    return Promise.all(keys.map((key) => adapter.removeItem(key))).then(() => {});
  },
  getAllKeys: () => {
    const adapter = getStorage();
    if (adapter.getAllKeys) {
      return adapter.getAllKeys();
    }
    return Promise.resolve([]);
  },
};

/**
 * Platform-specific biometrics/WebAuthn
 */
export const biometrics = {
  isAvailable: () => getBiometrics().isAvailable(),
  isEnrolled: () => getBiometrics().isEnrolled(),
  getCapability: () => getBiometrics().getCapability(),
  authenticate: (options: { promptMessage: string; fallbackLabel?: string; cancelLabel?: string }) =>
    getBiometrics().authenticate(options),
  getAuthType: () => getBiometrics().getAuthType(),
  registerCredential: (options: { userId: string; userName: string }) => {
    const adapter = getBiometrics();
    if (adapter.registerCredential) {
      return adapter.registerCredential(options);
    }
    return Promise.resolve(null);
  },
};

/**
 * Platform-specific device ID
 */
export const deviceId = {
  getDeviceId: () => getDeviceId().getDeviceId(),
};

/**
 * Platform-specific clipboard
 */
export const clipboard = {
  setString: (text: string) => getClipboard().setString(text),
  getString: () => getClipboard().getString(),
};

/**
 * Platform-specific alerts
 */
export const alert = {
  show: (title: string, message?: string) => getAlert().alert(title, message),
};

/**
 * Reset all cached adapters (for testing)
 */
export function resetAdapters(): void {
  _crypto = null;
  _secureStorage = null;
  _storage = null;
  _biometrics = null;
  _deviceId = null;
  _clipboard = null;
  _alert = null;
}
