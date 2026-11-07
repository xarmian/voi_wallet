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
const mockKeyBearing = jest.fn();
const mockHasPin = jest.fn();
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    hasKeyBearingAccountStrict: () => mockKeyBearing(),
  },
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: { hasPinStrict: () => mockHasPin() },
}));

const ref: RequestRef = { version: 2, kind: 'request', topic: 't', id: 1 };

beforeEach(async () => {
  await AsyncStorage.clear();
  mockKeyBearing.mockReset().mockResolvedValue(true);
  mockHasPin.mockReset().mockResolvedValue(false);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('DEFECT no breadcrumb admits', async () => {
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
});

it('DEFECT S2 (breadcrumb, a key-bearing account, no PIN) refuses as setup-incomplete, and clearing the breadcrumb admits again', async () => {
  await markPinSetupPending();
  await expect(setupIncompleteGuard(ref)).resolves.toBe('setup-incomplete');
  await clearPinSetupPending();
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
});

it('DEFECT a keyless wallet restored with no PIN (breadcrumb set, nothing key-bearing) is admitted', async () => {
  mockKeyBearing.mockResolvedValue(false);
  await markPinSetupPending();
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
});

it('DEFECT a PIN that exists admits even with a stale breadcrumb', async () => {
  mockHasPin.mockResolvedValue(true);
  await markPinSetupPending();
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
});

it('DEFECT no breadcrumb reads nothing else', async () => {
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
  expect(mockKeyBearing).not.toHaveBeenCalled();
  expect(mockHasPin).not.toHaveBeenCalled();
});

it.each(['keyBearing', 'pin'] as const)(
  'DEFECT an unreadable %s read admits (a wrong refusal is silent and durable)',
  async (which) => {
    await markPinSetupPending();
    (which === 'pin' ? mockHasPin : mockKeyBearing).mockRejectedValue(
      new Error('storage unreadable')
    );
    await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
  }
);

it('DEFECT any other stored value is not the breadcrumb', async () => {
  await AsyncStorage.setItem(PIN_SETUP_PENDING_KEY, 'false');
  await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
});

it('DEFECT a read that never settles admits at the 1.5 s bound, not before and not much after', async () => {
  jest.useFakeTimers();
  await markPinSetupPending();
  mockKeyBearing.mockReturnValue(new Promise(() => {}));
  let settled: string | null | undefined;
  void setupIncompleteGuard(ref).then((value) => {
    settled = value;
  });
  await jest.advanceTimersByTimeAsync(1_400);
  expect(settled).toBeUndefined();
  await jest.advanceTimersByTimeAsync(200);
  expect(settled).toBeNull();
});
