import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LedgerDeviceInfo } from './transport';
import type { DeviceModelId } from '@ledgerhq/devices';

export interface PersistedLedgerDevice {
  id: string;
  name: string;
  type: 'ble' | 'usb';
  modelId?: string;
  productId?: number;
  vendorId?: number;
  lastSeen: string;
  lastConnected?: string;
}

/**
 * Handles persistence of Ledger device information across app sessions.
 * Stores device metadata (excluding sensitive connection descriptors) in AsyncStorage.
 */
export class LedgerDeviceStorage {
  private static readonly STORAGE_KEY = 'voi_wallet_ledger_devices_v1';
  private static instance: LedgerDeviceStorage;

  static getInstance(): LedgerDeviceStorage {
    if (!LedgerDeviceStorage.instance) {
      LedgerDeviceStorage.instance = new LedgerDeviceStorage();
    }
    return LedgerDeviceStorage.instance;
  }

  private constructor() {}

  /**
   * Load all persisted device information from storage
   */
  async loadDevices(): Promise<PersistedLedgerDevice[]> {
    try {
      const stored = await AsyncStorage.getItem(LedgerDeviceStorage.STORAGE_KEY);
      if (!stored) {
        return [];
      }

      const devices: PersistedLedgerDevice[] = JSON.parse(stored);

      // Validate and clean up any invalid entries
      return devices.filter(device => {
        // Type validation
        if (typeof device.id !== 'string' || device.id.length === 0) return false;
        if (typeof device.name !== 'string' || device.name.length === 0) return false;
        if (!['ble', 'usb'].includes(device.type)) return false;

        // Date validation
        if (!device.lastSeen || isNaN(new Date(device.lastSeen).getTime())) return false;
        if (device.lastConnected && isNaN(new Date(device.lastConnected).getTime())) return false;

        // Optional numeric validation
        if (device.productId !== undefined && !Number.isInteger(device.productId)) return false;
        if (device.vendorId !== undefined && !Number.isInteger(device.vendorId)) return false;

        return true;
      });
    } catch (error) {
      console.error('Failed to load persisted Ledger devices:', error);
      return [];
    }
  }

  /**
   * Save device information to storage
   */
  async saveDevice(deviceInfo: LedgerDeviceInfo): Promise<void> {
    try {
      const devices = await this.loadDevices();

      // Convert LedgerDeviceInfo to PersistedLedgerDevice
      const persistedDevice: PersistedLedgerDevice = {
        id: deviceInfo.id,
        name: deviceInfo.name,
        type: deviceInfo.type,
        modelId: deviceInfo.modelId,
        productId: deviceInfo.productId,
        vendorId: deviceInfo.vendorId,
        lastSeen: deviceInfo.lastSeen,
        lastConnected: deviceInfo.lastConnected,
      };

      // Update existing device or add new one
      const existingIndex = devices.findIndex(d => d.id === deviceInfo.id);
      if (existingIndex >= 0) {
        devices[existingIndex] = persistedDevice;
      } else {
        devices.push(persistedDevice);
      }

      await AsyncStorage.setItem(
        LedgerDeviceStorage.STORAGE_KEY,
        JSON.stringify(devices)
      );

      console.log('Ledger device saved to storage:', deviceInfo.id);
    } catch (error) {
      console.error('Failed to save Ledger device:', error);
      // Don't throw - persistence failures shouldn't break functionality
    }
  }

  /**
   * Remove a device from storage
   */
  async removeDevice(deviceId: string): Promise<void> {
    try {
      const devices = await this.loadDevices();
      const filtered = devices.filter(d => d.id !== deviceId);

      await AsyncStorage.setItem(
        LedgerDeviceStorage.STORAGE_KEY,
        JSON.stringify(filtered)
      );

      console.log('Ledger device removed from storage:', deviceId);
    } catch (error) {
      console.error('Failed to remove Ledger device:', error);
      // Don't throw - persistence failures shouldn't break functionality
    }
  }

  /**
   * Find a persisted device by ID
   */
  async findDevice(deviceId: string): Promise<PersistedLedgerDevice | null> {
    try {
      const devices = await this.loadDevices();
      return devices.find(d => d.id === deviceId) || null;
    } catch (error) {
      console.error('Failed to find persisted Ledger device:', error);
      return null;
    }
  }

  /**
   * Update the last connected timestamp for a device
   */
  async updateLastConnected(deviceId: string): Promise<void> {
    try {
      const devices = await this.loadDevices();
      const deviceIndex = devices.findIndex(d => d.id === deviceId);

      if (deviceIndex >= 0) {
        devices[deviceIndex].lastConnected = new Date().toISOString();

        await AsyncStorage.setItem(
          LedgerDeviceStorage.STORAGE_KEY,
          JSON.stringify(devices)
        );
      }
    } catch (error) {
      console.error('Failed to update last connected timestamp:', error);
      // Don't throw - persistence failures shouldn't break functionality
    }
  }

  /**
   * Clear all persisted device data
   */
  async clearAll(): Promise<void> {
    try {
      await AsyncStorage.removeItem(LedgerDeviceStorage.STORAGE_KEY);
      console.log('All persisted Ledger devices cleared');
    } catch (error) {
      console.error('Failed to clear persisted Ledger devices:', error);
    }
  }

  /**
   * Convert a PersistedLedgerDevice back to LedgerDeviceInfo format
   * Note: connected status will be false since this is just persisted data
   */
  static toDeviceInfo(persisted: PersistedLedgerDevice): LedgerDeviceInfo {
    return {
      id: persisted.id,
      name: persisted.name,
      type: persisted.type,
      connected: false, // Persisted devices are not connected by default
      modelId: persisted.modelId as DeviceModelId | undefined,
      productId: persisted.productId,
      vendorId: persisted.vendorId,
      lastSeen: persisted.lastSeen,
      lastConnected: persisted.lastConnected,
    };
  }
}

export const ledgerDeviceStorage = LedgerDeviceStorage.getInstance();