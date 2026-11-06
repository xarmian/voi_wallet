import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import { AuthProvider, useAuth } from '../AuthContext';
import { AccountSecureStorage } from '@/services/secure';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { unlockVaultWithBiometrics } from '@/services/secure/biometricUnlock';
import { MultiAccountWalletService } from '@/services/wallet';
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import { isPinSetupPending } from '@/services/secure/pinSetupPending';
import {
  reviewGrant,
  walletConnectRequestKey,
} from '@/services/auth/reviewGrant';
import { TransactionRequestQueue } from '@/services/walletconnect/TransactionRequestQueue';
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: jest.fn(),
    hasWalletWithAccountsStrict: jest.fn(),
    hasKeyBearingAccountStrict: jest.fn(),
  },
}));

jest.mock('@/services/wallet/crossStoreReconcile', () => ({
  reconcileCrossStoreHalfState: jest.fn(),
}));

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    hasPin: jest.fn(),
    hasPinStrict: jest.fn(),
    isBiometricEnabled: jest.fn(),
    getPinTimeout: jest.fn(),
    verifyPin: jest.fn(),
    getCredentialSource: jest.fn(),
    migrateAllAccountsToV2: jest.fn(),
    setupPin: jest.fn(),
    setBiometricSecret: jest.fn(),
    setBiometricEnabled: jest.fn(),
    clearBiometricSecret: jest.fn(),
    readWipeIntentStrict: jest.fn(),
  },
}));

jest.mock('@/services/wipe', () => ({
  wipeWalletData: jest.fn(),
  isWipeInFlight: jest.fn(),
}));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: jest.fn(),
}));

jest.mock('@/services/secure/pinSetupPending', () => ({
  isPinSetupPending: jest.fn(),
  clearPinSetupPending: jest.fn(),
}));

jest.mock('@/services/walletconnect/TransactionRequestQueue', () => ({
  TransactionRequestQueue: { getAll: jest.fn() },
}));

jest.mock('@/services/secure/biometricUnlock', () => ({
  unlockVaultWithBiometrics: jest.fn(),
}));

jest.mock('@/services/messaging/keyDerivation', () => ({
  clearMessagingKeyCache: jest.fn(),
}));
jest.mock('@/utils/security', () => ({
  SecurityUtils: { generateSessionId: jest.fn(() => 'test-session-id') },
}));

jest.mock('@/services/deeplink', () => ({
  DeepLinkService: {
    getInstance: jest.fn(() => ({ setUnlockState: jest.fn() })),
  },
}));

jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
}));

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    verifyPin: jest.fn(),
    clearPrivateKeyCache: jest.fn(),
  },
}));
const queued = [
  { topic: 'topic', id: 1 },
  { topic: 'topic', id: 2 },
];
const queue = TransactionRequestQueue.getAll as jest.Mock;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);
let listeners: Set<(state: AppStateStatus) => void>;
beforeEach(() => {
  jest.useFakeTimers();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  listeners = new Set();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    });
  (
    MultiAccountWalletService.hasWalletWithAccountsStrict as jest.Mock
  ).mockResolvedValue(true);
  (
    MultiAccountWalletService.hasKeyBearingAccountStrict as jest.Mock
  ).mockResolvedValue(false);
  (MultiAccountWalletService.getCurrentWallet as jest.Mock).mockResolvedValue({
    accounts: [{ id: 'a' }],
  });
  (reconcileCrossStoreHalfState as jest.Mock).mockResolvedValue({
    ran: true,
    orphanSecretsDeleted: [],
    phantomAccountsPruned: [],
    staleJournalDropped: [],
  });
  (isPinSetupPending as jest.Mock).mockResolvedValue(false);
  for (const name of [
    'hasPinStrict',
    'hasPin',
    'isBiometricEnabled',
    'verifyPin',
  ] as const)
    (AccountSecureStorage[name] as jest.Mock).mockResolvedValue(true);
  (AccountSecureStorage.getPinTimeout as jest.Mock).mockResolvedValue(5);
  (AccountSecureStorage.getCredentialSource as jest.Mock).mockResolvedValue(
    'pin'
  );
  (AccountSecureStorage.readWipeIntentStrict as jest.Mock).mockResolvedValue(
    false
  );
  (unlockVaultWithBiometrics as jest.Mock).mockImplementation(async () => {
    SessionKeyVault.set('fixture', 'pin');
    return { status: 'unlocked' };
  });
  queue.mockReset().mockResolvedValue(queued);
});
afterEach(() => {
  reviewGrant.revoke(false);
  SessionKeyVault.clear();
  AppLockSignal.setUnlocked(false);
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});
async function mount() {
  const rendered = await renderHook(() => useAuth(), { wrapper });
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  expect(rendered.result.current.authState.isLocked).toBe(true);
  return rendered;
}
function expectPermissions(valid: boolean) {
  for (const { topic, id } of queued)
    expect(reviewGrant.isValid(walletConnectRequestKey(topic, id))).toBe(valid);
  expect(reviewGrant.isValid(walletConnectRequestKey('topic', 3))).toBe(false);
}
// REGRESSION R3(a): PIN and biometric unlock each mint the complete waiting set.
it.each(['PIN', 'biometric'])(
  'normal%sUnlockMintsWaitingCapabilities',
  async (method) => {
    const { result } = await mount();
    await act(async () => {
      expect(
        await (method === 'PIN'
          ? result.current.unlock('123456')
          : result.current.unlockWithBiometrics())
      ).toBe(true);
    });
    expect(queue).toHaveBeenCalledTimes(1);
    expectPermissions(true);
  }
);
// REGRESSION R3(b): queue rejection explicitly revokes any prior capability.
it('queueReadRejectionMintsNothing', async () => {
  const { result } = await mount();
  queue.mockRejectedValueOnce(new Error('queue unreadable'));
  const revoke = jest.spyOn(reviewGrant, 'revoke');
  const mint = jest.spyOn(reviewGrant, 'mintForWaiting');
  await act(async () => {
    await result.current.unlock('123456');
  });
  expect(revoke).toHaveBeenCalledWith(false);
  expect(mint).not.toHaveBeenCalled();
  expectPermissions(false);
});
// REGRESSION R3(c)-(e): assert the mint boundary as well as its effect, so a
// second defence inside reviewGrant cannot conceal a missing capture guard.
it.each(['backgroundEvent', 'backgroundState', 'epoch', 'lock'] as const)(
  'pendingQueue%sMintsNothing',
  async (interruption) => {
    const { result } = await mount();
    let finish!: (value: typeof queued) => void;
    queue.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const mint = jest.spyOn(reviewGrant, 'mintForWaiting');
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = result.current.unlock('123456');
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(queue).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (interruption === 'backgroundEvent') {
        [...listeners].forEach((listener) => listener('background'));
        [...listeners].forEach((listener) => listener('active'));
      }
      if (interruption === 'backgroundState')
        AppState.currentState = 'background';
      if (interruption === 'epoch')
        SessionKeyVault.set('rotated fixture', 'pin');
      if (interruption === 'lock') AppLockSignal.setUnlocked(false);
      finish(queued);
      await pending;
    });
    expect(mint).not.toHaveBeenCalled();
    expectPermissions(false);
  }
);
