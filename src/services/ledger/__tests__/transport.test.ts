/**
 * TASK-180 (F-24) — Ledger transport lazy-init + connect-scoped health
 * monitoring.
 *
 * These tests pin the perf/lifecycle contract, NOT hardware behavior:
 *   (a) Boot: with NO persisted Ledger devices the transport does not initialize
 *       — no 15s health-check interval starts and the heavy BLE/HID transport
 *       modules are never eagerly evaluated. With persisted devices, boot init
 *       loads their metadata into getDevices() (for rekey/signing consumers)
 *       WITHOUT evaluating the transport modules or starting the interval.
 *   (b) Health monitoring starts only on a successful connect() and stops on
 *       BOTH the explicit disconnect() path and the transport 'disconnect' event
 *       — a CONNECTED transport is never left unmonitored, a disconnected one
 *       never keeps the interval alive.
 *   (c) The 5s APDU race timeout is cleared once the race settles (APDU win),
 *       so no stray self-expiring timer is leaked per check.
 *
 * CLAUDE.md (key/signing surface): no key material is involved here — the only
 * mocked surface is the two Ledger transport leaves (so their native ble-plx /
 * HID deps never enter the jest graph) and AsyncStorage. Real hardware BLE/USB
 * paths are out of scope (verified on-device — HT).
 */

import { Buffer } from 'buffer';

// --- The two Ledger transport leaves. Mocking them keeps react-native-ble-plx
// + rxjs and the HID native module out of the jest module graph AND lets us
// count how many times each is evaluated (the factory runs on first require,
// i.e. the first dynamic import() the code under test performs). ----------------
const mockBleTransport = {
  isSupported: jest.fn().mockResolvedValue(true),
  listen: jest.fn(),
  open: jest.fn(),
};
const mockHidTransport = {
  isSupported: jest.fn().mockResolvedValue(true),
  listen: jest.fn(),
  open: jest.fn(),
};
const mockBleEval = { count: 0 };
const mockHidEval = { count: 0 };

jest.mock('@ledgerhq/react-native-hw-transport-ble', () => {
  mockBleEval.count += 1;
  return { __esModule: true, default: mockBleTransport };
});
jest.mock('@ledgerhq/react-native-hid', () => {
  mockHidEval.count += 1;
  return { __esModule: true, default: mockHidTransport };
});

// AsyncStorage — force the community jest mock so the storage layer resolves.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { LedgerTransportService } from '../transport';
import { ledgerDeviceStorage } from '../storage';
import type { PersistedLedgerDevice } from '../storage';

// A single persisted USB device. USB is used for the connect() tests because it
// takes the direct openUsbTransport path (no BLE discovery / waitForDevice), so
// connect() resolves deterministically from an in-memory record.
const USB_DEVICE_ID = '1:2';
const persistedUsbDevice: PersistedLedgerDevice = {
  id: USB_DEVICE_ID,
  name: 'Ledger USB',
  type: 'usb',
  vendorId: 1,
  productId: 2,
  lastSeen: new Date('2026-07-20T00:00:00.000Z').toISOString(),
};

/** A fake opened transport with the event/close/send surface the service uses. */
function makeFakeTransport() {
  return {
    on: jest.fn(),
    off: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(Buffer.from([0x90, 0x00])),
  };
}

/** Pull the 'disconnect' handler the service registered via transport.on(). */
function getDisconnectHandler(
  fakeTransport: ReturnType<typeof makeFakeTransport>
): () => void {
  const call = fakeTransport.on.mock.calls.find((c) => c[0] === 'disconnect');
  if (!call) {
    throw new Error('service did not register a disconnect handler');
  }
  return call[1] as () => void;
}

let service: LedgerTransportService;

