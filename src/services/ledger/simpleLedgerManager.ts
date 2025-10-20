import { Platform, PermissionsAndroid } from 'react-native';
import type { Permission, PermissionStatus } from 'react-native';
import TransportBLE from '@ledgerhq/react-native-hw-transport-ble';
import TransportHID from '@ledgerhq/react-native-hid';
import Transport from '@ledgerhq/hw-transport';
import type { Device as BleDevice } from 'react-native-ble-plx';
import type { DeviceModelId } from '@ledgerhq/devices';

import { LedgerDeviceNotConnectedError, LedgerAccountError } from '@/types/wallet';

export interface SimpleLedgerDevice {
  id: string;
  name: string;
  type: 'ble' | 'usb';
  connected: boolean;
  modelId?: DeviceModelId;
  lastSeen: string;
}

export type LedgerConnectionState =
  | 'disconnected'
  | 'discovering'
  | 'connecting'
  | 'ready'
  | 'signing'
  | 'error';

export type LedgerError =
  | 'device_not_found'
  | 'device_locked'
  | 'app_not_open'
  | 'connection_failed'
  | 'permission_denied'
  | 'unknown';

export interface LedgerStateChange {
  state: LedgerConnectionState;
  device?: SimpleLedgerDevice;
  error?: {
    type: LedgerError;
    message: string;
    retryable: boolean;
    userAction?: string;
  };
}

/**
 * Simplified Ledger Manager
 * Replaces the overly complex LedgerTransportService with a simple, reliable interface
 */
export class SimpleLedgerManager {
  private static instance: SimpleLedgerManager;

  private currentState: LedgerConnectionState = 'disconnected';
  private currentDevice: SimpleLedgerDevice | null = null;
  private currentTransport: Transport | null = null;
  private listeners: Set<(state: LedgerStateChange) => void> = new Set();

  // Discovery management
  private bleSubscription: any = null;
  private usbSubscription: any = null;
  private discoveredDevices = new Map<string, SimpleLedgerDevice>();
  private isDiscovering = false;

  // Connection management
  private connectionPromise: Promise<Transport> | null = null;
  private lastError: { type: LedgerError; message: string } | null = null;

  static getInstance(): SimpleLedgerManager {
    if (!SimpleLedgerManager.instance) {
      SimpleLedgerManager.instance = new SimpleLedgerManager();
    }
    return SimpleLedgerManager.instance;
  }

  private constructor() {}

