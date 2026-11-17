// TASK-504 (DOC-507 5.4, step B): the forgotten-PIN step removes the credential
// and nothing else, in the ruled order, and setupPin clears a stale throttle only
// when it finds no credential. Real AccountSecureStorage; only the platform is in
// memory, with an operation log and fault injection.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const ops: string[] = [];
  const flags = { failAtOp: -1 as number };
  const track = (tag: string) => {
    if (flags.failAtOp >= 0 && ops.length === flags.failAtOp) {
      ops.push(`FAILED ${tag}`);
      flags.failAtOp = -1;
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

import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';
import { AccountType } from '@/types/wallet';
import { restoreAccounts } from '@/services/backup/restorers';
import type { BackupAccountData } from '@/services/backup/types';

const OLD_PIN = '123456';
const NEW_PIN = '654321';
const THROTTLE = 'voi_pin_throttle';
const PIN_ITEM = 'voi_wallet_pin';
const SALT_ITEM = 'voi_wallet_salt';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __ops: string[];
  __flags: { failAtOp: number };
  __reset: () => void;
};

function standard(id: string) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  return {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type: AccountType.STANDARD,
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
    hasBackup: true,
  } as BackupAccountData;
}

const lockoutRecord = () =>
  JSON.stringify({
    failCount: 5,
    lockoutUntil: Date.now() + 60 * 60 * 1000,
    lastFailAt: Date.now(),
  });

/** A reinstall that kept the keychain: PIN credential, a PIN-wrapped orphan, a
 *  device id, a running lockout; app storage (and so the account list) gone. */
async function reinstalledDevice() {
  await restoreAccounts([standard('orphan-1')]);
  await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
  mockPlatform.__secure.set('voi_device_installation_id', 'device-id-bytes');
  mockPlatform.__secure.set(THROTTLE, lockoutRecord());
  mockPlatform.__kv.clear();
  SessionKeyVault.clear();
  mockPlatform.__ops.length = 0;
}

const snapshot = () => new Map(mockPlatform.__secure);

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504 step B: removeCredentialForForgottenPin', () => {
  it('removes the credential items and nothing else: every secret slot, the device id and the other items are byte-identical', async () => {
    await reinstalledDevice();
    const before = snapshot();
    expect(before.has(PIN_ITEM)).toBe(true);

    await AccountSecureStorage.removeCredentialForForgottenPin();

    const after = snapshot();
    const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
    expect(removed).toEqual([PIN_ITEM, THROTTLE].sort());
    for (const [k, v] of before) {
      if (after.has(k)) expect(after.get(k)).toBe(v);
    }
    for (const k of after.keys()) expect(before.has(k)).toBe(true);
    expect(after.get('voi_device_installation_id')).toBe('device-id-bytes');
    expect(after.get('voi_account_secret_orphan-1')).toBe(
      before.get('voi_account_secret_orphan-1')
    );
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
  });

  it('deletes in the ruled order: the credential, then the salt, the throttle record LAST', async () => {
    await reinstalledDevice();
    await AccountSecureStorage.removeCredentialForForgottenPin();
    const dels = mockPlatform.__ops.filter((o) => o.includes(':del:'));
    const at = (needle: string) => dels.findIndex((o) => o.endsWith(needle));
    expect(at(`secure:del:${PIN_ITEM}`)).toBeGreaterThanOrEqual(0);
    expect(at(`secure:del:${PIN_ITEM}`)).toBeLessThan(at(`:del:${SALT_ITEM}`));
    expect(at(`:del:${SALT_ITEM}`)).toBeLessThan(at(`secure:del:${THROTTLE}`));
    expect(dels[dels.length - 1]).toBe(`secure:del:${THROTTLE}`);
  });

  it('a kill after any prefix of the deletes never leaves a credential with its throttle cleared, and a rerun finishes clean', async () => {
    await reinstalledDevice();
    await AccountSecureStorage.removeCredentialForForgottenPin();
    const total = mockPlatform.__ops.length;
    expect(total).toBeGreaterThanOrEqual(3);

    for (let k = 0; k < total; k++) {
      mockPlatform.__reset();
      await reinstalledDevice();
      mockPlatform.__flags.failAtOp = k;
      await expect(
        AccountSecureStorage.removeCredentialForForgottenPin()
      ).rejects.toThrow();
      const hasCredential =
        mockPlatform.__secure.has(PIN_ITEM) || mockPlatform.__kv.has(PIN_ITEM);
      if (hasCredential) {
        expect(mockPlatform.__secure.has(THROTTLE)).toBe(true);
      }
      expect(mockPlatform.__secure.has('voi_account_secret_orphan-1')).toBe(
        true
      );
      // After the credential is fully gone the step is not offered, so a rerun
      // is only owed while a copy remains; either way nothing else changed.
      if (hasCredential) {
        await AccountSecureStorage.removeCredentialForForgottenPin();
        expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
        expect(mockPlatform.__secure.has(THROTTLE)).toBe(false);
      }
    }
  });

  it('refuses when accounts are listed, and when there is no credential: nothing changes', async () => {
    await restoreAccounts([standard('a-1')]);
    await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
    const before = snapshot();
    await expect(
      AccountSecureStorage.removeCredentialForForgottenPin()
    ).rejects.toThrow(/accounts are listed/);
    expect(snapshot()).toEqual(before);

    mockPlatform.__reset();
    await expect(
      AccountSecureStorage.removeCredentialForForgottenPin()
    ).rejects.toThrow(/no PIN to remove/);
  });

  it('a credential read that fails deletes nothing', async () => {
    await reinstalledDevice();
    const before = snapshot();
    jest
      .spyOn(AccountSecureStorage, 'hasPinStrict')
      .mockRejectedValueOnce(new Error('keychain unavailable'));
    await expect(
      AccountSecureStorage.removeCredentialForForgottenPin()
    ).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });
});

