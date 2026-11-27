// TASK-557: every checkInitialAuthState verdict that lands LOCKED runs the
// session teardown lock() runs, synchronously and BEFORE the state update, on
// boot and on every recheckAuthState().
//
// The provider is the real one, and so are the session vault, the lock signal,
// the teardown, the review grant, the messaging key cache and the 60 s private
// key cache (the real AccountSecureStorage class, loaded through the teardown's
// direct import). The storage reads AuthContext makes go through the mocked
// `@/services/secure` barrel.
//
// SECURITY NOTE: throwaway fixtures only (a fixture PIN, a tweetnacl keypair, a
// 0xAA-filled buffer). No real key material.

import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import nacl from 'tweetnacl';
import { act, renderHook } from '@testing-library/react-native';
import { AuthProvider, useAuth, type AuthState } from '../AuthContext';
import { AccountSecureStorage } from '@/services/secure';
import { AccountSecureStorage as RealAccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { AppLockSignal } from '@/services/secure/appLockState';
import { MultiAccountWalletService } from '@/services/wallet';
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import {
  clearPinSetupPending,
  isPinSetupPending,
} from '@/services/secure/pinSetupPending';
import { wipeWalletData, isWipeInFlight } from '@/services/wipe';
import { reviewGrant } from '@/services/auth/reviewGrant';
import {
  clearAllCachedKeys,
  deriveMessagingKeyPairFromSecret,
  getCachedKeyPair,
} from '@/services/messaging/keyDerivation';

// Minimal platform so the real AccountSecureStorage class resolves; the cache
// methods exercised here touch none of it.
jest.mock('@/platform', () => ({
  crypto: {},
  secureStorage: {},
  storage: {},
  biometrics: {},
  deviceId: {},
}));

jest.mock('@/services/walletconnect/requestQueue', () => ({
  RequestQueue: {
    getInstance: () => ({
      getSnapshot: () => ({
        head: null,
        result: null,
        waiting: [],
        revision: 1,
      }),
    }),
  },
}));
jest.mock('@/services/walletconnect/requestCoordinator', () => ({
  RequestCoordinator: {
    getInstance: () => ({ isOpen: () => false }),
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

const ADDR = 'TESTADDRESS0000000000000000000000000000000000000000000';
const FIXTURE_PIN = '123456';
const CACHE_KEY = 'fixture-account';

// The private 60 s cache, reached through a typed cast (test seam only).
type CacheEntry = { key: Uint8Array; timestamp: number };
const privateKeyCache = (): Map<string, CacheEntry> =>
  (
    RealAccountSecureStorage as unknown as {
      privateKeyCache: Map<string, CacheEntry>;
    }
  ).privateKeyCache;

type Probe = {
  isLocked: boolean;
  securityUnavailable: boolean;
  signal: boolean;
  vault: boolean;
  msg: boolean;
};

// Render probe: what the first render of a verdict sees. A teardown that runs
// before setAuthState is already visible here; one left to the sync effect is
// not.
const probe: { armed: boolean; renders: Probe[] } = {
  armed: false,
  renders: [],
};

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthProvider>{children}</AuthProvider>
);

function useProbedAuth() {
  const auth = useAuth();
  if (probe.armed) {
    probe.renders.push({
      isLocked: auth.authState.isLocked,
      securityUnavailable: auth.authState.securityUnavailable,
      signal: AppLockSignal.isUnlocked(),
      vault: SessionKeyVault.isUnlocked(),
      msg: getCachedKeyPair(ADDR) !== null,
    });
  }
  return auth;
}

// Enough microtasks for one uninterrupted pass through checkInitialAuthState,
// then fake time for the strict-read retry backoff.
const flush = async (ticks = 60) => {
  await act(async () => {
    for (let i = 0; i < ticks; i += 1) await Promise.resolve();
  });
};
const flushWithRetries = async () => {
  await act(async () => {
    for (let round = 0; round < 12; round += 1) {
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
      jest.advanceTimersByTime(500);
    }
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  });
};

type Rendered = Awaited<ReturnType<typeof mount>>;

async function mount() {
  const rendered = await renderHook(() => useProbedAuth(), { wrapper });
  await flush();
  expect(rendered.result.current.authState.authChecked).toBe(true);
  return rendered;
}

async function unlockLive(rendered: Rendered) {
  await act(async () => {
    expect(await rendered.result.current.unlock(FIXTURE_PIN)).toBe(true);
  });
  await flush();
  expect(rendered.result.current.authState.isLocked).toBe(false);
  expect(SessionKeyVault.isUnlocked()).toBe(true);
  expect(AppLockSignal.isUnlocked()).toBe(true);
}

// Seeds the 60 s cache and (while the signal is unlocked) the messaging cache.
function seedCaches() {
  const cachedKey = new Uint8Array(32).fill(0xaa);
  privateKeyCache().set(CACHE_KEY, { key: cachedKey, timestamp: Date.now() });
  let keyPair: ReturnType<typeof deriveMessagingKeyPairFromSecret> | null =
    null;
  if (AppLockSignal.isUnlocked()) {
    keyPair = deriveMessagingKeyPairFromSecret(
      nacl.sign.keyPair().secretKey,
      ADDR
    );
    expect(getCachedKeyPair(ADDR)).not.toBeNull();
  }
  expect(privateKeyCache().size).toBe(1);
  return { cachedKey, keyPair };
}

async function recheck(rendered: Rendered, withRetries = false) {
  probe.renders = [];
  probe.armed = true;
  let settled = false;
  await act(async () => {
    void rendered.result.current.recheckAuthState().then(() => {
      settled = true;
    });
  });
  if (withRetries) await flushWithRetries();
  else await flush();
  probe.armed = false;
  expect(settled).toBe(true);
}

function expectTornDown(seeded: ReturnType<typeof seedCaches>) {
  // (a) The first render of the locked verdict already sees the teardown.
  const landing = probe.renders.find((r) => r.isLocked);
  expect(landing).toBeDefined();
  expect(landing).toMatchObject({ signal: false, vault: false, msg: false });
  // (b) Vault empty.
  expect(SessionKeyVault.isUnlocked()).toBe(false);
  expect(SessionKeyVault.getSecret()).toBeNull();
  // (c) 60 s cache dropped and its buffer zeroed.
  expect(privateKeyCache().size).toBe(0);
  expect(seeded.cachedKey.every((b) => b === 0)).toBe(true);
  // (d) Messaging cache dropped and its secret zeroed.
  expect(getCachedKeyPair(ADDR)).toBeNull();
  if (seeded.keyPair) {
    expect(seeded.keyPair.secretKey.every((b) => b === 0)).toBe(true);
  }
  // (e) Signal locked.
  expect(AppLockSignal.isUnlocked()).toBe(false);
}

const FAIL_CLOSED_FIELDS = {
  isLocked: true,
  isAuthenticated: false,
  securityUnavailable: true,
  authChecked: true,
  pinSetupResume: false,
  biometricEnabled: false,
  backgroundedAt: null,
} as const;

let appStateListeners: Set<(state: AppStateStatus) => void>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  appStateListeners = new Set();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    });

  // Default verdict: wallet + PIN (locked).
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
  (clearPinSetupPending as jest.Mock).mockResolvedValue(undefined);
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
  (isWipeInFlight as jest.Mock).mockReturnValue(false);
  (wipeWalletData as jest.Mock).mockResolvedValue(undefined);

  probe.armed = false;
  probe.renders = [];
});