  /**
   * Subscribe to state changes
   */
  onStateChange(listener: (state: LedgerStateChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get current state
   */
  getState(): LedgerStateChange {
    return {
      state: this.currentState,
      device: this.currentDevice || undefined,
      error: this.lastError ? {
        type: this.lastError.type,
        message: this.lastError.message,
        retryable: this.isRetryableError(this.lastError.type),
        userAction: this.getUserAction(this.lastError.type),
      } : undefined,
    };
  }

  /**
   * Get active transport (for signing operations)
   */
  getTransport(): Transport | null {
    return this.currentTransport;
  }

  /**
   * Connect to a Ledger device with automatic retry logic
   */
  async connect(deviceId?: string): Promise<Transport> {
    // If already connecting, wait for that to complete
    if (this.connectionPromise) {
      try {
        return await this.connectionPromise;
      } catch (error) {
        // Continue with new connection attempt
      }
    }

    this.connectionPromise = this.performConnection(deviceId);

    try {
      const transport = await this.connectionPromise;
      this.connectionPromise = null;
      return transport;
    } catch (error) {
      this.connectionPromise = null;
      throw error;
    }
  }

  /**
   * Disconnect from current device
   */
  async disconnect(): Promise<void> {
    if (this.currentTransport) {
      try {
        await this.currentTransport.close();
      } catch (error) {
        console.warn('Error closing transport:', error);
      }
    }

    this.currentTransport = null;
    this.currentDevice = null;
    this.updateState('disconnected');
    this.stopDiscovery();
  }

  /**
   * Retry connection with smart error handling
   */
  async retry(): Promise<Transport> {
    // Clear any previous error
    this.lastError = null;

    // If we have a known device, try to reconnect to it
    const deviceId = this.currentDevice?.id;
    return this.connect(deviceId);
  }

  /**
   * Check if device is ready for signing (app open, unlocked)
   */
  async verifyDeviceReady(): Promise<boolean> {
    if (!this.currentTransport) {
      throw new LedgerDeviceNotConnectedError('No device connected');
    }

    try {
      // Try to get app info - this will fail if device is locked or wrong app
      const response = await this.currentTransport.send(0xb0, 0x01, 0x00, 0x00);

      // Parse response to check app name
      if (response.length >= 3) {
        const appNameLength = response[1];
        const appName = response.slice(2, 2 + appNameLength).toString('ascii');

        if (appName.toLowerCase() !== 'algorand') {
          this.setError('app_not_open', 'Please open the Algorand app on your Ledger device');
          return false;
        }
      }

      return true;
    } catch (error) {
      console.log('Device verification failed:', error);

      // Determine error type from the error
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (errorMessage.includes('6982')) {
        this.setError('device_locked', 'Please unlock your Ledger device');
      } else if (errorMessage.includes('6e00')) {
        this.setError('app_not_open', 'Please open the Algorand app on your Ledger device');
      } else {
        this.setError('connection_failed', 'Failed to communicate with Ledger device');
      }

      return false;
    }
  }

  /**
   * Perform the actual connection process
   */
  private async performConnection(deviceId?: string): Promise<Transport> {
    this.updateState('discovering');

    try {
      // Start discovery if not already running
      await this.startDiscovery();

      // If specific device requested, try to find it
      let targetDevice: SimpleLedgerDevice | null = null;

      if (deviceId) {
        targetDevice = this.discoveredDevices.get(deviceId) || null;
        if (!targetDevice) {
          // Wait a bit for device to be discovered
          targetDevice = await this.waitForDevice(deviceId, 10000);
        }
      } else {
        // Use first available device or wait for one
        const devices = Array.from(this.discoveredDevices.values());
        targetDevice = devices[0] || null;

        if (!targetDevice) {
          targetDevice = await this.waitForAnyDevice(10000);
        }
      }

      if (!targetDevice) {
        throw new Error('No Ledger device found');
      }

      this.updateState('connecting', targetDevice);

      // Open transport based on device type
      const transport = await this.openTransport(targetDevice);

      // Setup disconnect handler
      this.setupDisconnectHandler(transport);

      this.currentTransport = transport;
      this.currentDevice = targetDevice;
      this.updateState('ready', targetDevice);

      return transport;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Connection failed:', errorMessage);

      // Determine error type and set appropriate error
      if (errorMessage.includes('Permission') || errorMessage.includes('permission')) {
        this.setError('permission_denied', 'Bluetooth permissions required. Please enable Bluetooth permissions for this app.');
      } else if (errorMessage.includes('not found') || errorMessage.includes('No Ledger')) {
        this.setError('device_not_found', 'No Ledger device found. Please connect and unlock your device.');
      } else {
        this.setError('connection_failed', errorMessage);
      }

      throw new LedgerDeviceNotConnectedError(errorMessage);
    } finally {
      this.stopDiscovery();
    }
  }

  /**
   * Start device discovery
   */
  private async startDiscovery(): Promise<void> {
    if (this.isDiscovering) return;

    this.isDiscovering = true;

    // Start BLE discovery
    if (Platform.OS === 'ios' || await this.checkBluetoothPermissions()) {
      await this.startBleDiscovery();
    }

    // Start USB discovery (mainly for Android with OTG)
    await this.startUsbDiscovery();
  }

  /**
   * Stop device discovery
   */
  private stopDiscovery(): void {
    if (!this.isDiscovering) return;

    this.isDiscovering = false;

    if (this.bleSubscription) {
      this.bleSubscription.unsubscribe();
      this.bleSubscription = null;
    }

    if (this.usbSubscription) {
      this.usbSubscription.unsubscribe();
      this.usbSubscription = null;
    }
  }

  /**
   * Start BLE discovery
   */
  private async startBleDiscovery(): Promise<void> {
    try {
      const supported = await TransportBLE.isSupported();
      if (!supported) return;

      this.bleSubscription = TransportBLE.listen({
        next: (event: any) => {
          if (event.type === 'add' && event.descriptor) {
            const device: SimpleLedgerDevice = {
              id: event.descriptor.id,
              name: event.descriptor.name || 'Ledger Device',
              type: 'ble',
              connected: false,
              modelId: event.deviceModel?.id,
              lastSeen: new Date().toISOString(),
            };

            this.discoveredDevices.set(device.id, device);
          }
        },
        error: (error: any) => {
          console.warn('BLE discovery error:', error);
        },
        complete: () => {
          this.bleSubscription = null;
        },
      });
    } catch (error) {
      console.warn('Failed to start BLE discovery:', error);
    }
  }

  /**
   * Start USB discovery
   */
  private async startUsbDiscovery(): Promise<void> {
    try {
      const supported = await TransportHID.isSupported();
      if (!supported) return;

      this.usbSubscription = TransportHID.listen({
        next: (event: any) => {
          if (event.type === 'add' && event.descriptor) {
            const id = `${event.descriptor.vendorId}:${event.descriptor.productId}`;
            const device: SimpleLedgerDevice = {
              id,
              name: event.descriptor.productName || 'Ledger USB',
              type: 'usb',
              connected: false,
              modelId: event.deviceModel?.id,
              lastSeen: new Date().toISOString(),
            };

            this.discoveredDevices.set(device.id, device);
          }
        },
        error: (error: any) => {
          console.warn('USB discovery error:', error);
        },
        complete: () => {
          this.usbSubscription = null;
        },
      });
    } catch (error) {
      console.warn('Failed to start USB discovery:', error);
    }
  }

  /**
   * Open transport for a device
   */
  private async openTransport(device: SimpleLedgerDevice): Promise<Transport> {
    if (device.type === 'ble') {
      return await TransportBLE.open(device.id);
    } else {
      // For USB, we need to reconstruct the descriptor
      const [vendorId, productId] = device.id.split(':').map(Number);
      return await TransportHID.open({ vendorId, productId });
    }
  }

  /**
   * Setup disconnect handler
   */
  private setupDisconnectHandler(transport: Transport): void {
    const handler = () => {
      if (this.currentTransport === transport) {
        this.currentTransport = null;
        this.currentDevice = null;
        this.updateState('disconnected');
      }
    };

    // Try different event listener methods
    const anyTransport = transport as any;
    if (typeof anyTransport.on === 'function') {
      anyTransport.on('disconnect', handler);
    } else if (typeof anyTransport.addListener === 'function') {
      anyTransport.addListener('disconnect', handler);
    }
  }

  /**
   * Wait for a specific device to be discovered
   */
  private async waitForDevice(deviceId: string, timeoutMs: number): Promise<SimpleLedgerDevice | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), timeoutMs);