describe('TASK-504 step B: setupPin clears a stale throttle only when it finds no credential', () => {
  it('kill between B(1) and B(3), then setupPin: the new PIN is not refused', async () => {
    await reinstalledDevice();
    // Kill right after the credential is gone: the salt delete is the next op.
    const credentialDeletes = 2; // secure + kv copy of PIN_ITEM
    mockPlatform.__flags.failAtOp = credentialDeletes;
    await expect(
      AccountSecureStorage.removeCredentialForForgottenPin()
    ).rejects.toThrow();
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(mockPlatform.__secure.has(THROTTLE)).toBe(true);
    expect(
      (await AccountSecureStorage.getPinThrottleState()).lockedUntil
    ).not.toBeNull();

    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');

    expect(await AccountSecureStorage.verifyPin(NEW_PIN)).toBe(true);
    expect(mockPlatform.__secure.has(THROTTLE)).toBe(false);
  });

  it('a leftover SALT_KEY is replaced by the new commit', async () => {
    await reinstalledDevice();
    mockPlatform.__secure.set(SALT_ITEM, 'stale-salt');
    mockPlatform.__flags.failAtOp = 2;
    await expect(
      AccountSecureStorage.removeCredentialForForgottenPin()
    ).rejects.toThrow();
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');
    expect(mockPlatform.__secure.get(SALT_ITEM)).not.toBe('stale-salt');
    expect(await AccountSecureStorage.verifyPin(NEW_PIN)).toBe(true);
  });

  it('with a credential present, setupPin leaves a running lockout alone', async () => {
    await reinstalledDevice();
    const record = mockPlatform.__secure.get(THROTTLE);
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');
    expect(mockPlatform.__secure.get(THROTTLE)).toBe(record);
  });

  it('a credential read that fails leaves the throttle alone', async () => {
    mockPlatform.__secure.set(THROTTLE, lockoutRecord());
    const record = mockPlatform.__secure.get(THROTTLE);
    jest
      .spyOn(AccountSecureStorage, 'hasPinStrict')
      .mockRejectedValue(new Error('keychain unavailable'));
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin').catch(() => {});
    expect(mockPlatform.__secure.get(THROTTLE)).toBe(record);
  });

  it('the throttle is cleared before the credential is written', async () => {
    mockPlatform.__secure.set(THROTTLE, lockoutRecord());
    mockPlatform.__ops.length = 0;
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');
    const clear = mockPlatform.__ops.indexOf(`secure:del:${THROTTLE}`);
    const write = mockPlatform.__ops.findIndex((o) =>
      o.endsWith(`set:${PIN_ITEM}`)
    );
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(clear);
  });
});
