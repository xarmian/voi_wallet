/**
 * TASK-469: MainTabNavigator waits on the remote-signer store before it draws
 * the tabs. A wipe resets that store to uninitialized while the navigator stays
 * mounted under the lock overlay, so the navigator must initialize it again;
 * a one-shot latch from the first mount left a blank screen.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/platform', () => ({
  getCrypto: () => ({ randomUUID: () => 'uuid' }),
}));
jest.mock('@/store/walletStore', () => ({
  useWalletStore: { getState: () => ({ wallet: null }) },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';
import { useRemoteSignerStore } from '@/store/remoteSignerStore';
import { useRemoteSignerReady } from '../useRemoteSignerReady';

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
};

/** Run a wipe's resets the way the wipe does: inside the wipe window. */
const wipe = async () => {
  await act(async () => {
    openWipeWindow();
    runWipeResets();
  });
};
const settleWipe = async () => {
  await act(async () => closeWipeWindow());
};

/** Count initialize() calls without replacing what it does. */
const countInitialize = () => {
  const original = useRemoteSignerStore.getState().initialize;
  const initialize = jest.fn(() => original());
  useRemoteSignerStore.setState({ initialize });
  restore = () => useRemoteSignerStore.setState({ initialize: original });
  return initialize;
};
let restore: () => void = () => {};

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  await AsyncStorage.clear();
  closeWipeWindow();
  runWipeResets();
});
afterEach(() => {
  restore();
  restore = () => {};
  closeWipeWindow();
  jest.restoreAllMocks();
});

test('initializes the store on mount', async () => {
  const { result } = await renderHook(() => useRemoteSignerReady());
  await flush();
  expect(result.current).toBe(true);
  expect(useRemoteSignerStore.getState().isInitialized).toBe(true);
});

test('after a wipe resets the store, it initializes it again once the wipe settles', async () => {
  const initialize = countInitialize();
  const { result } = await renderHook(() => useRemoteSignerReady());
  await flush();
  expect(result.current).toBe(true);
  expect(initialize).toHaveBeenCalledTimes(1);

  await wipe();
  await flush();
  expect(result.current).toBe(false);
  // Nothing starts while the wipe runs: a read then would see what is being deleted.
  expect(initialize).toHaveBeenCalledTimes(1);

  await settleWipe();
  await flush();
  expect(initialize).toHaveBeenCalledTimes(2);
  expect(result.current).toBe(true);
});

test('an initialize a wipe dropped is started again after the wipe', async () => {
  let release: () => void = () => {};
  const getItem = jest.spyOn(AsyncStorage, 'getItem');
  getItem.mockImplementationOnce(
    () =>
      new Promise<string | null>((resolve) => {
        release = () => resolve(null);
      })
  );
  const { result } = await renderHook(() => useRemoteSignerReady());
  await flush();
  expect(result.current).toBe(false);

  // The wipe starts and settles while the first pass is still reading.
  await wipe();
  await settleWipe();
  await act(async () => release());
  await flush();
  expect(useRemoteSignerStore.getState().isInitialized).toBe(true);
  expect(result.current).toBe(true);
});