      const checkDevice = () => {
        const device = this.discoveredDevices.get(deviceId);
        if (device) {
          clearTimeout(timeout);
          resolve(device);
        } else {
          setTimeout(checkDevice, 100);
        }
      };

      checkDevice();
    });
  }

  /**
   * Wait for any device to be discovered
   */
  private async waitForAnyDevice(timeoutMs: number): Promise<SimpleLedgerDevice | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), timeoutMs);

      const checkDevices = () => {
        const devices = Array.from(this.discoveredDevices.values());
        if (devices.length > 0) {
          clearTimeout(timeout);
          resolve(devices[0]);
        } else {
          setTimeout(checkDevices, 100);
        }
      };

      checkDevices();
    });
  }

  /**
   * Check Bluetooth permissions
   */
  private async checkBluetoothPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;

    try {
      const permissions: Permission[] = [];
      const sdkVersion = typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10) || 0;

      if (sdkVersion >= 31) {
        permissions.push(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
        );
        if (sdkVersion < 33) {
          permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
        }
      } else {
        permissions.push(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
      }

      if (permissions.length === 0) return true;

      const results = await PermissionsAndroid.requestMultiple(permissions);
      return permissions.every(permission => results[permission] === PermissionsAndroid.RESULTS.GRANTED);
    } catch (error) {
      console.error('Permission check failed:', error);
      return false;
    }
  }

  /**
   * Update state and notify listeners
   */
  private updateState(state: LedgerConnectionState, device?: SimpleLedgerDevice): void {
    this.currentState = state;

    // Clear error when state changes to non-error state
    if (state !== 'error') {
      this.lastError = null;
    }

    const stateChange: LedgerStateChange = {
      state,
      device: device || this.currentDevice || undefined,
      error: this.lastError ? {
        type: this.lastError.type,
        message: this.lastError.message,
        retryable: this.isRetryableError(this.lastError.type),
        userAction: this.getUserAction(this.lastError.type),
      } : undefined,
    };

    this.listeners.forEach(listener => {
      try {
        listener(stateChange);
      } catch (error) {
        console.error('State listener error:', error);
      }
    });
  }

  /**
   * Set error state
   */
  private setError(type: LedgerError, message: string): void {
    this.lastError = { type, message };
    this.updateState('error');
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(type: LedgerError): boolean {
    switch (type) {
      case 'device_locked':
      case 'app_not_open':
      case 'connection_failed':
      case 'device_not_found':
        return true;
      case 'permission_denied':
        return false;
      case 'unknown':
        return true;
    }
  }

  /**
   * Get user action for error type
   */
  private getUserAction(type: LedgerError): string {
    switch (type) {
      case 'device_locked':
        return 'Please unlock your Ledger device and try again';
      case 'app_not_open':
        return 'Please open the Algorand app on your Ledger device';
      case 'connection_failed':
        return 'Please check your device connection and try again';
      case 'device_not_found':
        return 'Please connect and unlock your Ledger device';
      case 'permission_denied':
        return 'Please enable Bluetooth permissions in Settings';
      case 'unknown':
        return 'Please try again or restart your device';
    }
  }

  /**
   * Mark signing in progress
   */
  setSigningInProgress(inProgress: boolean): void {
    if (inProgress && this.currentState === 'ready') {
      this.updateState('signing');
    } else if (!inProgress && this.currentState === 'signing') {
      this.updateState('ready');
    }
  }

  /**
   * Cleanup all resources
   */
  dispose(): void {
    this.stopDiscovery();
    this.disconnect();
    this.listeners.clear();
    this.discoveredDevices.clear();
  }
}

export const simpleLedgerManager = SimpleLedgerManager.getInstance();
