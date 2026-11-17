// TASK-504 DOC-507 5.4 route fault tests (dev lead d6ca72b9, handoff item 4).
// For each kill point of the forgotten-PIN step, the state on disk is built by
// the REAL step code (removeOldPinForRestore, the breadcrumb, restoreAccounts,
// setupPin), the process "dies" (memory cleared, storage kept), and the REAL
// AuthProvider boots over that storage. The route asserted is the one
// AppNavigator derives from the real checkInitialAuthState verdict. Real
// AccountSecureStorage, wallet service, boot reconcile and breadcrumb; only
// the platform is in memory (with an operation log and fault injection) and
// the screens' collaborators (wipe, teardown, deep links) are inert.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const ops: string[] = [];
  const flags = {
    failAtOp: -1 as number,
    failOnTag: null as string | null,
  };
  const track = (tag: string) => {
    if (flags.failAtOp >= 0 && ops.length === flags.failAtOp) {
      ops.push(`FAILED ${tag}`);
      flags.failAtOp = -1;
      throw new Error('killed');
    }
    if (flags.failOnTag !== null && tag === flags.failOnTag) {
      ops.push(`FAILED ${tag}`);
      flags.failOnTag = null;
      throw new Error('killed');
    }
    ops.push(tag);
  };
  return {
    __secure: secure,
    __kv: kv,
    __ops: ops,
    __flags: flags,
    __reset: () => {
      secure.clear();
      kv.clear();
      ops.length = 0;
      flags.failAtOp = -1;
      flags.failOnTag = null;
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: async (k: string) => (secure.has(k) ? secure.get(k)! : null),
      setItem: async (k: string, v: string) => {
        track(`secure:set:${k}`);
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        track(`secure:del:${k}`);
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      setItem: async (k: string, v: string) => {
        track(`kv:set:${k}`);
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        track(`kv:del:${k}`);
        kv.delete(k);
      },
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: { getDeviceId: async () => 'task504-device-idfv' },
  };
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    multiSet: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));

jest.mock('@/store/walletStore', () => ({
  removePersistedBalanceCaches: jest.fn(async () => {}),
}));

// Inert collaborators of the provider: none of them is on the boot verdict path.
jest.mock('@/services/wipe', () => ({
  wipeWalletData: jest.fn(async () => {}),
  isWipeInFlight: jest.fn(() => false),
}));
jest.mock('@/services/wipe/notices', () => ({
  showWipeCompleteNotice: jest.fn(),
}));
jest.mock('@/services/secure/biometricUnlock', () => ({
  unlockVaultWithBiometrics: jest.fn(),
}));
jest.mock('@/services/secure/sessionTeardown', () => ({
  enterLockedState: jest.fn(),
}));
jest.mock('@/services/secure/appLockState', () => ({
  AppLockSignal: {
    setUnlocked: jest.fn(),
    isUnlocked: jest.fn(() => true),
    subscribe: jest.fn(() => () => {}),
  },
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
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
}));

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react-native';
import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AuthProvider, useAuth } from '../AuthContext';
import type { AuthState } from '../AuthContext';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import {
  markPinSetupPending,
  readPinSetupPendingStrict,
} from '@/services/secure/pinSetupPending';
import {
  removeOldPinForRestore,
  restoreAccounts,
} from '@/services/backup/restorers';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import type { BackupAccountData } from '@/services/backup/types';

jest.setTimeout(120000);

const OLD_PIN = '123456';
const NEW_PIN = '654321';
const PIN_ITEM = 'voi_wallet_pin';
const SALT_ITEM = 'voi_wallet_salt';
const THROTTLE = 'voi_pin_throttle';
const DEVICE_ID = 'voi_device_installation_id';
const ORPHAN_SLOT = 'voi_account_secret_orphan-1';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __ops: string[];
  __flags: { failAtOp: number; failOnTag: string | null };
  __reset: () => void;
};

// ── The route, as AppNavigator.tsx derives it (initialRoute, ~1167) ─────────
type Route = 'Recovery' | 'SecuritySetup' | 'Main' | 'Onboarding';
function routeOf(s: AuthState): Route {
  if (s.securityUnavailable) return 'Recovery';
  if (s.pinSetupResume) return 'SecuritySetup';
  return s.hasWallet ? 'Main' : 'Onboarding';
}

/** Cold boot: a fresh provider over whatever storage holds. */
async function boot(): Promise<AuthState> {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <AuthProvider>{children}</AuthProvider>
  );
  // renderHook is async in this RNTL version.
  const rendered = await renderHook(() => useAuth(), { wrapper });
  await waitFor(
    () => expect(rendered.result.current.authState.authChecked).toBe(true),
    { timeout: 60000 }
  );
  const state = rendered.result.current.authState;
  rendered.unmount();
  return state;
}

