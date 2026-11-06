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
  expect(reviewGrant.isLive()).toBe(false);
});
it('lateArrivalNeedsFreshAuth', async () => {
  mint();
  expect(reviewGrant.join('C')).toBe(false);
  reviewGrant.continueTo('C');
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
});
it('touchOnlyRenewsAnIncludedLiveRequest', () => {
  mint();
  jest.setSystemTime(Date.now() + REVIEW_IDLE_MS - 1);
  reviewGrant.touch('C');
  jest.setSystemTime(Date.now() + 1);
  expect(reviewGrant.isLive()).toBe(false);
  mint();
  jest.advanceTimersByTime(REVIEW_IDLE_MS - 1);
  reviewGrant.touch('A');
  jest.advanceTimersByTime(1);
  expect(reviewGrant.isLive()).toBe(true);
});
