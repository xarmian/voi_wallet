import { AppState, AppStateStatus } from 'react-native';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import {
  reviewGrant,
  reviewBindingDigest,
  REVIEW_IDLE_MS,
} from '../reviewGrant';

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    verifyPin: jest.fn(async () => true),
    getCredentialSource: jest.fn(async () => 'pin'),
    clearPrivateKeyCache: jest.fn(),
  },
}));
jest.mock('@/services/messaging/keyDerivation', () => ({
  clearMessagingKeyCache: jest.fn(),
}));

let background: (state: AppStateStatus) => void;
const input = {
  networkId: 'voi-mainnet',
  txnBytesBase64: ['AA==', 'AQ=='],
  signerAddresses: ['B', 'A'],
};
const digest = () => reviewBindingDigest(input);
const mint = (keys = ['A']) => {
  SessionKeyVault.set('fixture', 'pin');
  AppLockSignal.setUnlocked(true);
  reviewGrant.mintForWaiting(keys);
};
beforeEach(() => {
  jest.useFakeTimers();
  AppLockSignal.setUnlocked(false);
  reviewGrant.revoke();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      background = listener;
      return { remove: jest.fn() };
    });
});
afterEach(() => {
  reviewGrant.revoke();
  SessionKeyVault.clear();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('unlockMintsOnlyWaitingRequestCapabilities', () => {
  mint(['A', 'B']);
  expect(reviewGrant.isValid('A')).toBe(true);
  expect(reviewGrant.isValid('B')).toBe(true);
  expect(reviewGrant.isValid('C')).toBe(false);
  reviewGrant.mintForWaiting([]);
  expect(reviewGrant.isValid('A')).toBe(false);
  expect(reviewGrant.isValid('B')).toBe(false);
  expect(reviewGrant.isValid('C')).toBe(false);
});
// REGRESSION R7
it('lateArrivalNeedsFreshAuth', async () => {
  mint();
  expect(reviewGrant.isValid('C')).toBe(false);
  expect(reviewGrant.isValid('A')).toBe(true);
  expect(reviewGrant.isValid('C')).toBe(false);
  expect(reviewGrant.consume('C', digest())).toBe(false);
  AppLockSignal.setUnlocked(false);
  await reviewGrant.unlock('A', { pin: '123456' });
  await reviewGrant.unlock('C', { pin: '123456' });
  expect(AccountSecureStorage.verifyPin).toHaveBeenCalledTimes(2);
  expect(reviewGrant.isValid('A')).toBe(false);
  expect(reviewGrant.isValid('C')).toBe(true);
});
it('capabilityBoundToBytesChainAndReviewedSigners', () => {
  const d1 = digest();
  expect(d1).toMatch(/^[a-f0-9]{64}$/);
  expect(reviewBindingDigest({ ...input, signerAddresses: ['A', 'B'] })).toBe(
    d1
  );
  const changed = [
    { ...input, txnBytesBase64: ['AQ==', 'AA=='] },
    { ...input, networkId: 'algorand-mainnet' },
    { ...input, signerAddresses: ['C'] },
    { ...input, txnBytesBase64: ['AA==AQ=='] },
  ];
  for (const other of changed) {
    mint();
    const d2 = reviewBindingDigest(other);
    expect(d2).not.toBe(d1);
    expect(reviewGrant.consume('A', d1)).toBe(false);
    expect(reviewGrant.bind('A', d1)).toBe(true);
    expect(reviewGrant.bind('A', d1)).toBe(true);
    expect(reviewGrant.consume('A', d2)).toBe(false);
    expect(reviewGrant.consume('A', d1)).toBe(true);
    expect(reviewGrant.isConsumedFor('A', d2)).toBe(false);
    expect(reviewGrant.isConsumedFor('A', d1)).toBe(true);
    expect(reviewGrant.bind('A', d2)).toBe(false);
    expect(reviewGrant.isValid('A')).toBe(false);
    expect(reviewGrant.bind('A', d1)).toBe(false);
    expect(reviewGrant.isConsumedFor('A', d1)).toBe(false);
  }
});
it('consumeOnceUnderDoubleTap', () => {
  mint();
  reviewGrant.bind('A', digest());
  expect([
    reviewGrant.consume('A', digest()),
    reviewGrant.consume('A', digest()),
  ]).toEqual([true, false]);
});
it.each(['lock', 'background', 'epoch', 'deadline'] as const)(
  'lockBackgroundEpochRevokes: %s',
  (reason) => {
    mint();
    reviewGrant.bind('A', digest());
    if (reason === 'lock') AppLockSignal.setUnlocked(false);
    if (reason === 'background') background('background');
    if (reason === 'epoch') SessionKeyVault.set('rotated fixture', 'pin');
    if (reason === 'deadline') jest.setSystemTime(Date.now() + REVIEW_IDLE_MS);
    expect(reviewGrant.isValid('A')).toBe(false);
    expect(reviewGrant.consume('A', digest())).toBe(false);
    reviewGrant.touch('A');
    expect(reviewGrant.isValid('A')).toBe(false);
  }
);
it('unlockTransitionDoesNotRevokeTheFreshCapability', async () => {
  await reviewGrant.unlock('old', { pin: '123456' });
  AppLockSignal.setUnlocked(true);
  expect(reviewGrant.isValid('old')).toBe(false);
  reviewGrant.mintForWaiting(['A']);
  expect(reviewGrant.isValid('A')).toBe(true);
  AppLockSignal.setUnlocked(true);
  expect(reviewGrant.isValid('A')).toBe(true);
  AppLockSignal.setUnlocked(false);
  expect(reviewGrant.isValid('A')).toBe(false);
  expect(reviewGrant.isValid('old')).toBe(false);
});
it('touchOnlyRenewsAnIncludedLiveRequest', () => {
  mint(['A', 'B']);
  jest.setSystemTime(Date.now() + REVIEW_IDLE_MS - 1);
  reviewGrant.touch('C');
  jest.setSystemTime(Date.now() + 1);
  expect(reviewGrant.isValid('A')).toBe(false);
  expect(reviewGrant.isValid('B')).toBe(false);
  mint(['A', 'B']);
  jest.advanceTimersByTime(REVIEW_IDLE_MS - 1);
  reviewGrant.touch('A');
  jest.advanceTimersByTime(1);
  expect(reviewGrant.isValid('A')).toBe(true);
  expect(reviewGrant.isValid('B')).toBe(false);
});

// DEFECT
it('settleStartsAFreshWindow', async () => {
  await reviewGrant.unlock('A', { pin: '123456' });
  reviewGrant.bind('A', digest());
  expect(reviewGrant.pauseIdle('A')).toBe(false);
  expect(reviewGrant.consume('A', digest())).toBe(true);
  expect(reviewGrant.pauseIdle('A')).toBe(true);
  jest.advanceTimersByTime(5 * REVIEW_IDLE_MS);
  expect(reviewGrant.isConsumedFor('A', digest())).toBe(true);
  reviewGrant.settle('A');
  jest.advanceTimersByTime(59_000);
  expect(reviewGrant.isValid('A')).toBe(true);
  jest.advanceTimersByTime(1_001);
  expect(reviewGrant.isValid('A')).toBe(false);
  expect(reviewGrant.isUnspent('A')).toBe(false);
  expect(reviewGrant.endReason('A')).toBe('idle');
  expect(reviewGrant.pauseIdle('A')).toBe(false);
  reviewGrant.settle('A');
  expect(reviewGrant.isValid('A')).toBe(false);
});
// REGRESSION: pause must not change the wallet's lock state or auto-lock wiring.
it('pauseDoesNotTouchAutoLock', () => {
  const { readFileSync } = require('fs');
  const source = readFileSync(
    require.resolve('../reviewGrant'),
    'utf8'
  ) as string;
  expect(source.replace(/^\s*\/\/.*$/gm, '')).not.toMatch(
    /AppLockSignal\.setUnlocked|AuthContext/
  );
});
// DEFECT: both waiting permissions used to share activity and consumption deadlines.
it('touchAndConsumeRenewOnlyTheirOwnRequest', () => {
  for (const activity of ['touch', 'consume']) {
    mint(['A', 'B']);
    reviewGrant.bind('A', digest());
    jest.advanceTimersByTime(30_000);
    if (activity === 'touch') reviewGrant.touch('A');
    else expect(reviewGrant.consume('A', digest())).toBe(true);
    jest.advanceTimersByTime(30_001);
    expect(reviewGrant.isValid('B')).toBe(false);
    expect(reviewGrant.isValid('A')).toBe(true);
    reviewGrant.leave('A');
    expect(reviewGrant.isValid('A')).toBe(false);
    expect(reviewGrant.isValid('B')).toBe(false);
  }
});
// DEFECT: every removal must discard the pause as well as the permission.
it.each(['leave', 'revoke', 'epoch', 'background', 'lock'] as const)(
  'pausedKeyEndsImmediately:%s',
  (event) => {
    mint();
    reviewGrant.bind('A', digest());
    reviewGrant.consume('A', digest());
    expect(reviewGrant.pauseIdle('A')).toBe(true);
    if (event === 'leave') reviewGrant.leave('A');
    if (event === 'revoke') reviewGrant.revoke();
    if (event === 'epoch') SessionKeyVault.set('rotated fixture', 'pin');
    if (event === 'background') background('background');
    if (event === 'lock') AppLockSignal.setUnlocked(false);
    expect(reviewGrant.isValid('A')).toBe(false);
    expect(reviewGrant.isUnspent('A')).toBe(false);
    expect(reviewGrant.pauseIdle('A')).toBe(false);
    reviewGrant.settle('A');
    jest.advanceTimersByTime(REVIEW_IDLE_MS);
    expect(reviewGrant.isValid('A')).toBe(false);
  }
);

// DEFECT
it('snapshotReadsAreSideEffectFree', async () => {
  AppLockSignal.setUnlocked(false);
  await reviewGrant.unlock('A', { pin: '123456' });
  const listener = jest.fn();
  const unsubscribe = reviewGrant.subscribe(listener);
  const clear = jest.spyOn(SessionKeyVault, 'clear');
  jest.setSystemTime(Date.now() + REVIEW_IDLE_MS + 1);
  expect(reviewGrant.isValid('A')).toBe(false);
  expect(reviewGrant.isUnspent('A')).toBe(false);
  expect(listener).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  expect(SessionKeyVault.isUnlocked()).toBe(true);
  expect(reviewGrant.endReason('A')).toBeNull();
  reviewGrant.touch('A');
  expect(listener).toHaveBeenCalled();
  expect(clear).toHaveBeenCalled();
  expect(reviewGrant.endReason('A')).toBe('idle');
  unsubscribe();
});
// DEFECT
it('perKeyEndReason', () => {
  mint(['K1', 'K2']);
  reviewGrant.bind('K1', digest());
  reviewGrant.consume('K1', digest());
  reviewGrant.pauseIdle('K1');
  jest.advanceTimersByTime(REVIEW_IDLE_MS + 1);
  AppLockSignal.setUnlocked(false);
  expect(reviewGrant.endReason('K2')).toBe('idle');
  expect(reviewGrant.endReason('K1')).toBe('lock');
});
