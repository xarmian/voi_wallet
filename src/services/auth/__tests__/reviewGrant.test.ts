import { AppState } from 'react-native';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { reviewGrant, REVIEW_IDLE_MS } from '../reviewGrant';

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    verifyPin: jest.fn(async () => true),
    getCredentialSource: jest.fn(async () => 'pin'),
    isBiometricEnabled: jest.fn(async () => true),
    getBiometricSecret: jest.fn(async () => ({
      secret: 'fixture',
      secretSource: 'pin',
    })),
    clearPrivateKeyCache: jest.fn(),
  },
}));
jest.mock('@/services/messaging/keyDerivation', () => ({
  clearMessagingKeyCache: jest.fn(),
}));

beforeEach(() => {
  jest.useFakeTimers();
  AppLockSignal.setUnlocked(false);
  reviewGrant.revoke();
});
afterEach(() => {
  reviewGrant.revoke();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('authenticates once for queued requests across dApps, requires a fresh Sign for each, then clears keys', async () => {
  expect(await reviewGrant.unlock('one:1', { pin: '123456' })).toBe(true);
  expect(AppLockSignal.isUnlocked()).toBe(false);
  expect(reviewGrant.consume('one:1')).toBe(true);
  expect(reviewGrant.consume('one:1')).toBe(false);
  reviewGrant.continueTo('two:2');
  reviewGrant.leave('one:1');
  expect(reviewGrant.isValid('two:2')).toBe(true);
  expect(reviewGrant.consume('two:2')).toBe(true);
  expect(AccountSecureStorage.verifyPin).toHaveBeenCalledTimes(1);
  reviewGrant.leave('two:2');
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});
it('uses one biometric secret read and rejects other request keys and changed vault epochs', async () => {
  expect(await reviewGrant.unlock('one:1', { biometric: true })).toBe(true);
  expect(AccountSecureStorage.getBiometricSecret).toHaveBeenCalledTimes(1);
  expect(AccountSecureStorage.getBiometricSecret).toHaveBeenCalledWith(
    'Unlock to review WalletConnect requests'
  );
  expect(reviewGrant.isValid('other:2')).toBe(false);
  SessionKeyVault.clear();
  expect(reviewGrant.isValid('one:1')).toBe(false);
});
it('expires after idle timeout and clears keys', async () => {
  await reviewGrant.unlock('one:1', { pin: '123456' });
  jest.advanceTimersByTime(REVIEW_IDLE_MS);
  expect(reviewGrant.isValid('one:1')).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});
it('revokes on background and discards late biometric completions', async () => {
  let change!: (state: string) => void;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      change = () => listener('background');
      return { remove: jest.fn() };
    });
  await reviewGrant.unlock('one:1', { biometric: true });
  change('background');
  expect(reviewGrant.isValid('one:1')).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
  let finish!: (value: any) => void;
  (AccountSecureStorage.getBiometricSecret as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const pending = reviewGrant.unlock('one:1', { biometric: true });
  await Promise.resolve();
  reviewGrant.revoke();
  finish({ secret: 'fixture', secretSource: 'pin' });
  expect(await pending).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});

it('does not revive an expired sitting when a delayed touch arrives', async () => {
  await reviewGrant.unlock('one:1', { pin: '123456' });
  jest.setSystemTime(Date.now() + REVIEW_IDLE_MS + 1);
  reviewGrant.touch();
  expect(reviewGrant.isValid('one:1')).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});

it('does not clear the vault of a wallet unlocked normally', () => {
  AppLockSignal.setUnlocked(true);
  SessionKeyVault.set('fixture', 'pin');
  reviewGrant.revoke();
  expect(SessionKeyVault.isUnlocked()).toBe(true);
  SessionKeyVault.clear();
});

it('uses the stored passphrase kind for review', async () => {
  (AccountSecureStorage.getCredentialSource as jest.Mock).mockResolvedValueOnce(
    'passphrase'
  );
  expect(await reviewGrant.unlock('one:1', { pin: 'fixture passphrase' })).toBe(
    true
  );
  expect(SessionKeyVault.getSecretSource()).toBe('passphrase');
});

it('ends review immediately on an explicit re-lock, even before vault teardown', async () => {
  await reviewGrant.unlock('one:1', { pin: '123456' });
  AppLockSignal.setUnlocked(false);
  expect(reviewGrant.isValid('one:1')).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});

it('does not extend the idle deadline when the queue advances automatically', async () => {
  await reviewGrant.unlock('one:1', { pin: '123456' });
  jest.advanceTimersByTime(REVIEW_IDLE_MS - 1);
  reviewGrant.continueTo('two:2');
  jest.advanceTimersByTime(1);
  expect(reviewGrant.isValid('two:2')).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});

// TASK-437 review P2: a request that arrives while one is under review is
// pushed over it (not queued). Unlocking it re-authenticated, which bumped the
// vault epoch, revoked the sitting and failed that first attempt.
it('lets a request pushed over a live review join the sitting with no second auth', async () => {
  expect(await reviewGrant.unlock('a:1', { pin: '123456' })).toBe(true);

  expect(await reviewGrant.unlock('b:2', { pin: '123456' })).toBe(true);

  expect(AccountSecureStorage.verifyPin).toHaveBeenCalledTimes(1);
  expect(reviewGrant.isValid('a:1')).toBe(true);
  expect(reviewGrant.isValid('b:2')).toBe(true);
  // Each request still needs its own Sign tap.
  expect(reviewGrant.consume('b:2')).toBe(true);
  expect(reviewGrant.consume('b:2')).toBe(false);
  expect(reviewGrant.consume('a:1')).toBe(true);
});

it('joins only a live sitting', async () => {
  expect(reviewGrant.join('a:1')).toBe(false);
  expect(reviewGrant.isValid('a:1')).toBe(false);

  await reviewGrant.unlock('a:1', { pin: '123456' });
  jest.advanceTimersByTime(REVIEW_IDLE_MS);
  expect(reviewGrant.join('b:2')).toBe(false);
  expect(reviewGrant.isValid('b:2')).toBe(false);
});

it('ends the sitting only when its last request leaves', async () => {
  await reviewGrant.unlock('a:1', { pin: '123456' });
  reviewGrant.join('b:2');

  reviewGrant.leave('b:2');
  expect(reviewGrant.isValid('a:1')).toBe(true);
  expect(SessionKeyVault.isUnlocked()).toBe(true);

  reviewGrant.leave('a:1');
  expect(reviewGrant.isValid('a:1')).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});

it('ignores a leave from a screen with no part in the sitting', async () => {
  let verify!: (value: boolean) => void;
  (AccountSecureStorage.verifyPin as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        verify = resolve;
      })
  );
  const pending = reviewGrant.unlock('b:2', { pin: '123456' });
  await Promise.resolve();

  // e.g. the previous request's screen unmounting after a replace, or an
  // in-app signing screen (requestKey '').
  reviewGrant.leave('a:1');
  reviewGrant.leave('');
  verify(true);

  expect(await pending).toBe(true);
  expect(reviewGrant.isValid('b:2')).toBe(true);
});

