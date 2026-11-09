/**
 * Mobile Device ID Adapter
 * Uses expo-application for platform-specific device identifiers
 */

import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import type { DeviceIdAdapter } from '../types';
import { mobileSecureStorage } from './secureStorage';

const DEVICE_ID_KEY = 'voi_device_installation_id';

export class MobileDeviceIdAdapter implements DeviceIdAdapter {
  private cachedId: string | null = null;
  // TASK-449: one load at a time. Callers bound this read, so an abandoned load
  // can still be running; a second load beside it could read the same absence,
  // mint a different id and overwrite the first one's key-derivation id.
  private inFlight: Promise<string> | null = null;

  async getDeviceId(): Promise<string> {
    // Return cached value if available
    if (this.cachedId) {
      return this.cachedId;
    }
    if (!this.inFlight) {
      this.inFlight = this.loadOrCreate().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async loadOrCreate(): Promise<string> {
    // Check if we already have a stored ID
    const existing = await mobileSecureStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      this.cachedId = existing;
      return existing;
    }

    // Try to get platform-specific identifier
    let deviceId: string | null = null;

    // Try iOS vendor ID
    try {
      const iosGetter = (Application as any).getIosIdForVendorAsync;
      if (typeof iosGetter === 'function') {
        deviceId = await iosGetter.call(Application);
      }
    } catch {
      // Not iOS or not available
    }

    // Try Android ID
    if (!deviceId) {
      try {
        const androidId = (Application as any).androidId;
        if (typeof androidId === 'string' && androidId.length > 0) {
          deviceId = androidId;
        }
      } catch {
        // Not Android or not available
      }
    }

    // Fallback: generate a random ID
    if (!deviceId) {
      const bytes = await Crypto.getRandomBytesAsync(16);
      deviceId = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
    }

    // Store for future use
    await mobileSecureStorage.setItem(DEVICE_ID_KEY, deviceId);
    this.cachedId = deviceId;

    return deviceId;
  }
}

// Singleton instance
export const mobileDeviceId = new MobileDeviceIdAdapter();