beforeEach(() => {
  jest.useFakeTimers();
  // Fresh singleton per test so private lifecycle state never leaks across.
  (LedgerTransportService as unknown as { instance?: unknown }).instance =
    undefined;
  service = LedgerTransportService.getInstance();

  mockBleEval.count = 0;
  mockHidEval.count = 0;
  mockBleTransport.open.mockReset();
  mockHidTransport.open.mockReset();

  // Storage is stubbed at the instance level so no test touches AsyncStorage
  // directly; each test sets loadDevices/hasPersistedDevices as needed.
  jest.spyOn(ledgerDeviceStorage, 'saveDevice').mockResolvedValue(undefined);
  jest
    .spyOn(ledgerDeviceStorage, 'updateLastConnected')
    .mockResolvedValue(undefined);

  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  service.stopConnectionHealthMonitoring();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ===========================================================================
// (a) Boot-time gate: no interval, no eager transport-module evaluation
// ===========================================================================

describe('boot-time initialization gate (F-24)', () => {
  it('does NOT init, start the interval, or evaluate transport modules when no device is persisted', async () => {
    jest
      .spyOn(ledgerDeviceStorage, 'hasPersistedDevices')
      .mockResolvedValue(false);
    const loadSpy = jest.spyOn(ledgerDeviceStorage, 'loadDevices');
    const bleBefore = mockBleEval.count;
    const hidBefore = mockHidEval.count;

    const didInit = await service.initializeIfPersistedDevices({
      enableBle: true,
      enableUsb: true,
    });

    expect(didInit).toBe(false);
    // No populate read ran and the map stayed empty (nothing to load).
    expect(loadSpy).not.toHaveBeenCalled();
    expect(service.getDevices()).toEqual([]);
    // The permanent 15s health-check interval is NOT started at boot.
    expect(service.isHealthMonitoringActive()).toBe(false);
    // The heavy BLE/HID modules were never dynamically imported.
    expect(mockBleEval.count).toBe(bleBefore);
    expect(mockHidEval.count).toBe(hidBefore);
  });

  it('with a persisted device, boot init loads metadata for getDevices() WITHOUT evaluating transport modules or starting the interval', async () => {
    jest
      .spyOn(ledgerDeviceStorage, 'hasPersistedDevices')
      .mockResolvedValue(true);
    jest
      .spyOn(ledgerDeviceStorage, 'loadDevices')
      .mockResolvedValue([persistedUsbDevice]);
    const bleBefore = mockBleEval.count;
    const hidBefore = mockHidEval.count;

    const didInit = await service.initializeIfPersistedDevices({
      enableBle: true,
      enableUsb: true,
    });

    expect(didInit).toBe(true);
    // Persisted-device metadata is available to getDevices() consumers
    // (rekey/signing via keyManager) BEFORE any discovery/connect happens.
    const devices = service.getDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: USB_DEVICE_ID,
      type: 'usb',
      connected: false,
    });
    // Loading metadata must NOT pull in ble-plx/rxjs or the HID native module.
    expect(mockBleEval.count).toBe(bleBefore);
    expect(mockHidEval.count).toBe(hidBefore);
    // Still no interval — monitoring is scoped to a live connection, not boot.
    expect(service.isHealthMonitoringActive()).toBe(false);
  });

  it('initialize() itself never starts the health-check interval', async () => {
    jest
      .spyOn(ledgerDeviceStorage, 'loadDevices')
      .mockResolvedValue([persistedUsbDevice]);

    await service.initialize({ enableBle: true, enableUsb: true });

    expect(service.isHealthMonitoringActive()).toBe(false);
  });
});

// ===========================================================================
// (b) Health monitoring: starts on connect, stops on BOTH disconnect paths
// ===========================================================================

