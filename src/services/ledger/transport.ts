import { Platform, PermissionsAndroid } from 'react-native';
import type { Permission, PermissionStatus } from 'react-native';
import TransportBLE from '@ledgerhq/react-native-hw-transport-ble';
import TransportHID from '@ledgerhq/react-native-hid';
import Transport from '@ledgerhq/hw-transport';
import type { Subscription as TransportSubscription } from '@ledgerhq/hw-transport';
import type { Device as BleDevice } from 'react-native-ble-plx';
import type { DeviceModelId } from '@ledgerhq/devices';

import {
  LedgerDeviceNotConnectedError,
  LedgerAccountError,
} from '@/types/wallet';
import { ledgerDeviceStorage, LedgerDeviceStorage } from './storage';
import { isLedgerSigningInProgress } from '@/services/ledger/signingState';

export type LedgerTransportType = 'ble' | 'usb';

export interface LedgerDeviceInfo {
  id: string;
  name: string;
  type: LedgerTransportType;
  connected: boolean;
  modelId?: DeviceModelId;
  productId?: number;
  vendorId?: number;
  rssi?: number;
  lastSeen: string;
  lastConnected?: string;
}

export interface LedgerPermissionsStatus {
  bluetoothAuthorized: boolean;
  usbAuthorized: boolean;
}

export type LedgerTransportEventMap = {
  deviceDiscovered: LedgerDeviceInfo;
  deviceUpdated: LedgerDeviceInfo;
  deviceRemoved: { id: string };
  connected: LedgerDeviceInfo;
  disconnected: LedgerDeviceInfo | { id: string };
  permissions: LedgerPermissionsStatus;
  error: Error;
};

type LedgerTransportListener<Event extends keyof LedgerTransportEventMap> = (
  payload: LedgerTransportEventMap[Event]
) => void;

interface LedgerDeviceRecord {
  info: LedgerDeviceInfo;
  descriptor?: BleDevice | { vendorId: number; productId: number };
}

interface ConnectOptions {
  timeoutMs?: number;
  transportType?: LedgerTransportType;
  forceReconnect?: boolean;
}

interface InitializeOptions {
  enableBle?: boolean;
  enableUsb?: boolean;
  autoStartDiscovery?: boolean;
}

/**
 * Centralizes Ledger transport management for BLE and USB connections.
 * Handles device discovery, permissions, connection lifecycle, and reconnection.
 */
export class LedgerTransportService {
  private static instance: LedgerTransportService;

  private bleSubscription: TransportSubscription | null = null;
  private usbSubscription: TransportSubscription | null = null;
  private currentTransport: Transport | null = null;
  private currentDeviceId: string | null = null;
  private connectingDeviceId: string | null = null;
  private currentDisconnectHandler: ((...args: any[]) => void) | null = null;
  private listeners: {
    [Event in keyof LedgerTransportEventMap]: Set<
      LedgerTransportListener<Event>
    >;
  } = {
    deviceDiscovered: new Set(),
    deviceUpdated: new Set(),
    deviceRemoved: new Set(),
    connected: new Set(),
    disconnected: new Set(),
    permissions: new Set(),
    error: new Set(),
  };

  private devices = new Map<string, LedgerDeviceRecord>();
  private lastPermissions: LedgerPermissionsStatus = {
    bluetoothAuthorized: Platform.OS !== 'android',
    usbAuthorized: Platform.OS !== 'android',
  };
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  
  // Storage throttling to prevent excessive saves
  private saveThrottleTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly SAVE_THROTTLE_MS = 1000; // 1 second throttle
  private healthCheckIntervalMs: number = 15000;
  private disposed = false;
  // Guard to avoid races when multiple connect calls happen while scanning
  private isConnecting: boolean = false;
  // Cancellation flag to allow aborting in-flight connection attempts
  private cancelRequested: boolean = false;
  // Cooldown after a cancel to avoid unstable BLE state
  private lastCancelAt: number | null = null;
  // Global backoff to suppress new connects after cancel/failure
  private backoffUntil: number | null = null;
  private bleDiscoveryRefCount = 0;
  private usbDiscoveryRefCount = 0;
  private bleDiscoveryStartPromise: Promise<void> | null = null;
  private usbDiscoveryStartPromise: Promise<void> | null = null;
  private bleEnabled = true;
  private usbEnabled = true;