it('aborts a request’s own in-flight unlock when its screen leaves', async () => {
  let verify!: (value: boolean) => void;
  (AccountSecureStorage.verifyPin as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        verify = resolve;
      })
  );
  const pending = reviewGrant.unlock('b:2', { pin: '123456' });
  await Promise.resolve();

  reviewGrant.leave('b:2');
  verify(true);

  expect(await pending).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(false);
});

it('gives a request its Sign back after a failed attempt, only while the sitting is live', async () => {
  await reviewGrant.unlock('a:1', { pin: '123456' });
  expect(reviewGrant.consume('a:1')).toBe(true);
  expect(reviewGrant.consume('a:1')).toBe(false);

  reviewGrant.release('a:1');
  expect(reviewGrant.consume('a:1')).toBe(true);

  reviewGrant.revoke();
  reviewGrant.release('a:1');
  expect(reviewGrant.consume('a:1')).toBe(false);
});

// TASK-438 (Luna P2 on #241): a session proposal that arrives during a signing
// review joins the sitting before the signing screen is popped, so the
// sitting survives that screen leaving and the proposal needs no second auth.
it('keeps the sitting for a proposal that joins before the signing review leaves', async () => {
  const { walletConnectProposalKey } = require('../reviewGrant');
  const proposalKey = walletConnectProposalKey('pairing-1', 9);
  expect(await reviewGrant.unlock('sign:1', { pin: '123456' })).toBe(true);

  expect(reviewGrant.join(proposalKey)).toBe(true);
  reviewGrant.leave('sign:1');

  expect(reviewGrant.isValid(proposalKey)).toBe(true);
  expect(await reviewGrant.unlock(proposalKey, { pin: '123456' })).toBe(true);
  expect(AccountSecureStorage.verifyPin).toHaveBeenCalledTimes(1);
});
