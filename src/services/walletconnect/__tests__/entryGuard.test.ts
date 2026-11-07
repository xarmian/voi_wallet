import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearPinSetupPending,
  markPinSetupPending,
  PIN_SETUP_PENDING_KEY,
} from '@/services/secure/pinSetupPending';
import type { RequestRef } from '../requestCoordinator';
import { setupIncompleteGuard } from '../entryGuard';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const ref: RequestRef = { version: 2, kind: 'request', topic: 't', id: 1 };

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('DEFECT no breadcrumb admits', async () => {
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
});

it('DEFECT the restore-before-PIN breadcrumb refuses as setup-incomplete, and clearing it admits again', async () => {
  await markPinSetupPending();
  await expect(setupIncompleteGuard(ref)).resolves.toBe('setup-incomplete');
  await clearPinSetupPending();
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
});

it('DEFECT any other stored value is not the breadcrumb', async () => {
  await AsyncStorage.setItem(PIN_SETUP_PENDING_KEY, 'false');
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
});

it('DEFECT a read that never settles admits after the bound instead of stalling the arrival', async () => {
  jest.useFakeTimers();
  jest.spyOn(AsyncStorage, 'getItem').mockReturnValue(new Promise(() => {}));
  const pending = setupIncompleteGuard(ref);
  await jest.advanceTimersByTimeAsync(5_000);
  await expect(pending).resolves.toBeNull();
});
