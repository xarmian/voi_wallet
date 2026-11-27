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

// A failing assertion skips a test's own mockRestore; restore here so a spy
// (e.g. a throwing vault clear) never leaks into the next test.
afterEach(() => {
  jest.restoreAllMocks();
});

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

  it('still clears both caches when the vault clear throws, then rethrows', () => {
    (clearMessagingKeyCache as jest.Mock).mockClear();
    const failure = new Error('vault clear failed');
    const vaultSpy = jest
      .spyOn(SessionKeyVault, 'clear')
      .mockImplementation(() => {
        throw failure;
      });
    const cacheSpy = jest
      .spyOn(AccountSecureStorage, 'clearPrivateKeyCache')
      .mockImplementation(() => {});

    expect(() => clearSessionSecurity()).toThrow(failure);

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

  it('still runs the whole teardown when the lock-signal step throws, then rethrows', () => {
    (clearMessagingKeyCache as jest.Mock).mockClear();
    AppLockSignal.setUnlocked(true);
    // AppLockSignal contains its listeners' throws (TASK-561), so inject the
    // step failure directly: apply the real state change, then throw.
    const failure = new Error('lock signal step failed');
    const realSetUnlocked = AppLockSignal.setUnlocked.bind(AppLockSignal);
    jest.spyOn(AppLockSignal, 'setUnlocked').mockImplementation((value) => {
      realSetUnlocked(value);
      throw failure;
    });
    const vaultSpy = jest.spyOn(SessionKeyVault, 'clear');
    const cacheSpy = jest
      .spyOn(AccountSecureStorage, 'clearPrivateKeyCache')
      .mockImplementation(() => {});

    expect(() => enterLockedState()).toThrow(failure);

    expect(AppLockSignal.isUnlocked()).toBe(false);
    expect(vaultSpy).toHaveBeenCalledTimes(1);
    expect(cacheSpy).toHaveBeenCalledTimes(1);
    expect(clearMessagingKeyCache).toHaveBeenCalledTimes(1);

    vaultSpy.mockRestore();
    cacheSpy.mockRestore();
  });
});
