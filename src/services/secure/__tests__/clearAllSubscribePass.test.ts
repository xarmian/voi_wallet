// TASK-192 — round 2 of the full-diff Codex pass over PLAN-275.
//
// The clearAllWallets() guard was still too late. EVERY reset path awaits
// AccountSecureStorage.clearAll() FIRST and reaches clearAllWallets second:
// LockScreen.performReset (:284), SecureStorageUnavailableScreen (:165),
// backup restorers.clearAllData (:92), and keyManager (:667). That left the
// deferred notification subscribe pass a window the length of a full
// secure-storage wipe in which to complete and batch-write subscriptions for
// accounts the user was erasing.
//
// Guarding at this chokepoint closes it for all four callers at once, and a
// fifth reset path added later inherits it rather than reintroducing the bug.
//
// SECURITY NOTE: no static or committed secret material in this file.

jest.mock('@/platform', () => ({
  storage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
    multiRemove: jest.fn(async () => {}),
  },
  secureStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    deleteItem: jest.fn(async () => {}),
  },
}));

import { AccountSecureStorage } from '../AccountSecureStorage';
import {
  isAccountSubscribeTokenCurrent,
  takeAccountSubscribeToken,
} from '@/services/notifications/subscribePass';

describe('AccountSecureStorage.clearAll — cancels the deferred subscribe pass (TASK-192)', () => {
  it('invalidates synchronously at entry, before the wipe is awaited', async () => {
    const inFlightToken = takeAccountSubscribeToken();
    expect(isAccountSubscribeTokenCurrent(inFlightToken)).toBe(true);

    // Deliberately not awaited. The point is that the token dies on the
    // synchronous prefix — asserting after the wipe resolves would also pass
    // for the too-late implementation this replaces.
    const pending = AccountSecureStorage.clearAll();
    expect(isAccountSubscribeTokenCurrent(inFlightToken)).toBe(false);

    await pending.catch(() => {});
  });

  it('leaves a token taken after the wipe current', async () => {
    await AccountSecureStorage.clearAll().catch(() => {});
    const freshToken = takeAccountSubscribeToken();
    expect(isAccountSubscribeTokenCurrent(freshToken)).toBe(true);
  });
});
