// Unit test for clearSessionSecurity (DOC-137 §6.3 / Codex P1-D + P1-E, PR3).
//
// This is the SINGLE teardown that AuthContext.lock() invokes on every lock path
// (explicit / inactivity-timeout / background-grace). The test proves it fans
// out to all THREE clears: the session vault, the legacy 60 s plaintext-key
// cache, and the ~30 min messaging key cache — with each clear mocked/spied.

// Minimal platform mock so importing AccountSecureStorage resolves under jest
// (clearPrivateKeyCache itself touches none of these).
jest.mock('@/platform', () => ({
  crypto: {},
  secureStorage: {},
  storage: {},
  biometrics: {},
  deviceId: {},
}));

// Mock the messaging key cache clear so we assert the call without loading the
// messaging module graph.
jest.mock('../../messaging/keyDerivation', () => ({
  clearMessagingKeyCache: jest.fn(),
}));

import { clearSessionSecurity, enterLockedState } from '../sessionTeardown';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';
import { AppLockSignal } from '../appLockState';
import { clearMessagingKeyCache } from '../../messaging/keyDerivation';

describe('clearSessionSecurity', () => {
  it('clears the vault, the 60s key cache, and the messaging key cache', () => {
    const vaultSpy = jest.spyOn(SessionKeyVault, 'clear');
    const cacheSpy = jest
      .spyOn(AccountSecureStorage, 'clearPrivateKeyCache')
      .mockImplementation(() => {});

    clearSessionSecurity();

    expect(vaultSpy).toHaveBeenCalledTimes(1);
    expect(cacheSpy).toHaveBeenCalledTimes(1);
    expect(clearMessagingKeyCache).toHaveBeenCalledTimes(1);

    vaultSpy.mockRestore();
    cacheSpy.mockRestore();
  });
});

describe('enterLockedState (Codex P1-E: sync lock signal BEFORE teardown)', () => {
  it('flips AppLockSignal to locked synchronously and BEFORE the cache teardown', () => {
    AppLockSignal.setUnlocked(true);
    const signalSpy = jest.spyOn(AppLockSignal, 'setUnlocked');
    const vaultSpy = jest.spyOn(SessionKeyVault, 'clear');
    const cacheSpy = jest
      .spyOn(AccountSecureStorage, 'clearPrivateKeyCache')
      .mockImplementation(() => {});

    enterLockedState();

    // The signal is now locked (set synchronously, not via a later effect)...
    expect(AppLockSignal.isUnlocked()).toBe(false);
    expect(signalSpy).toHaveBeenCalledWith(false);
    // ...and it was flipped BEFORE the teardown ran (invocation order), so a
    // racing derive that resolves during teardown already sees "locked".
    expect(signalSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vaultSpy.mock.invocationCallOrder[0]
    );
    expect(signalSpy.mock.invocationCallOrder[0]).toBeLessThan(
      (clearMessagingKeyCache as jest.Mock).mock.invocationCallOrder[0]
    );

    signalSpy.mockRestore();
    vaultSpy.mockRestore();
    cacheSpy.mockRestore();
  });
});