describe('connect-scoped health monitoring (F-24)', () => {
  async function connectUsb() {
    jest
      .spyOn(ledgerDeviceStorage, 'loadDevices')
      .mockResolvedValue([persistedUsbDevice]);
    await service.initialize({ enableBle: true, enableUsb: true });

    const fakeTransport = makeFakeTransport();
    mockHidTransport.open.mockResolvedValue(fakeTransport);

    const transport = await service.connect(USB_DEVICE_ID, {
      transportType: 'usb',
    });
    expect(transport).toBe(fakeTransport);
    return fakeTransport;
  }

  it('starts monitoring only after a successful connect() (and evaluates only the HID module)', async () => {
    expect(service.isHealthMonitoringActive()).toBe(false);

    await connectUsb();

    // A CONNECTED transport is monitored.
    expect(service.isHealthMonitoringActive()).toBe(true);
    // USB connect must not drag in the BLE module.
    expect(mockBleEval.count).toBe(0);
    expect(mockHidEval.count).toBe(1);
  });

  it('stops monitoring on the explicit disconnect() path', async () => {
    const fakeTransport = await connectUsb();
    expect(service.isHealthMonitoringActive()).toBe(true);

    await service.disconnect();

    expect(fakeTransport.close).toHaveBeenCalled();
    expect(service.isHealthMonitoringActive()).toBe(false);
  });

  it('stops monitoring on the transport-initiated disconnect event', async () => {
    const fakeTransport = await connectUsb();
    expect(service.isHealthMonitoringActive()).toBe(true);

    // Simulate the transport firing its own 'disconnect' (cable pulled / BLE drop).
    const handler = getDisconnectHandler(fakeTransport);
    handler();

    expect(service.isHealthMonitoringActive()).toBe(false);
  });
});

// ===========================================================================
// (c) The 5s APDU race timeout is cleared when the APDU wins
// ===========================================================================

describe('checkConnectionHealth race-timer cleanup (F-24)', () => {
  it('clears the 5s timeout once the APDU wins the race (no leaked timer)', async () => {
    const send = jest.fn().mockResolvedValue(Buffer.from([0x90, 0x00]));
    // Drive checkConnectionHealth directly with a connected transport.
    (
      service as unknown as {
        currentTransport: unknown;
        currentDeviceId: string;
      }
    ).currentTransport = { send };
    (service as unknown as { currentDeviceId: string }).currentDeviceId = 'dev';

    // No timers pending before the check.
    expect(jest.getTimerCount()).toBe(0);

    await (
      service as unknown as { checkConnectionHealth: () => Promise<void> }
    ).checkConnectionHealth();

    // The APDU resolved and won the race; the 5s timeout must be cleared, so no
    // self-expiring timer is left behind. (Before the fix this would be 1.)
    expect(send).toHaveBeenCalledWith(0xb0, 0x01, 0x00, 0x00);
    expect(jest.getTimerCount()).toBe(0);
  });
});

// ===========================================================================
// (d) Involuntary teardown: detach the disconnect listener AND close the
//     orphaned transport (TASK-216 — follow-up to F-24).
//
// The three INVOLUNTARY null-out paths (BLE 'remove', USB 'remove', health-
// check auto-disconnect) used to clear currentTransport + stop monitoring but
// left currentDisconnectHandler attached to, and never close()d, the now-dead
// transport — a dangling-listener + unclosed-transport leak. All three now
// route through releaseTransport(), mirroring the explicit disconnect() path.
// ===========================================================================