  static getInstance(): LedgerTransportService {
    if (!LedgerTransportService.instance) {
      LedgerTransportService.instance = new LedgerTransportService();
    }
    return LedgerTransportService.instance;
  }

  private constructor() {}

  on<Event extends keyof LedgerTransportEventMap>(
    event: Event,
    listener: LedgerTransportListener<Event>
  ): () => void {
    this.listeners[event].add(listener as LedgerTransportListener<any>);
    return () => {
      this.listeners[event].delete(listener as LedgerTransportListener<any>);
    };
  }

  async initialize(options: InitializeOptions = {}): Promise<void> {
    const {
      enableBle = true,
      enableUsb = true,
      autoStartDiscovery = false,
    } = options;

    this.bleEnabled = enableBle;
    this.usbEnabled = enableUsb;

    // Load previously discovered devices from storage
    await this.loadPersistedDevices();

    if (!enableBle) {
      this.stopDiscovery({ ble: true });
    }

    if (!enableUsb) {
      this.stopDiscovery({ usb: true });
    }

    if (autoStartDiscovery) {
      await this.startDiscovery({
        ble: enableBle,
        usb: enableUsb,
      });
    }

    // Begin passive connection health monitoring
    this.startConnectionHealthMonitoring();
  }

  getConnectedDevice(): LedgerDeviceInfo | null {
    if (!this.currentDeviceId) {
      return null;
    }
    const record = this.devices.get(this.currentDeviceId);
    return record?.info ?? null;
  }

  getDevices(): LedgerDeviceInfo[] {
    return Array.from(this.devices.values()).map((record) => record.info);
  }

