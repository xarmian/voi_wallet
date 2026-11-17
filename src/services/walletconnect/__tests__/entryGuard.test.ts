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

describe('the guard admits on an unreadable state, and says so once', () => {
  const warned = () => JSON.stringify((console.warn as jest.Mock).mock.calls);

  it.each(['keyBearing', 'pin'] as const)(
    'DEFECT a rejected %s read warns once with fixed text and no error detail',
    async (which) => {
      await markPinSetupPending();
      (which === 'pin' ? mockHasPin : mockKeyBearing).mockRejectedValue(
        new Error('storage unreadable topic-secret')
      );
      await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
      const warnCalls = (console.warn as jest.Mock).mock.calls.filter((call) =>
        JSON.stringify(call).includes('Entry guard')
      );
      expect(warnCalls).toHaveLength(1);
      expect(warned()).not.toContain('topic-secret');
      expect(warned()).not.toContain('storage unreadable');
    }
  );

  it.each(['breadcrumb', 'keyBearing', 'pin'] as const)(
    'DEFECT a hung %s read admits at the bound and warns once',
    async (which) => {
      jest.useFakeTimers();
      await markPinSetupPending();
      if (which === 'breadcrumb') {
        jest
          .spyOn(AsyncStorage, 'getItem')
          .mockReturnValueOnce(new Promise(() => {}));
      } else {
        (which === 'pin' ? mockHasPin : mockKeyBearing).mockReturnValue(
          new Promise(() => {})
        );
      }
      let settled: string | null | undefined;
      void setupIncompleteGuard(ref).then((value) => {
        settled = value;
      });
      await jest.advanceTimersByTimeAsync(1_400);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(200);
      expect(settled).toBeNull();
      const warnCalls = (console.warn as jest.Mock).mock.calls.filter((call) =>
        JSON.stringify(call).includes('Entry guard')
      );
      expect(warnCalls).toHaveLength(1);
    }
  );

  it('DEFECT a normal admit and a normal refusal say nothing', async () => {
    await expect(setupIncompleteGuard(ref)).resolves.toBeNull();
    await markPinSetupPending();
    await expect(setupIncompleteGuard(ref)).resolves.toBe('setup-incomplete');
    const warnCalls = (console.warn as jest.Mock).mock.calls.filter((call) =>
      JSON.stringify(call).includes('Entry guard')
    );
    expect(warnCalls).toHaveLength(0);
  });
});
