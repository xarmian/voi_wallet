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
