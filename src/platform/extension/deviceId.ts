/**
 * Extension Device ID Adapter
 * Generates and persists a unique installation identifier
 */

import type { DeviceIdAdapter } from '../types';
import { extensionStorage } from './storage';
import { extensionCrypto } from './crypto';

const DEVICE_ID_KEY = 'voi_device_installation_id';

export class ExtensionDeviceIdAdapter implements DeviceIdAdapter {
  private cachedId: string | null = null;

  async getDeviceId(): Promise<string> {
    // Return cached value if available
    if (this.cachedId) {
      return this.cachedId;
    }

    // Check if we already have a stored ID
    const existing = await extensionStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      this.cachedId = existing;
      return existing;
    }

    // Generate a new random installation ID
    const bytes = await extensionCrypto.getRandomBytes(16);
    const deviceId = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');

    // Store for future use
    await extensionStorage.setItem(DEVICE_ID_KEY, deviceId);
    this.cachedId = deviceId;

    return deviceId;
  }
}

// Singleton instance
export const extensionDeviceId = new ExtensionDeviceIdAdapter();