  async connect(
    deviceId: string,
    options: ConnectOptions = {}
  ): Promise<Transport> {
    const { timeoutMs, transportType, forceReconnect = false } = options;

    console.log('Ledger Connect Request:', { deviceId, options });

    if (!deviceId) {
      throw new LedgerDeviceNotConnectedError(
        'A valid Ledger device identifier is required'
      );
    }

    // If cancellation requested, do not start connection
    if (this.cancelRequested) {
      throw new Error('Connection cancelled');
    }

    // If we recently cancelled a connection, wait a short cooldown to let BLE stack settle
    if (this.lastCancelAt) {
      const since = Date.now() - this.lastCancelAt;
      const cooldownMs = 1500;
      if (since < cooldownMs) {
        const waitMs = cooldownMs - since;
        console.log(`Ledger Waiting ${waitMs}ms after recent cancel before connecting`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      this.lastCancelAt = null;
    }

    const record = this.devices.get(deviceId);
    const type = transportType ?? record?.info.type;

    console.log('Ledger Device Record:', { record: record?.info, type });

    if (!type) {
      throw new LedgerDeviceNotConnectedError(
        'Unable to determine transport type for Ledger device'
      );
    }

    if (this.currentTransport && this.currentDeviceId === deviceId) {
      if (!forceReconnect) {
        console.log('Ledger Already Connected, Reusing Transport');
        return this.currentTransport;
      }
      console.log('Ledger Force Reconnect, Disconnecting First');
      await this.disconnect();
    } else if (this.currentTransport && this.currentDeviceId) {
      console.log('Ledger Switching Devices, Disconnecting Current');
      await this.disconnect();
    }

    // If any connection is underway but was cancelled, don't block retries
    if (this.isConnecting) {
      console.log('Ledger Connection In Progress, Waiting...');
      await this.waitWhileConnecting((timeoutMs || 30000) / 3);
    }

    if (this.connectingDeviceId) {
      console.log('Ledger Another Connection In Progress, Waiting...');
      await this.awaitActiveConnection((timeoutMs || 30000) / 3);
      if (this.currentTransport && this.currentDeviceId === deviceId && !forceReconnect) {
        console.log('Ledger Reusing Transport After Wait');
        return this.currentTransport;
      }
    }

    this.connectingDeviceId = deviceId;
    this.isConnecting = true;
    this.cancelRequested = false;
    console.log('Ledger Starting Connection Process');

    // Continuous retry mechanism for connection until cancel
    let lastError: Error | null = null;
    const usingBle = type === 'ble';

    if (usingBle) {
      await this.startDiscovery({ ble: true, usb: false });
    }

    try {
      for (let attempt = 1; ; attempt++) {
        if (this.cancelRequested) {
          lastError = new Error('Connection cancelled');
          break;
        }
        try {
        console.log(`Ledger Connection Attempt ${attempt}`);

        // Ensure device is discovered and obtain a fresh descriptor
        let bleDescriptor: BleDevice | string | undefined = undefined;
        if (usingBle) {
          // Give the device longer to appear after being powered on
          const discovered = await this.waitForDevice(deviceId, 12000);
          if (this.cancelRequested) {
            lastError = new Error('Connection cancelled');
            break;
          }

          const freshRecord = this.devices.get(deviceId);
          bleDescriptor = freshRecord?.descriptor as BleDevice | string | undefined;

          if (!bleDescriptor) {
            if (!discovered) {
              console.log('Ledger BLE descriptor unavailable; attempting direct open with device id');
            } else {
              console.log('Ledger BLE descriptor missing after discovery; falling back to device id');
            }
            bleDescriptor = deviceId;
          }
        }
        const transport =
          type === 'ble'
            ? await this.openBleTransport(
                deviceId,
                bleDescriptor
              )
            : await this.openUsbTransport(record?.descriptor || this.createUsbDescriptorFromDeviceInfo(record?.info));

        console.log('Ledger Transport Opened Successfully');

        if (this.cancelRequested) {
          // If cancelled after transport opened, close it immediately and abort
          try { await transport.close(); } catch {}
          lastError = new Error('Connection cancelled');
          break;
        }

        this.attachDisconnectListener(transport, deviceId);
        this.currentTransport = transport;
        this.currentDeviceId = deviceId;
        this.connectingDeviceId = null;
        this.isConnecting = false;

        this.markDeviceConnected(deviceId);
        console.log('Ledger Connection Complete');
        return transport;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          console.log(`Ledger Connection Attempt ${attempt} Failed:`, lastError.message);

          // Don't retry on permission errors
          if (lastError.message.includes('Permission') || lastError.message.includes('Unauthorized')) {
            break;
          }

          // Restart BLE discovery to refresh descriptors between attempts
          if (usingBle) {
            this.stopDiscovery({ ble: true, usb: false });
            await this.startDiscovery({ ble: true, usb: false });
          }

          // Wait before next retry
          const delay = 2000;
          console.log(`Ledger Retrying Connection in ${delay}ms...`);
          await new Promise((resolve) => {
            let elapsed = 0;
            const step = 100;
            const tick = () => {
              if (this.cancelRequested || elapsed >= delay) return resolve(undefined);
              elapsed += step;
              setTimeout(tick, step);
            };
            setTimeout(tick, step);
          });
        }
      }
    } finally {
      if (usingBle) {
        this.stopDiscovery({ ble: true, usb: false });
      }
    }

    this.connectingDeviceId = null;
    this.isConnecting = false;
    console.log('Ledger Connection Aborted:', lastError?.message);
    throw lastError || new Error('Connection cancelled');
  }

  /**
   * Cancel any in-flight connection attempt and stop discovery.
   */
  cancelConnect(): void {
    if (!this.isConnecting && !this.connectingDeviceId) {
      return;
    }
    console.log('Ledger Connection Cancel Requested');
    this.cancelRequested = true;
    this.lastCancelAt = Date.now();
    this.stopDiscovery({ ble: true, usb: true });
  }

  async disconnect(): Promise<void> {
    if (!this.currentTransport || !this.currentDeviceId) {
      return;
    }

    const deviceId = this.currentDeviceId;
    const transport = this.currentTransport;

    try {
      // Detach disconnect listener if supported to avoid leaks
      if (this.currentDisconnectHandler) {
        const anyTransport = transport as any;
        if (typeof anyTransport.off === 'function') {
          anyTransport.off('disconnect', this.currentDisconnectHandler);
        } else if (typeof anyTransport.removeListener === 'function') {
          anyTransport.removeListener('disconnect', this.currentDisconnectHandler);
        }
        this.currentDisconnectHandler = null;
      }
      await transport.close();
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      this.currentTransport = null;
      this.currentDeviceId = null;
      this.markDeviceDisconnected(deviceId);
    }
  }

  async reconnect(options: ConnectOptions = {}): Promise<Transport> {
    if (!this.currentDeviceId) {
      throw new LedgerDeviceNotConnectedError(
        'No Ledger device is currently connected'
      );
    }
    return this.connect(this.currentDeviceId, {
      ...options,
      forceReconnect: true,
    });
  }

  async switchDevice(
    deviceId: string,
    options: ConnectOptions = {}
  ): Promise<Transport> {
    if (this.currentDeviceId === deviceId && this.currentTransport) {
      return this.currentTransport;
    }
    await this.disconnect();
    return this.connect(deviceId, options);
  }

  getTransport(): Transport | null {
    return this.currentTransport;
  }

  private emit<Event extends keyof LedgerTransportEventMap>(
    event: Event,
    payload: LedgerTransportEventMap[Event]
  ): void {
    this.listeners[event].forEach((listener) => {
      try {
        listener(payload);
      } catch (error) {
        console.error(
          `LedgerTransportService listener error for event ${event}:`,
          error
        );
      }
    });
  }

  private async startBleDiscovery(): Promise<void> {
    console.log('Ledger startBleDiscovery invoked', {
      alreadySubscribed: Boolean(this.bleSubscription),
      bleEnabled: this.bleEnabled,
    });
    if (this.bleSubscription) {
      return;
    }

    if (!this.bleEnabled) {
      return;
    }

    const permissionGranted = await this.ensureBlePermissions();
    console.log('Ledger BLE permissions status', {
      permissionGranted,
      lastPermissions: this.lastPermissions,
    });
    if (!permissionGranted) {
      this.emit(
        'error',
        new LedgerAccountError(
          'Bluetooth permissions are required for Ledger discovery'
        )
      );
      return;
    }

    const supported = await TransportBLE.isSupported().catch((error) => {
      console.log('Ledger BLE support check failed', error);
      return false;
    });
    console.log('Ledger BLE supported?', supported);
    if (!supported) {
      this.emit(
        'error',
        new LedgerAccountError(
          'Bluetooth transport is not supported on this device'
        )
      );
      return;
    }

    console.log('Ledger subscribing to TransportBLE.listen');
    this.bleSubscription = TransportBLE.listen({
      next: (event: unknown) => {
        console.log('Ledger BLE Event', event);
        const { type, descriptor, deviceModel } = event as {
          type: 'add' | 'remove' | 'update';
          descriptor?: BleDevice;
          deviceModel?: { id: DeviceModelId };
        };

        if ((type === 'add' || type === 'update') && descriptor) {
          const info: LedgerDeviceInfo = {
            id: descriptor.id,
            name: descriptor.name ?? 'Ledger Nano',
            type: 'ble',
            connected: this.currentDeviceId === descriptor.id,
            modelId: deviceModel?.id,
            rssi: descriptor.rssi ?? undefined,
            lastSeen: new Date().toISOString(),
            lastConnected: this.devices.get(descriptor.id)?.info.lastConnected,
          };

          this.devices.set(descriptor.id, {
            info,
            descriptor,
          });

          this.emit(
            type === 'add' ? 'deviceDiscovered' : 'deviceUpdated',
            info
          );

          // Persist newly discovered devices
          if (type === 'add') {
            this.saveDeviceToStorage(info);
          }
        }

        if (type === 'remove' && descriptor) {
          this.devices.delete(descriptor.id);
          if (this.currentDeviceId === descriptor.id) {
            this.currentDeviceId = null;
            this.currentTransport = null;
          }
          this.emit('deviceRemoved', { id: descriptor.id });
        }
      },
      error: (error: unknown) =>
        this.emit(
          'error',
          error instanceof Error ? error : new Error(String(error))
        ),
      complete: () => {
        this.bleSubscription = null;
      },
    });
  }

  private stopBleDiscovery(): void {
    this.bleSubscription?.unsubscribe();
    this.bleSubscription = null;
  }

  private async acquireBleDiscovery(): Promise<void> {
    if (!this.bleEnabled) {
      return;
    }

    this.bleDiscoveryRefCount += 1;

    if (this.bleDiscoveryRefCount > 1) {
      if (this.bleDiscoveryStartPromise) {
        await this.bleDiscoveryStartPromise;
      }
      return;
    }

    if (this.bleSubscription) {
      return;
    }

    this.bleDiscoveryStartPromise = this.startBleDiscovery();
    try {
      await this.bleDiscoveryStartPromise;
    } finally {
      this.bleDiscoveryStartPromise = null;
    }
  }

  private releaseBleDiscovery(): void {
    if (this.bleDiscoveryRefCount === 0) {
      return;
    }

    this.bleDiscoveryRefCount -= 1;

    if (this.bleDiscoveryRefCount === 0) {
      this.stopBleDiscovery();
    }
  }

  private async startUsbDiscovery(): Promise<void> {
    if (this.usbSubscription) {
      return;
    }

    if (!this.usbEnabled) {
      return;
    }

    const supported = await TransportHID.isSupported().catch(() => false);
    this.updatePermissionsStatus({ usbAuthorized: supported });
    if (!supported) {
      this.emit(
        'error',
        new LedgerAccountError('USB transport is not supported on this device')
      );
      return;
    }

    this.usbSubscription = TransportHID.listen({
      next: (event: unknown) => {
        const { type, descriptor, deviceModel } = event as {
          type: 'add' | 'remove';
          descriptor: {
            vendorId: number;
            productId: number;
            productName?: string;
          } & Record<string, any>;
          deviceModel?: { id: DeviceModelId };
        };

        const id = this.getUsbDeviceId(descriptor);

        if (type === 'add') {
          const info: LedgerDeviceInfo = {
            id,
            name: descriptor.productName ?? 'Ledger USB',
            type: 'usb',
            connected: this.currentDeviceId === id,
            modelId: deviceModel?.id,
            productId: descriptor.productId,
            vendorId: descriptor.vendorId,
            lastSeen: new Date().toISOString(),
            lastConnected: this.devices.get(id)?.info.lastConnected,
          };

          this.devices.set(id, {
            info,
            descriptor: {
              vendorId: descriptor.vendorId,
              productId: descriptor.productId,
            },
          });

          this.emit('deviceDiscovered', info);

          // Persist newly discovered USB devices
          this.saveDeviceToStorage(info);
        }

        if (type === 'remove') {
          this.devices.delete(id);
          if (this.currentDeviceId === id) {
            this.currentDeviceId = null;
            this.currentTransport = null;
          }
          this.emit('deviceRemoved', { id });
        }
      },
      error: (error: unknown) =>
        this.emit(
          'error',
          error instanceof Error ? error : new Error(String(error))
        ),
      complete: () => {
        this.usbSubscription = null;
      },
    });
  }

  private stopUsbDiscovery(): void {
    this.usbSubscription?.unsubscribe?.();
    this.usbSubscription = null;
  }

  private async acquireUsbDiscovery(): Promise<void> {
    if (!this.usbEnabled) {
      return;
    }

    this.usbDiscoveryRefCount += 1;

    if (this.usbDiscoveryRefCount > 1) {
      if (this.usbDiscoveryStartPromise) {
        await this.usbDiscoveryStartPromise;
      }
      return;
    }

    if (this.usbSubscription) {
      return;
    }

    this.usbDiscoveryStartPromise = this.startUsbDiscovery();
    try {
      await this.usbDiscoveryStartPromise;
    } finally {
      this.usbDiscoveryStartPromise = null;
    }
  }

  private releaseUsbDiscovery(): void {
    if (this.usbDiscoveryRefCount === 0) {
      return;
    }

    this.usbDiscoveryRefCount -= 1;

    if (this.usbDiscoveryRefCount === 0) {
      this.stopUsbDiscovery();
    }
  }

  async startDiscovery(options: { ble?: boolean; usb?: boolean } = {}): Promise<void> {
    const { ble = true, usb = true } = options;

    const tasks: Promise<void>[] = [];

    if (ble) {
      tasks.push(this.acquireBleDiscovery());
    }

    if (usb) {
      tasks.push(this.acquireUsbDiscovery());
    }

    await Promise.all(tasks);
  }

  stopDiscovery(options: { ble?: boolean; usb?: boolean } = {}): void {
    const { ble = true, usb = true } = options;

    if (ble) {
      this.releaseBleDiscovery();
    }

    if (usb) {
      this.releaseUsbDiscovery();
    }
  }

  private async openBleTransport(
    deviceId: string,
    descriptor?: BleDevice | string
  ): Promise<Transport> {
    try {
      if (this.cancelRequested) {
        throw new Error('Connection cancelled');
      }
      // Prefer an up-to-date descriptor when available; fallback to deviceId
      const transport = await TransportBLE.open(descriptor ?? deviceId);
      if (this.cancelRequested) {
        try { (transport as any).close?.(); } catch {}
        throw new Error('Connection cancelled');
      }
      return transport;
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  private async openUsbTransport(
    descriptor?: LedgerDeviceRecord['descriptor']
  ): Promise<Transport> {
    const usbDescriptor = descriptor as
      | { vendorId: number; productId: number }
      | undefined;
    if (!usbDescriptor) {
      throw new LedgerDeviceNotConnectedError(
        'USB descriptor missing for Ledger device'
      );
    }

    try {
      const transport = await TransportHID.open(usbDescriptor);
      return transport;
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  private markDeviceConnected(deviceId: string): void {
    const record = this.devices.get(deviceId);
    if (!record) {
      return;
    }

    const info: LedgerDeviceInfo = {
      ...record.info,
      connected: true,
      lastConnected: new Date().toISOString(),
    };

    this.devices.set(deviceId, { ...record, info });
    this.emit('connected', info);

    // Persist connection information
    this.saveDeviceToStorage(info);
    this.updateDeviceLastConnected(deviceId);
  }

  private markDeviceDisconnected(deviceId: string): void {
    const record = this.devices.get(deviceId);
    if (!record) {
      this.emit('disconnected', { id: deviceId });
      return;
    }

    const info: LedgerDeviceInfo = {
      ...record.info,
      connected: false,
    };

    this.devices.set(deviceId, { ...record, info });
    this.emit('disconnected', info);
  }

  private attachDisconnectListener(
    transport: Transport,
    deviceId: string
  ): void {
    const handler = () => {
      if (this.currentDeviceId === deviceId) {
        this.currentTransport = null;
        this.currentDeviceId = null;
      }
      this.markDeviceDisconnected(deviceId);
    };
    this.currentDisconnectHandler = handler;
    const anyTransport = (transport as any);
    try {
      if (typeof anyTransport.on === 'function') {
        anyTransport.on('disconnect', handler);
      } else if (typeof anyTransport.addListener === 'function') {
        anyTransport.addListener('disconnect', handler);
      } else if (typeof anyTransport.addEventListener === 'function') {
        anyTransport.addEventListener('disconnect', handler);
      } else {
        console.log('Ledger Transport disconnect listener not supported');
      }
    } catch (e) {
      console.log('Ledger attachDisconnectListener error:', e);
    }
  }

  private async awaitActiveConnection(timeoutMs: number = 30000): Promise<void> {
    if (!this.connectingDeviceId && !this.isConnecting) {
      return;
    }
    let elapsed = 0;
    const step = 150;
    while ((this.connectingDeviceId || this.isConnecting) && elapsed < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, step));
      elapsed += step;
    }
  }

  private async waitWhileConnecting(timeoutMs: number = 30000): Promise<void> {
    if (!this.isConnecting) {
      return;
    }
    let elapsed = 0;
    const step = 150;
    while (this.isConnecting && elapsed < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, step));
      elapsed += step;
    }
  }

  private async ensureBlePermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') {
      this.updatePermissionsStatus({ bluetoothAuthorized: true });
      return true;
    }

    try {
      const sdkVersion =
        typeof Platform.Version === 'number'
          ? Platform.Version
          : parseInt(String(Platform.Version), 10) || 0;

      const permissions: Permission[] = [];

      if (sdkVersion >= 31) {
        permissions.push(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
        );
        if (sdkVersion < 33) {
          permissions.push(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
          );
        }
      } else {
        permissions.push(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
      }

      if (permissions.length === 0) {
        this.updatePermissionsStatus({ bluetoothAuthorized: true });
        return true;
      }

      const results = await PermissionsAndroid.requestMultiple(permissions);
      console.log('Ledger BLE permission request results', { results });
      const typedResults = results as Record<Permission, PermissionStatus>;
      const granted = permissions.every(
        (permission) => typedResults[permission] === PermissionsAndroid.RESULTS.GRANTED
      );

      this.updatePermissionsStatus({ bluetoothAuthorized: granted });
      console.log('Ledger BLE permissions granted?', granted);
      return granted;
    } catch (error) {
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error))
      );
      this.updatePermissionsStatus({ bluetoothAuthorized: false });
      return false;
    }
  }

  private updatePermissionsStatus(
    update: Partial<LedgerPermissionsStatus>
  ): void {
    this.lastPermissions = {
      ...this.lastPermissions,
      ...update,
    };
    this.emit('permissions', this.lastPermissions);
  }

  private getUsbDeviceId(descriptor: {
    productId: number;
    vendorId: number;
    productName?: string;
  }): string {
    return `${descriptor.vendorId}:${descriptor.productId}`;
  }

  /**
   * Wait for a specific device to be discovered within a timeout.
   */
  async waitForDevice(
    deviceId: string,
    timeoutMs: number = 15000
  ): Promise<LedgerDeviceInfo | null> {
    const existing = this.devices.get(deviceId)?.info;
    // Return immediately only if the device is already connected
    if (existing && existing.connected) return existing;

    const record = this.devices.get(deviceId);
    const shouldScanBle = this.bleEnabled && (!record || record.info.type !== 'usb');
    const shouldScanUsb = this.usbEnabled && (!record || record.info.type !== 'ble');

    await this.startDiscovery({ ble: shouldScanBle, usb: shouldScanUsb });

    try {
      // If discovery immediately refreshes a cached record, use it
      const refreshed = this.devices.get(deviceId);
      if (refreshed?.info && (!shouldScanBle || refreshed.descriptor)) {
        console.log('Ledger waitForDevice using refreshed record', {
          deviceId,
          fromCache: true,
          hasDescriptor: Boolean(refreshed.descriptor),
        });
        return refreshed.info;
      }

      console.log('Ledger waitForDevice start', {
        deviceId,
        timeoutMs,
        shouldScanBle,
        shouldScanUsb,
      });

      return await new Promise<LedgerDeviceInfo | null>((resolve) => {
        const cleanupCallbacks: Array<() => void> = [];
        const cleanup = () => {
          while (cleanupCallbacks.length) {
            const fn = cleanupCallbacks.pop();
            try {
              fn?.();
            } catch {}
          }
        };

        const onMatch = (info: LedgerDeviceInfo, source: 'discovered' | 'updated') => {
          if (info.id !== deviceId) {
            return;
          }
          console.log('Ledger waitForDevice matched device event', {
            deviceId,
            eventType: source,
          });
          cleanup();
          resolve(info);
        };

        cleanupCallbacks.push(
          this.on('deviceDiscovered', (info) => onMatch(info, 'discovered')),
          this.on('deviceUpdated', (info) => onMatch(info, 'updated'))
        );

        const timer = setTimeout(() => {
          console.log('Ledger waitForDevice timeout', { deviceId });
          cleanup();
          resolve(null);
        }, timeoutMs);

        cleanupCallbacks.push(() => clearTimeout(timer));
      });
    } finally {
      this.stopDiscovery({ ble: shouldScanBle, usb: shouldScanUsb });
    }
  }

  /**
   * Start periodic health checks to ensure the active transport remains responsive.
   */
  startConnectionHealthMonitoring(intervalMs: number = this.healthCheckIntervalMs): void {
    if (this.healthCheckTimer) {
      return;
    }
    this.healthCheckIntervalMs = intervalMs;
    this.healthCheckTimer = setInterval(() => {
      // Fire and forget; internal errors are emitted
      this.checkConnectionHealth().catch(() => {
        // Swallow; errors are emitted via this.emit('error', ...)
      });
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop periodic health checks.
   */
  stopConnectionHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Probes the active transport by requesting Ledger app/version info.
   * Marks the device disconnected on failure.
   */
  private async checkConnectionHealth(): Promise<void> {
    if (!this.currentTransport || !this.currentDeviceId) {
      return;
    }

    // Skip health check if signing is in progress to prevent race conditions
    if (isLedgerSigningInProgress()) {
      console.log('⏭️ SKIPPING health check - signing in progress');
      return;
    }

    try {
      // APDU: get app and version (same as used by Algorand app service)
      // Use shorter timeout for health checks to avoid blocking
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), 5000)
      );

      const healthCheck = this.currentTransport.send(0xb0, 0x01, 0x00, 0x00);

      await Promise.race([healthCheck, timeout]);
      // console.log('Ledger Health Check: OK'); // Only log failures to reduce noise
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log('Ledger Health Check Failed:', errorMsg);

      // Only disconnect on serious errors, not temporary communication issues
      if (
        errorMsg.includes('disconnected') ||
        errorMsg.includes('Device not found') ||
        errorMsg.includes('Connection lost') ||
        errorMsg.includes('Invalid channel')
      ) {
        console.log('Ledger Health Check: Disconnecting due to serious error');
        this.emit(
          'error',
          error instanceof Error ? error : new Error(String(error))
        );

        // Consider transport unhealthy; clear state and notify
        const deviceId = this.currentDeviceId;
        this.currentTransport = null;
        this.currentDeviceId = null;
        if (deviceId) {
          this.markDeviceDisconnected(deviceId);
        }
      } else {
        // Log but don't disconnect for temporary issues
        console.log('Ledger Health Check: Temporary communication issue, not disconnecting');
      }
    }
  }

  /**
   * Remove all listeners registered on this service.
   */
  removeAllListeners(): void {
    (Object.keys(this.listeners) as Array<keyof LedgerTransportEventMap>).forEach(
      (event) => {
        this.listeners[event].clear();
      }
    );
  }

  /**
   * Load previously discovered devices from storage
   */
  private async loadPersistedDevices(): Promise<void> {
    try {
      const persistedDevices = await ledgerDeviceStorage.loadDevices();
      console.log(`Loaded ${persistedDevices.length} persisted Ledger devices`);

      // Convert persisted devices to device records and add to memory
      for (const persisted of persistedDevices) {
        const deviceInfo = LedgerDeviceStorage.toDeviceInfo(persisted);
        this.devices.set(deviceInfo.id, {
          info: deviceInfo,
          // No descriptor since device is not currently discovered
        });

        // Emit as discovered so UI can show persisted devices
        this.emit('deviceDiscovered', deviceInfo);
      }
    } catch (error) {
      console.error('Failed to load persisted Ledger devices:', error);
      // Don't throw - app should continue even if persistence fails
    }
  }

  /**
   * Save device info to persistent storage with throttling to prevent spam
   */
  private async saveDeviceToStorage(deviceInfo: LedgerDeviceInfo): Promise<void> {
    const deviceId = deviceInfo.id;
    
    // Clear any existing timer for this device
    const existingTimer = this.saveThrottleTimers.get(deviceId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // Set a new timer to save after the throttle period
    const timer = setTimeout(async () => {
      try {
        await ledgerDeviceStorage.saveDevice(deviceInfo);
        this.saveThrottleTimers.delete(deviceId);
      } catch (error) {
        console.error('Failed to persist Ledger device:', error);
        this.saveThrottleTimers.delete(deviceId);
        // Don't throw - persistence failures shouldn't break functionality
      }
    }, this.SAVE_THROTTLE_MS);
    
    this.saveThrottleTimers.set(deviceId, timer);
  }

  /**
   * Update last connected timestamp in storage
   */
  private async updateDeviceLastConnected(deviceId: string): Promise<void> {
    try {
      await ledgerDeviceStorage.updateLastConnected(deviceId);
    } catch (error) {
      console.error('Failed to update last connected timestamp:', error);
      // Don't throw - persistence failures shouldn't break functionality
    }
  }

  /**
   * Create USB descriptor from persisted device info for connection
   */
  private createUsbDescriptorFromDeviceInfo(deviceInfo?: LedgerDeviceInfo): { vendorId: number; productId: number } | undefined {
    if (!deviceInfo || deviceInfo.type !== 'usb' || !deviceInfo.vendorId || !deviceInfo.productId) {
      return undefined;
    }
    return {
      vendorId: deviceInfo.vendorId,
      productId: deviceInfo.productId,
    };
  }

  /**
   * Dispose the transport service: stop discovery, disconnect, clear devices and listeners.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopConnectionHealthMonitoring();
    this.stopBleDiscovery();
    this.stopUsbDiscovery();
    await this.disconnect();
    this.devices.clear();
    this.removeAllListeners();
    this.connectingDeviceId = null;
    
    // Clear all pending save timers
    for (const timer of this.saveThrottleTimers.values()) {
      clearTimeout(timer);
    }
    this.saveThrottleTimers.clear();
  }
}

export const ledgerTransportService = LedgerTransportService.getInstance();