afterEach(() => {
  probe.armed = false;
  reviewGrant.revoke(false);
  SessionKeyVault.clear();
  RealAccountSecureStorage.clearPrivateKeyCache();
  clearAllCachedKeys();
  AppLockSignal.setUnlocked(false);
  jest.clearAllMocks();
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('recheck from a live session lands locked with the session torn down', () => {
  // L733: wallet + PIN (ChangePin, onboarding restore OK).
  it('walletAndPin_recheckFromLiveSession_tearsDown', async () => {
    const rendered = await mount();
    await unlockLive(rendered);
    const seeded = seedCaches();
    const before = rendered.result.current.authState;

    await recheck(rendered);

    expectTornDown(seeded);
    expect(rendered.result.current.authState).toEqual<AuthState>({
      ...before,
      isLocked: true,
      isAuthenticated: false,
      securityUnavailable: false,
      authChecked: true,
      pinSetupResume: false,
      hasWallet: true,
      biometricEnabled: true,
      backgroundedAt: null,
      timeoutMinutes: 5,
      hasPin: true,
    });
  });

  // L522: strict lock reads still fail after the bounded retries.
  it('strictReadsFail_recheckFromLiveSession_tearsDown', async () => {
    const rendered = await mount();
    await unlockLive(rendered);
    const seeded = seedCaches();
    const before = rendered.result.current.authState;
    (
      MultiAccountWalletService.hasWalletWithAccountsStrict as jest.Mock
    ).mockRejectedValue(new Error('keystore unreadable'));

    await recheck(rendered, true);

    expect(
      MultiAccountWalletService.hasWalletWithAccountsStrict
    ).toHaveBeenCalledTimes(1 + 3);
    expectTornDown(seeded);
    expect(rendered.result.current.authState).toEqual<AuthState>({
      ...before,
      ...FAIL_CLOSED_FIELDS,
    });
  });

  // L699: key-bearing account, PIN read absent, no restore breadcrumb.
  it('keyBearingNoPin_recheckFromLiveSession_tearsDown', async () => {
    const rendered = await mount();
    await unlockLive(rendered);
    const seeded = seedCaches();
    const before = rendered.result.current.authState;
    (
      MultiAccountWalletService.hasKeyBearingAccountStrict as jest.Mock
    ).mockResolvedValue(true);
    (AccountSecureStorage.hasPinStrict as jest.Mock).mockResolvedValue(false);
    (isPinSetupPending as jest.Mock).mockResolvedValue(false);

    await recheck(rendered);

    expectTornDown(seeded);
    expect(rendered.result.current.authState).toEqual<AuthState>({
      ...before,
      ...FAIL_CLOSED_FIELDS,
    });
  });

  // L754: an unexpected throw reaches the outer catch.
  it('unexpectedFailure_recheckFromLiveSession_tearsDown', async () => {
    const rendered = await mount();
    await unlockLive(rendered);
    const seeded = seedCaches();
    const before = rendered.result.current.authState;
    (clearPinSetupPending as jest.Mock).mockImplementationOnce(() => {
      throw new Error('unexpected');
    });

    await recheck(rendered);

    expect(console.error).toHaveBeenCalledWith(
      'Unexpected failure during auth init; failing closed:',
      expect.anything()
    );
    expectTornDown(seeded);
    expect(rendered.result.current.authState).toEqual<AuthState>({
      ...before,
      ...FAIL_CLOSED_FIELDS,
    });
  });
});

// L370: failClosed. Unreachable from a live session (sessionIsLive skips the
// wipe check), so it starts locked with the vault filled directly, standing in
// for a locked review sitting, and the 60 s cache seeded. The messaging cache
// cannot be filled while the signal is locked, so it is asserted to stay empty.
describe('recheck from a locked state that fails closed on the wipe marker', () => {
  it.each([
    [
      'markerUnreadable',
      () =>
        (
          AccountSecureStorage.readWipeIntentStrict as jest.Mock
        ).mockRejectedValue(new Error('marker unreadable')),
    ],
    [
      'wipeUnfinished',
      () => {
        (
          AccountSecureStorage.readWipeIntentStrict as jest.Mock
        ).mockResolvedValue(true);
        (wipeWalletData as jest.Mock).mockRejectedValue(
          new Error('wipe failed')
        );
      },
    ],
  ])('failClosed_%s_recheckFromLockedState_tearsDown', async (_name, arm) => {
    const rendered = await mount();
    expect(rendered.result.current.authState.isLocked).toBe(true);
    SessionKeyVault.set('fixture-sitting-secret', 'pin');
    const seeded = seedCaches();
    expect(seeded.keyPair).toBeNull();
    const before = rendered.result.current.authState;
    arm();

    await recheck(rendered, true);

    expectTornDown(seeded);
    expect(rendered.result.current.authState).toEqual<AuthState>({
      ...before,
      ...FAIL_CLOSED_FIELDS,
    });
  });
});

// L681: setup-resume, reached from the unlocked no-PIN setup session.
describe('recheck from the unlocked setup session into setup-resume', () => {
  it('setupResume_recheckFromSetupSession_tearsDown', async () => {
    (
      MultiAccountWalletService.hasWalletWithAccountsStrict as jest.Mock
    ).mockResolvedValue(false);
    (AccountSecureStorage.hasPinStrict as jest.Mock).mockResolvedValue(false);
    const rendered = await mount();
    expect(rendered.result.current.authState.isLocked).toBe(false);
    expect(rendered.result.current.authState.isAuthenticated).toBe(true);
    expect(AppLockSignal.isUnlocked()).toBe(true);
    const seeded = seedCaches();
    expect(seeded.keyPair).not.toBeNull();
    const before = rendered.result.current.authState;
    (
      MultiAccountWalletService.hasWalletWithAccountsStrict as jest.Mock
    ).mockResolvedValue(true);
    (
      MultiAccountWalletService.hasKeyBearingAccountStrict as jest.Mock
    ).mockResolvedValue(true);
    (isPinSetupPending as jest.Mock).mockResolvedValue(true);

    await recheck(rendered);

    expectTornDown(seeded);
    expect(rendered.result.current.authState).toEqual<AuthState>({
      ...before,
      isLocked: true,
      isAuthenticated: false,
      securityUnavailable: false,
      authChecked: true,
      pinSetupResume: true,
      hasWallet: true,
      hasPin: false,
      biometricEnabled: false,
      backgroundedAt: null,
    });
  });
});

describe('guards', () => {
  // L714: the unlocked setup verdict must keep its session.
  it('unlockedSetupVerdict_keepsSession', async () => {
    (
      MultiAccountWalletService.hasWalletWithAccountsStrict as jest.Mock
    ).mockResolvedValue(false);
    (AccountSecureStorage.hasPinStrict as jest.Mock).mockResolvedValue(false);
    const rendered = await mount();
    const seeded = seedCaches();
    expect(seeded.keyPair).not.toBeNull();
    const before = rendered.result.current.authState;

    await recheck(rendered);

    expect(probe.renders.every((r) => r.signal)).toBe(true);
    expect(AppLockSignal.isUnlocked()).toBe(true);
    expect(privateKeyCache().size).toBe(1);
    expect(seeded.cachedKey.every((b) => b === 0xaa)).toBe(true);
    expect(getCachedKeyPair(ADDR)).toBe(seeded.keyPair);
    expect(rendered.result.current.authState).toEqual(before);
  });

  // The teardown adds no awaited work and no storage read to boot: the verdict
  // lands in one act() flush with no fake time advanced (so no new timer wait),
  // and each read runs exactly once. act() drains the whole microtask queue, so
  // a finer microtask budget is not observable here.
  it('boot_verdictUnchanged_noExtraReads', async () => {
    const rendered = await renderHook(() => useProbedAuth(), { wrapper });
    await flush(10);

    expect(rendered.result.current.authState).toMatchObject({
      isLocked: true,
      isAuthenticated: false,
      securityUnavailable: false,
      authChecked: true,
      pinSetupResume: false,
      hasWallet: true,
      hasPin: true,
    });
    for (const read of [
      AccountSecureStorage.readWipeIntentStrict,
      AccountSecureStorage.hasPinStrict,
      MultiAccountWalletService.hasWalletWithAccountsStrict,
      MultiAccountWalletService.hasKeyBearingAccountStrict,
      AccountSecureStorage.isBiometricEnabled,
      AccountSecureStorage.getPinTimeout,
    ])
      expect(read).toHaveBeenCalledTimes(1);
    expect(AppLockSignal.isUnlocked()).toBe(false);
    expect(SessionKeyVault.isUnlocked()).toBe(false);
  });

  // A lock listener that throws must not stop the verdict landing, nor cut the
  // teardown short: the recheck resolves, the state and the signal are locked,
  // and the vault and both caches are still cleared. The listener throws once,
  // on the unlocked-to-locked transition. AppLockSignal contains the throw and
  // logs it redacted (TASK-561), so the teardown itself does not fail.
  it('throwingLockListener_stillLandsLocked', async () => {
    const rendered = await mount();
    await unlockLive(rendered);
    const seeded = seedCaches();
    let wasUnlocked = AppLockSignal.isUnlocked();
    let thrown = 0;
    const unsubscribe = AppLockSignal.subscribe(() => {
      const now = AppLockSignal.isUnlocked();
      const transition = wasUnlocked && !now;
      wasUnlocked = now;
      if (transition && thrown === 0) {
        thrown += 1;
        throw new Error('listener failed');
      }
    });
    try {
      await recheck(rendered);
    } finally {
      unsubscribe();
    }

    expect(thrown).toBe(1);
    expect(rendered.result.current.authState).toMatchObject({
      isLocked: true,
      isAuthenticated: false,
      authChecked: true,
    });
    expectTornDown(seeded);
    expect(console.warn).toHaveBeenCalledWith(
      '[AppLockSignal] listener failed',
      'listener failed'
    );
    expect(console.error).not.toHaveBeenCalledWith(
      'Session teardown failed while locking:',
      expect.anything()
    );
    // Nothing logged carries the session secret.
    const logged = JSON.stringify(
      [
        ...(console.error as jest.Mock).mock.calls,
        ...(console.warn as jest.Mock).mock.calls,
      ].map((args) => args.map((a: unknown) => String(a)))
    );
    expect(logged).not.toContain(FIXTURE_PIN);
  });

  // The same for an explicit lock(): a throwing lock listener must not leave
  // the React state unlocked over a torn-down session. AppLockSignal contains
  // the throw and logs it redacted (TASK-561).
  it('throwingLockListener_explicitLock_stillLandsLocked', async () => {
    const rendered = await mount();
    await unlockLive(rendered);
    const seeded = seedCaches();
    let thrown = 0;
    const unsubscribe = AppLockSignal.subscribe(() => {
      if (!AppLockSignal.isUnlocked() && thrown === 0) {
        thrown += 1;
        throw new Error('listener failed');
      }
    });
    probe.renders = [];
    probe.armed = true;
    try {
      await act(async () => {
        rendered.result.current.lock();
      });
      await flush();
    } finally {
      probe.armed = false;
      unsubscribe();
    }

    expect(thrown).toBe(1);
    expect(rendered.result.current.authState).toMatchObject({
      isLocked: true,
      isAuthenticated: false,
    });
    expectTornDown(seeded);
    expect(console.warn).toHaveBeenCalledWith(
      '[AppLockSignal] listener failed',
      'listener failed'
    );
    expect(console.error).not.toHaveBeenCalledWith(
      'Session teardown failed while locking:',
      expect.anything()
    );
  });
});
