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
  walletConnectProposalKey,
  walletConnectRequestKey,
  walletConnectV1ProposalKey,
} from '@/services/auth/reviewGrant';
import type { QueueItem } from '@/services/walletconnect/requestQueue';

// The review queue and the coordinator are stubbed at their singletons; the
// key builders and the grant are the real ones.
const mockQueue: {
  head: QueueItem | null;
  result: unknown;
  waiting: QueueItem[];
  failRead: boolean;
} = { head: null, result: null, waiting: [], failRead: false };
const mockOpen = new Set<string>();
const mockRefKey = (ref: QueueItem['ref']) =>
  JSON.stringify([ref.version, ref.kind, ref.topic, String(ref.id)]);
jest.mock('@/services/walletconnect/requestQueue', () => ({
  RequestQueue: {
    getInstance: () => ({
      getSnapshot: () => {
        if (mockQueue.failRead) throw new Error('queue unreadable');
        return {
          head: mockQueue.head,
          result: mockQueue.result,
          waiting: mockQueue.waiting,
          revision: 1,
        };
      },
    }),
  },
}));
jest.mock('@/services/walletconnect/requestCoordinator', () => ({
  RequestCoordinator: {
    getInstance: () => ({
      isOpen: (ref: QueueItem['ref']) => mockOpen.has(mockRefKey(ref)),
    }),
  },
}));
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
  // The pure predicate stays real: it is the one the app and the guard share.
  isSetupResumeState: jest.requireActual('@/services/secure/pinSetupPending')
    .isSetupResumeState,
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
const item = (
  ref: QueueItem['ref'],
  payload: unknown = {},
  open = true
): QueueItem => {
  if (open) mockOpen.add(mockRefKey(ref));
  return { ref, kind: ref.kind, payload, firstSeenMs: 0, arrivalSeq: 1 };
};
// Open items the person still has in front of them, with the key each review
// checks. v1 request ids are numbers on the wire; a v1 proposal is keyed by
// its peer id, never its request id.
const reviewed = [
  {
    key: walletConnectRequestKey('topic', 1),
    ref: { version: 2, kind: 'request', topic: 'topic', id: 1 } as const,
  },
  {
    key: walletConnectRequestKey('v1-topic', 12),
    ref: { version: 1, kind: 'request', topic: 'v1-topic', id: 12 } as const,
  },
  {
    key: walletConnectProposalKey('pairing', 7),
    ref: { version: 2, kind: 'proposal', topic: 'pairing', id: 7 } as const,
  },
  {
    key: walletConnectV1ProposalKey('peer-9'),
    ref: { version: 1, kind: 'proposal', topic: 'v1-proposal', id: 5 } as const,
    payload: { id: 5, peerId: 'peer-9' },
  },
];
// Never granted: a settled item still queued, a result card, an unrelated key.
const notGranted = [
  walletConnectRequestKey('topic', 2),
  walletConnectRequestKey('topic', 3),
  walletConnectRequestKey('topic', 4),
  walletConnectRequestKey('v1', 'proposal-5'),
  walletConnectProposalKey('pairing', 8),
];
function fillQueue() {
  mockOpen.clear();
  const [head, ...rest] = reviewed.map(({ ref, payload }) =>
    item(ref, payload)
  );
  mockQueue.head = head;
  mockQueue.waiting = [
    ...rest,
    item({ version: 2, kind: 'request', topic: 'topic', id: 2 }, {}, false),
  ];
  mockQueue.result = {
    ref: { version: 2, kind: 'request', topic: 'topic', id: 3 },
    title: 'Done',
  };
}
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
  mockQueue.failRead = false;
  fillQueue();
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
  for (const { key } of reviewed) expect(reviewGrant.isValid(key)).toBe(valid);
  for (const key of notGranted) expect(reviewGrant.isValid(key)).toBe(false);
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
    expectPermissions(true);
  }
);
// A decided head is no longer in front of the person, so it gets nothing; the
// open items behind it still do.
it('decidedHeadGetsNoCapability', async () => {
  const { result } = await mount();
  mockOpen.delete(mockRefKey(mockQueue.head!.ref));
  await act(async () => {
    expect(await result.current.unlock('123456')).toBe(true);
  });
  expect(reviewGrant.isValid(reviewed[0].key)).toBe(false);
  for (const { key } of reviewed.slice(1))
    expect(reviewGrant.isValid(key)).toBe(true);
});
it('emptyQueueMintsNothing', async () => {
  const { result } = await mount();
  mockQueue.head = null;
  mockQueue.waiting = [];
  mockQueue.result = null;
  await act(async () => {
    expect(await result.current.unlock('123456')).toBe(true);
  });
  expectPermissions(false);
});
// REGRESSION R3(b): queue rejection explicitly revokes any prior capability.
it('queueReadRejectionMintsNothing', async () => {
  const { result } = await mount();
  mockQueue.failRead = true;
  const revoke = jest.spyOn(reviewGrant, 'revoke');
  const mint = jest.spyOn(reviewGrant, 'mintForWaiting');
  await act(async () => {
    await result.current.unlock('123456');
  });
  expect(revoke).toHaveBeenCalledWith(false);
  expect(mint).not.toHaveBeenCalled();
  expectPermissions(false);
});
// The queue is read synchronously now, so nothing can interleave with the
// read; the grant's own guard is what stops a background unlock minting.
it('backgroundUnlockMintsNothing', async () => {
  const { result } = await mount();
  AppState.currentState = 'background';
  await act(async () => {
    await result.current.unlock('123456');
  });
  expectPermissions(false);
});