/** The process dies: memory goes, storage stays. */
function die() {
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  mockPlatform.__flags.failAtOp = -1;
  mockPlatform.__flags.failOnTag = null;
}

// ── Files and records ───────────────────────────────────────────────────────
function base(id: string, type: AccountType) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  return {
    kp,
    record: {
      id,
      address,
      publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
        'hex'
      ),
      type,
      label: id,
      color: '#000000',
      isHidden: false,
      createdAt: new Date().toISOString(),
    },
  };
}

function standard(id: string): BackupAccountData {
  const { kp, record } = base(id, AccountType.STANDARD);
  return {
    ...record,
    mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
    hasBackup: true,
  } as unknown as BackupAccountData;
}

function rekeyedWithPhrase(id: string): BackupAccountData {
  const { kp, record } = base(id, AccountType.REKEYED);
  return {
    ...record,
    mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
    authAddress: algosdk.generateAccount().addr.toString(),
    originalOwner: true,
    canSign: false,
    hasBackup: true,
  } as unknown as BackupAccountData;
}

function rekeyedNoPhrase(id: string): BackupAccountData {
  const { record } = base(id, AccountType.REKEYED);
  return {
    ...record,
    authAddress: algosdk.generateAccount().addr.toString(),
    originalOwner: false,
    canSign: false,
  } as unknown as BackupAccountData;
}

function watch(id: string): BackupAccountData {
  return base(id, AccountType.WATCH).record as unknown as BackupAccountData;
}

function ledger(id: string): BackupAccountData {
  return {
    ...base(id, AccountType.LEDGER).record,
    deviceId: 'ledger-device',
    derivationIndex: 0,
    ledgerDerivationPath: "44'/283'/0'/0/0",
  } as unknown as BackupAccountData;
}

function remoteSigner(id: string): BackupAccountData {
  return {
    ...base(id, AccountType.REMOTE_SIGNER).record,
    signerDeviceId: 'signer-device',
    pairedAt: new Date().toISOString(),
  } as unknown as BackupAccountData;
}

/** A file the step accepts: it adds a record and one of them carries a key. */
const stepFile = (): BackupAccountData[] => [standard('file-1')];

const lockoutRecord = () =>
  JSON.stringify({
    failCount: 5,
    lockoutUntil: Date.now() + 60 * 60 * 1000,
    lastFailAt: Date.now(),
  });

/** A reinstall that kept the keychain: the PIN credential (and a legacy copy of
 *  it), a PIN-wrapped orphan, a device id, a running lockout; app storage (and
 *  so the account list) gone. */
async function reinstalledDevice() {
  await restoreAccounts([standard('orphan-1')]);
  await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
  mockPlatform.__secure.set(DEVICE_ID, 'device-id-bytes');
  mockPlatform.__secure.set(THROTTLE, lockoutRecord());
  const credential = mockPlatform.__secure.get(PIN_ITEM)!;
  mockPlatform.__kv.clear();
  mockPlatform.__kv.set(PIN_ITEM, credential); // the legacy storage copy
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  mockPlatform.__ops.length = 0;
}

const secureSnapshot = () => new Map(mockPlatform.__secure);

function expectOrphanAndDeviceIdIntact(before: Map<string, string>) {
  expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(before.get(ORPHAN_SLOT));
  expect(typeof before.get(ORPHAN_SLOT)).toBe('string');
  expect(mockPlatform.__secure.get(DEVICE_ID)).toBe('device-id-bytes');
}

/** Step B, killed after the first `ops` storage operations (0: not started). */
async function stepBKilledAfter(ops: number) {
  mockPlatform.__flags.failAtOp = mockPlatform.__ops.length + ops;
  await expect(removeOldPinForRestore(stepFile())).rejects.toThrow();
  die();
}

