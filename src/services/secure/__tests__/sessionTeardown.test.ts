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

import { clearSessionSecurity } from '../sessionTeardown';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';
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