describe('involuntary transport teardown (TASK-216)', () => {
  /**
   * Put the service into a "connected" state around `fakeTransport` without
   * driving a full connect(): set the private current* fields + a disconnect
   * handler and start monitoring, exactly as a live connection would. Returns
   * the handler so a test can assert it gets detached.
   */
  function primeConnected(
    fakeTransport: ReturnType<typeof makeFakeTransport>,
    deviceId: string
  ): () => void {
    const handler = jest.fn();
    const s = service as unknown as {
      currentTransport: unknown;
      currentDeviceId: string;
      currentDisconnectHandler: (() => void) | null;
    };
    s.currentTransport = fakeTransport;
    s.currentDeviceId = deviceId;
    s.currentDisconnectHandler = handler;
    // Emitted teardown errors would otherwise go unobserved.
    service.on('error', () => {});
    service.startConnectionHealthMonitoring();
    expect(service.isHealthMonitoringActive()).toBe(true);
    return handler;
  }

  function assertTornDown(
    fakeTransport: ReturnType<typeof makeFakeTransport>,
    handler: () => void
  ) {
    // Listener detached from the dead transport…
    expect(fakeTransport.off).toHaveBeenCalledWith('disconnect', handler);
    // …transport closed…
    expect(fakeTransport.close).toHaveBeenCalledTimes(1);
    // …monitoring stopped and references dropped.
    expect(service.isHealthMonitoringActive()).toBe(false);
    const s = service as unknown as {
      currentTransport: unknown;
      currentDisconnectHandler: unknown;
    };
    expect(s.currentTransport).toBeNull();
    expect(s.currentDisconnectHandler).toBeNull();
  }

  it('health-check auto-disconnect detaches the listener AND closes the transport', async () => {
    const fakeTransport = makeFakeTransport();
    // A "serious" error string routes checkConnectionHealth into the
    // auto-disconnect branch (matched on 'disconnected').
    fakeTransport.send = jest
      .fn()
      .mockRejectedValue(new Error('device disconnected'));
    const handler = primeConnected(fakeTransport, 'dev');

    await (
      service as unknown as { checkConnectionHealth: () => Promise<void> }
    ).checkConnectionHealth();
    // close() is dispatched on a microtask (fire-and-forget); flush it.
    await Promise.resolve();

    assertTornDown(fakeTransport, handler);
  });

  it('USB discovery "remove" of the connected device detaches the listener AND closes the transport', async () => {
    let usbObserver: { next: (e: unknown) => void } | undefined;
    mockHidTransport.listen.mockImplementation((obs: any) => {
      usbObserver = obs;
      return { unsubscribe: jest.fn() };
    });

    await service.startDiscovery({ ble: false, usb: true });
    expect(usbObserver).toBeDefined();

    const fakeTransport = makeFakeTransport();
    const handler = primeConnected(fakeTransport, USB_DEVICE_ID);
    const disconnected: (string | undefined)[] = [];
    service.on('disconnected', (info) =>
      disconnected.push('id' in info ? info.id : undefined)
    );

    // The connected USB device is unplugged mid-discovery.
    usbObserver!.next({
      type: 'remove',
      descriptor: { vendorId: 1, productId: 2 },
    });
    // close() is invoked synchronously; flush the fire-and-forget promise.
    await Promise.resolve();

    assertTornDown(fakeTransport, handler);
    // Removing the connected device signals a disconnect, not just removal.
    expect(disconnected).toContain(USB_DEVICE_ID);
  });

  it('BLE discovery "remove" of the connected device detaches the listener AND closes the transport', async () => {
    // BLE discovery gates on runtime permissions; grant them for the test.
    jest
      .spyOn(
        service as unknown as {
          ensureBlePermissions: () => Promise<boolean>;
        },
        'ensureBlePermissions'
      )
      .mockResolvedValue(true);
    let bleObserver: { next: (e: unknown) => void } | undefined;
    mockBleTransport.listen.mockImplementation((obs: any) => {
      bleObserver = obs;
      return { unsubscribe: jest.fn() };
    });

    await service.startDiscovery({ ble: true, usb: false });
    expect(bleObserver).toBeDefined();

    const BLE_ID = 'ble-device-1';
    const fakeTransport = makeFakeTransport();
    const handler = primeConnected(fakeTransport, BLE_ID);
    const disconnected: (string | undefined)[] = [];
    service.on('disconnected', (info) =>
      disconnected.push('id' in info ? info.id : undefined)
    );

    // The connected BLE device drops out of range mid-discovery.
    bleObserver!.next({ type: 'remove', descriptor: { id: BLE_ID } });
    await Promise.resolve();

    assertTornDown(fakeTransport, handler);
    // Removing the connected device signals a disconnect, not just removal.
    expect(disconnected).toContain(BLE_ID);
  });

  it('teardown is idempotent — a second involuntary path racing the same transport does not double-close', async () => {
    const fakeTransport = makeFakeTransport();
    const handler = primeConnected(fakeTransport, USB_DEVICE_ID);

    // Two teardown paths land on the SAME transport before the first close()
    // settles (e.g. a health-check auto-disconnect while a USB 'remove' fires).
    // The first claims it; the second must see it already claimed and no-op.
    const releaseTransport = (t: unknown) =>
      (
        service as unknown as {
          releaseTransport: (t: unknown) => Promise<void>;
        }
      ).releaseTransport(t);
    await Promise.all([
      releaseTransport(fakeTransport),
      releaseTransport(fakeTransport),
    ]);

    // Exactly one close() + one detach despite two teardown calls.
    expect(fakeTransport.close).toHaveBeenCalledTimes(1);
    expect(fakeTransport.off).toHaveBeenCalledTimes(1);
    expect(fakeTransport.off).toHaveBeenCalledWith('disconnect', handler);
  });

  it('a stale health-check failure does not tear down a successor transport', async () => {
    const oldTransport = makeFakeTransport();
    oldTransport.send = jest
      .fn()
      .mockRejectedValue(new Error('device disconnected'));
    primeConnected(oldTransport, 'old-dev');
    const disconnected: (string | undefined)[] = [];
    service.on('disconnected', (info) =>
      disconnected.push('id' in info ? info.id : undefined)
    );

    // Probe starts against oldTransport, then suspends at the APDU await.
    const check = (
      service as unknown as { checkConnectionHealth: () => Promise<void> }
    ).checkConnectionHealth();

    // A successor connects and takes over currentTransport while the (already
    // doomed) probe of oldTransport is still in flight.
    const newTransport = makeFakeTransport();
    const s = service as unknown as {
      currentTransport: unknown;
      currentDeviceId: string;
      currentDisconnectHandler: (() => void) | null;
    };
    s.currentTransport = newTransport;
    s.currentDeviceId = 'new-dev';
    s.currentDisconnectHandler = jest.fn();

    await check;
    await Promise.resolve();

    // The stale failure tears down oldTransport (it's no longer current, so
    // releaseTransport no-ops) — the successor must be left fully intact.
    expect(newTransport.close).not.toHaveBeenCalled();
    expect(newTransport.off).not.toHaveBeenCalled();
    expect(s.currentTransport).toBe(newTransport);
    expect(s.currentDeviceId).toBe('new-dev');
    // The stale health-check loser stays silent — it did not claim the
    // transport, so it re-marks nothing (in real code the successor takeover
    // via connect()->disconnect() is what marks the old device). The live
    // successor is never marked.
    expect(disconnected).not.toContain('new-dev');
  });

  it('a discovery remove during an in-flight health check emits disconnected exactly once', async () => {
    let usbObserver: { next: (e: unknown) => void } | undefined;
    mockHidTransport.listen.mockImplementation((obs: any) => {
      usbObserver = obs;
      return { unsubscribe: jest.fn() };
    });
    await service.startDiscovery({ ble: false, usb: true });

    const fakeTransport = makeFakeTransport();
    fakeTransport.send = jest
      .fn()
      .mockRejectedValue(new Error('device disconnected'));
    primeConnected(fakeTransport, USB_DEVICE_ID);
    const disconnected: (string | undefined)[] = [];
    service.on('disconnected', (info) =>
      disconnected.push('id' in info ? info.id : undefined)
    );

    // Health check starts probing the device, then suspends at the APDU await.
    const check = (
      service as unknown as { checkConnectionHealth: () => Promise<void> }
    ).checkConnectionHealth();

    // The device is unplugged mid-probe: the discovery 'remove' claims + marks
    // it. The subsequent stale health-check failure must NOT re-mark it.
    usbObserver!.next({
      type: 'remove',
      descriptor: { vendorId: 1, productId: 2 },
    });
    await check;
    await Promise.resolve();

    expect(disconnected.filter((id) => id === USB_DEVICE_ID)).toHaveLength(1);
  });

  it('disconnect() does not mark a device disconnected if a successor reconnects it during close()', async () => {
    const oldTransport = makeFakeTransport();
    let resolveClose: (() => void) | undefined;
    oldTransport.close = jest.fn(
      () => new Promise<void>((r) => (resolveClose = r))
    );
    primeConnected(oldTransport, USB_DEVICE_ID);
    const markSpy = jest.spyOn(
      service as unknown as {
        markDeviceDisconnected: (id: string) => void;
      },
      'markDeviceDisconnected'
    );

    // releaseTransport clears state synchronously, then disconnect() awaits the
    // (hanging) close(). Flush the microtask that actually invokes close().
    const disconnecting = service.disconnect();
    await Promise.resolve();
    expect(resolveClose).toBeDefined();

    // A successor reconnects the SAME device while close() is still pending.
    const s = service as unknown as {
      currentTransport: unknown;
      currentDeviceId: string;
    };
    s.currentTransport = makeFakeTransport();
    s.currentDeviceId = USB_DEVICE_ID;

    resolveClose!();
    await disconnecting;

    // The stale teardown must NOT flag the reconnected device disconnected.
    expect(markSpy).not.toHaveBeenCalled();
    expect(s.currentDeviceId).toBe(USB_DEVICE_ID);
  });

  it('a stale transport-initiated disconnect does not clobber a same-device successor', async () => {
    const svc = service as unknown as {
      attachDisconnectListener: (t: unknown, id: string) => void;
      currentTransport: unknown;
      currentDeviceId: string;
      currentDisconnectHandler: (() => void) | null;
      markDeviceDisconnected: (id: string) => void;
    };

    // Live connection on USB_DEVICE_ID with its disconnect handler registered.
    const oldTransport = makeFakeTransport();
    svc.attachDisconnectListener(oldTransport, USB_DEVICE_ID);
    const oldHandler = getDisconnectHandler(oldTransport);
    svc.currentTransport = oldTransport;
    svc.currentDeviceId = USB_DEVICE_ID;
    service.startConnectionHealthMonitoring();

    // The SAME device reconnects: a successor takes over + registers its own
    // disconnect handler (attachDisconnectListener updates currentDisconnectHandler).
    const newTransport = makeFakeTransport();
    svc.attachDisconnectListener(newTransport, USB_DEVICE_ID);
    const newHandler = getDisconnectHandler(newTransport);
    svc.currentTransport = newTransport;
    svc.currentDeviceId = USB_DEVICE_ID;

    const markSpy = jest.spyOn(svc, 'markDeviceDisconnected');

    // The OLD transport now fires its (stale) disconnect event.
    oldHandler();

    // Successor untouched: still current, its handler intact, still monitored,
    // and no spurious 'disconnected' emitted for the live device.
    expect(svc.currentTransport).toBe(newTransport);
    expect(svc.currentDeviceId).toBe(USB_DEVICE_ID);
    expect(svc.currentDisconnectHandler).toBe(newHandler);
    expect(service.isHealthMonitoringActive()).toBe(true);
    expect(markSpy).not.toHaveBeenCalled();
  });

  it('a transport-initiated disconnect on the live transport detaches the listener AND closes it', async () => {
    const svc = service as unknown as {
      attachDisconnectListener: (t: unknown, id: string) => void;
      currentTransport: unknown;
      currentDeviceId: string;
      currentDisconnectHandler: (() => void) | null;
    };
    const fakeTransport = makeFakeTransport();
    svc.attachDisconnectListener(fakeTransport, USB_DEVICE_ID);
    const handler = getDisconnectHandler(fakeTransport);
    svc.currentTransport = fakeTransport;
    svc.currentDeviceId = USB_DEVICE_ID;
    service.on('error', () => {});
    service.startConnectionHealthMonitoring();

    // The connected transport fires its own 'disconnect' (device dropped).
    handler();
    // close() is dispatched on a microtask (fire-and-forget); flush it.
    await Promise.resolve();

    // Now routed through releaseTransport: listener detached + transport closed,
    // not just state cleared.
    expect(fakeTransport.off).toHaveBeenCalledWith('disconnect', handler);
    expect(fakeTransport.close).toHaveBeenCalledTimes(1);
    expect(service.isHealthMonitoringActive()).toBe(false);
    expect(svc.currentTransport).toBeNull();
    expect(svc.currentDisconnectHandler).toBeNull();
  });
});