async function stepBComplete() {
  await removeOldPinForRestore(stepFile());
  die();
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504 5.4 route table: the early states re-enter restore', () => {
  it('after A (nothing written): Onboarding, the PIN still on the device, every secret byte-identical', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();

    const state = await boot();

    expect(routeOf(state)).toBe('Onboarding');
    expect(state).toMatchObject({
      isLocked: false,
      hasWallet: false,
      hasPin: true,
      pinSetupResume: false,
      securityUnavailable: false,
    });
    expect(secureSnapshot()).toEqual(before);
  });

  it('kill between the two copies of the PIN credential inside B(1): the device still reads as a PIN device and B reruns clean', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBKilledAfter(1); // the secure copy deleted, the legacy copy left
    expect(mockPlatform.__secure.has(PIN_ITEM)).toBe(false);
    expect(mockPlatform.__kv.has(PIN_ITEM)).toBe(true);

    const state = await boot();

    expect(routeOf(state)).toBe('Onboarding');
    expect(state.hasPin).toBe(true);
    expect(state.hasWallet).toBe(false);
    expect(mockPlatform.__secure.get(THROTTLE)).toBe(before.get(THROTTLE));

    // The step is offered again and finishes clean.
    await removeOldPinForRestore(stepFile());
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(mockPlatform.__secure.has(THROTTLE)).toBe(false);
    expectOrphanAndDeviceIdIntact(before);
  });

  it('kill between B(1) and B(2): no PIN on the device, Onboarding as a no-PIN device, the stale salt and throttle left, orphan and device id intact', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBKilledAfter(2); // both PIN copies gone, the salt next

    const state = await boot();

    expect(routeOf(state)).toBe('Onboarding');
    expect(state).toMatchObject({
      isLocked: false,
      hasWallet: false,
      hasPin: false,
      pinSetupResume: false,
      securityUnavailable: false,
    });
    expect(mockPlatform.__secure.get(THROTTLE)).toBe(before.get(THROTTLE));
    expectOrphanAndDeviceIdIntact(before);
  });

  it('kill inside B(2), between the salt copies: the same route, hasPin no', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBKilledAfter(3); // the secure salt deleted, the legacy salt next

    const state = await boot();

    expect(routeOf(state)).toBe('Onboarding');
    expect(state.hasPin).toBe(false);
    expect(mockPlatform.__secure.get(THROTTLE)).toBe(before.get(THROTTLE));
    expectOrphanAndDeviceIdIntact(before);
  });

  it('kill between B(2) and B(3): the same route, the throttle record still there', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBKilledAfter(4); // both salt copies gone, the throttle next

    const state = await boot();

    expect(routeOf(state)).toBe('Onboarding');
    expect(state.hasPin).toBe(false);
    expect(mockPlatform.__secure.has(SALT_ITEM)).toBe(false);
    expect(mockPlatform.__secure.get(THROTTLE)).toBe(before.get(THROTTLE));
    expectOrphanAndDeviceIdIntact(before);
  });

  it('after B(3), before the breadcrumb: Onboarding, the throttle gone, orphan and device id intact', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBComplete();

    const state = await boot();

    expect(routeOf(state)).toBe('Onboarding');
    expect(state).toMatchObject({ hasWallet: false, hasPin: false });
    expect(mockPlatform.__secure.has(THROTTLE)).toBe(false);
    expect(await readPinSetupPendingStrict()).toBe(false);
    expectOrphanAndDeviceIdIntact(before);
  });

  it('after the breadcrumb, before any key write: Onboarding; the breadcrumb stays and is not read', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBComplete();
    await markPinSetupPending();
    die();

    const state = await boot();

    expect(routeOf(state)).toBe('Onboarding');
    expect(state.pinSetupResume).toBe(false);
    expect(state.hasPin).toBe(false);
    expect(await readPinSetupPendingStrict()).toBe(true);
    expectOrphanAndDeviceIdIntact(before);
  });
});

describe('TASK-504 5.4 route table: during C and after the blob commit', () => {
  it('between records in C (the first record written and journaled, no wallet blob): Onboarding; boot reconcile keeps the old orphan byte-identical; restoring again completes', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBComplete();
    await markPinSetupPending();
    const [first, second] = [standard('file-1'), standard('file-2')];
    const gen = AccountSecureStorage.getResetGeneration();
    const written = await AccountSecureStorage.storeAccountForRestore(
      { ...first, mnemonic: '', lastUsed: new Date().toISOString() } as never,
      algosdk.mnemonicToSecretKey(first.mnemonic!).sk,
      gen
    );
    expect(written.kind).toBe('written');
    die();

    const state = await boot();

    expect(routeOf(state)).toBe('Onboarding');
    expect(state).toMatchObject({ hasWallet: false, hasPin: false });
    expect(state.pinSetupResume).toBe(false);
    expect(await readPinSetupPendingStrict()).toBe(true);
    expectOrphanAndDeviceIdIntact(before);

    // Restore again (the Re-run column): both records end up listed.
    const result = await restoreAccounts([first, second]);
    expect(result.records.map((r) => r.outcome).sort()).toEqual(
      expect.arrayContaining(['added'])
    );
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    expect((wallet?.accounts ?? []).length).toBe(2);
    expectOrphanAndDeviceIdIntact(before);
  });

  it('after the blob commit, before the PIN: SecuritySetup (pinSetupResume), the ONLY state the breadcrumb routes', async () => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBComplete();
    await markPinSetupPending();
    await restoreAccounts(stepFile());
    die();

    const state = await boot();

    expect(routeOf(state)).toBe('SecuritySetup');
    expect(state).toMatchObject({
      pinSetupResume: true,
      hasWallet: true,
      hasPin: false,
      isLocked: true,
      isAuthenticated: false,
      securityUnavailable: false,
    });
    expect(await readPinSetupPendingStrict()).toBe(true);
    expectOrphanAndDeviceIdIntact(before);
  });

  it('kill during setupPin, after its confirmed breadcrumb clear and before the credential write: the recovery screen (the stated residual)', async () => {
    await reinstalledDevice();
    await stepBComplete();
    await markPinSetupPending();
    await restoreAccounts(stepFile());
    die();
    mockPlatform.__flags.failOnTag = `secure:set:${PIN_ITEM}`;
    await expect(
      AccountSecureStorage.setupPin(NEW_PIN, 'pin')
    ).rejects.toThrow();
    die();
    expect(await readPinSetupPendingStrict()).toBe(false);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);

    const state = await boot();

    expect(routeOf(state)).toBe('Recovery');
    expect(state).toMatchObject({
      securityUnavailable: true,
      pinSetupResume: false,
      isLocked: true,
      isAuthenticated: false,
    });
  });

  it('after D (setupPin completed): Main, locked, the breadcrumb cleared', async () => {
    await reinstalledDevice();
    await stepBComplete();
    await markPinSetupPending();
    await restoreAccounts(stepFile());
    die();
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');
    die();

    const state = await boot();

    expect(routeOf(state)).toBe('Main');
    expect(state).toMatchObject({
      isLocked: true,
      isAuthenticated: false,
      hasWallet: true,
      hasPin: true,
      pinSetupResume: false,
      securityUnavailable: false,
    });
    expect(await readPinSetupPendingStrict()).toBe(false);
  });
});

