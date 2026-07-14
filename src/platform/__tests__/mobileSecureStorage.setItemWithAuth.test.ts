// Unit test for the write-time auth gate (DOC-137 §2.5, PR6). Proves
// MobileSecureStorageAdapter.setItemWithAuth provisions `requireAuthentication`
// AT WRITE (the fix for the write-time-ACL bug where auth was requested only on
// read), and that plain setItem does NOT — so the auth gate stays scoped to the
// single biometric-convenience item.
//
// SECURITY NOTE: throwaway test strings stand in for any secret; no real key.

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when_unlocked_this_device_only',
  setItemAsync: jest.fn(async () => {}),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => {}),
}));

import * as SecureStore from 'expo-secure-store';
import { MobileSecureStorageAdapter } from '../mobile/secureStorage';

const setItemAsyncMock = SecureStore.setItemAsync as jest.Mock;

describe('MobileSecureStorageAdapter.setItemWithAuth (DOC-137 §2.5)', () => {
  const adapter = new MobileSecureStorageAdapter();

  it('provisions requireAuthentication:true AT WRITE with the prompt', async () => {
    await adapter.setItemWithAuth('voi_biometric_secret', 'convenience-value', {
      prompt: 'Enable biometric unlock',
    });

    expect(setItemAsyncMock).toHaveBeenCalledTimes(1);
    const [key, value, options] = setItemAsyncMock.mock.calls[0];
    expect(key).toBe('voi_biometric_secret');
    expect(value).toBe('convenience-value');
    expect(options).toMatchObject({
      requireAuthentication: true,
      authenticationPrompt: 'Enable biometric unlock',
    });
  });

  it('plain setItem does NOT set requireAuthentication (scope stays one item)', async () => {
    await adapter.setItem('voi_wallet_pin', 'pin-hash');

    expect(setItemAsyncMock).toHaveBeenCalledTimes(1);
    const [key, , options] = setItemAsyncMock.mock.calls[0];
    expect(key).toBe('voi_wallet_pin');
    expect(options).not.toHaveProperty('requireAuthentication');
    expect(options).not.toHaveProperty('authenticationPrompt');
  });
});
