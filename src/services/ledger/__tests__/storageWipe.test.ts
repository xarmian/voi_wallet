/**
 * TASK-492: a Ledger device save, removal or last-connected update that began
 * before or during a wipe does not write the previous wallet's device list
 * back; one that begins after the wipe ends persists.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';
import { ledgerDeviceStorage } from '../storage';
import type { LedgerDeviceInfo } from '../transport';

const KEY = 'voi_wallet_ledger_devices_v1';
const device: LedgerDeviceInfo = {
  id: 'dev-1',
  name: 'Nano X',
  type: 'ble',
  connected: false,
  lastSeen: '2026-11-27T00:00:00.000Z',
};
const stored = JSON.stringify([{ ...device, connected: undefined }]);

let setItem: jest.SpyInstance;
beforeEach(async () => {
  await AsyncStorage.clear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  setItem = jest.spyOn(AsyncStorage, 'setItem');
});
afterEach(() => {
  closeWipeWindow();
  jest.restoreAllMocks();
});

/** Hold the device-list read until released. */
function holdRead(): () => void {
  let release: () => void = () => {};
  const getItem = AsyncStorage.getItem;
  jest.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(
    (key: string) =>
      new Promise((resolve) => {
        release = () => resolve(getItem(key));
      }) as never
  );
  return () => release();
}

test.each([
  ['saveDevice', () => ledgerDeviceStorage.saveDevice(device)],
  ['removeDevice', () => ledgerDeviceStorage.removeDevice(device.id)],
  [
    'updateLastConnected',
    () => ledgerDeviceStorage.updateLastConnected(device.id),
  ],
])('%s begun before the wipe does not write after it', async (_, call) => {
  await AsyncStorage.setItem(KEY, stored);
  setItem.mockClear();
  const release = holdRead();
  const pending = call();
  runWipeResets();
  release();
  await pending;
  expect(setItem).not.toHaveBeenCalled();
});

test('a save that starts during the wipe writes nothing', async () => {
  openWipeWindow();
  runWipeResets();
  await ledgerDeviceStorage.saveDevice(device);
  expect(setItem).not.toHaveBeenCalled();
});

test('a save that starts after the wipe ends persists', async () => {
  openWipeWindow();
  runWipeResets();
  closeWipeWindow();
  await ledgerDeviceStorage.saveDevice(device);
  expect(JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]')).toEqual([
    expect.objectContaining({ id: 'dev-1' }),
  ]);
});