describe('TASK-504 5.4 route table: after B, a stale salt and throttle do not outlive the new PIN', () => {
  it('kill inside B(2), restore, setupPin: the stale salt is overwritten and the new PIN is not refused', async () => {
    await reinstalledDevice();
    const staleSalt = mockPlatform.__secure.get(SALT_ITEM);
    await stepBKilledAfter(2); // PIN gone; the salt and the lockout left
    expect(mockPlatform.__secure.get(THROTTLE)).toBeDefined();

    await restoreAccounts(stepFile());
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');
    die();

    const newSalt = mockPlatform.__secure.get(SALT_ITEM);
    if (staleSalt !== undefined) expect(newSalt).not.toBe(staleSalt);
    expect(await AccountSecureStorage.verifyPin(NEW_PIN)).toBe(true);
    expect(mockPlatform.__secure.has(THROTTLE)).toBe(false);
  });
});

describe('TASK-504 5.4 route by what the file restores (after B and the blob commit)', () => {
  type Case = {
    name: string;
    file: () => BackupAccountData[];
    route: Route;
    resume: boolean;
    hasPin: boolean;
    locked: boolean;
  };
  const KEY_BEARING = {
    route: 'SecuritySetup' as Route,
    resume: true,
    hasPin: false,
    locked: true,
  };
  // Without a key to protect the boot is `!hasPin` with a wallet: unlocked, Main.
  const NO_KEY = {
    route: 'Main' as Route,
    resume: false,
    hasPin: false,
    locked: false,
  };
  const CASES: Case[] = [
    {
      name: 'a STANDARD record',
      file: () => [standard('f-1')],
      ...KEY_BEARING,
    },
    {
      name: 'a REKEYED record WITH a retained key (the phrase in the file)',
      file: () => [rekeyedWithPhrase('f-1')],
      ...KEY_BEARING,
    },
    {
      name: 'several REKEYED records with retained keys and no STANDARD',
      file: () => [rekeyedWithPhrase('f-1'), rekeyedWithPhrase('f-2')],
      ...KEY_BEARING,
    },
    {
      name: 'a REKEYED record WITHOUT a key (no phrase), no slot found',
      file: () => [rekeyedNoPhrase('f-1')],
      ...NO_KEY,
    },
    {
      name: 'only WATCH, LEDGER, REMOTE_SIGNER and key-less REKEYED records',
      file: () => [
        watch('w-1'),
        ledger('l-1'),
        remoteSigner('r-1'),
        rekeyedNoPhrase('k-1'),
      ],
      ...NO_KEY,
    },
  ];

  it.each(CASES)('$name', async ({ file, route, resume, hasPin, locked }) => {
    await reinstalledDevice();
    const before = secureSnapshot();
    await stepBComplete();
    await markPinSetupPending();
    // The step only runs on a file with a key; here the file under test is
    // restored directly after B to read the route its records give.
    await restoreAccounts(file());
    die();

    const state = await boot();

    expect(routeOf(state)).toBe(route);
    expect(state.pinSetupResume).toBe(resume);
    expect(state.hasPin).toBe(hasPin);
    expect(state.isLocked).toBe(locked);
    expect(state.hasWallet).toBe(true);
    expect(state.securityUnavailable).toBe(false);
    expectOrphanAndDeviceIdIntact(before);
  });
});
