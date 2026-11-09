// TASK-504 (DOC-507 section 5): the forgotten-PIN step end to end, B then the
// add-only restore, then the real setupPin. Real storage; only the platform is in
// memory, with an operation log.

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
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import {
  performFullRestore,
  planRestore,
  removeOldPinForRestore,
  restoreAccounts,
} from '../restorers';
import type { BackupAccountData } from '../types';

const OLD_PIN = '123456';
const NEW_PIN = '654321';
const PIN_ITEM = 'voi_wallet_pin';
const THROTTLE = 'voi_pin_throttle';
const BREADCRUMB = 'pin_setup_pending';
const ORPHAN_SLOT = 'voi_account_secret_orphan-1';
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
    sk: kp.sk,
  } as BackupAccountData & { sk: Uint8Array };
}

function watch(id: string) {
  const address = algosdk.generateAccount().addr.toString();
  return {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type: AccountType.WATCH,
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
  } as unknown as BackupAccountData;
}

const strip = (a: BackupAccountData & { sk?: Uint8Array }) => {
  const { sk: _sk, ...rest } = a;
  return rest as BackupAccountData;
};

async function reinstalledDevice() {
  const orphan = standard('orphan-1');
  await restoreAccounts([strip(orphan)]);
  await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
  mockPlatform.__secure.set(
    THROTTLE,
    JSON.stringify({
      failCount: 5,
      lockoutUntil: Date.now() + 3_600_000,
      lastFailAt: Date.now(),
    })
  );
  mockPlatform.__kv.clear();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  mockPlatform.__ops.length = 0;
  return orphan;
}

const SETTINGS = {
  theme: {
    mode: 'dark',
    nftThemeEnabled: false,
    selectedPaletteIndex: 0,
    backgroundImageEnabled: false,
    overlayIntensity: 0,
  },
} as never;

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504 forgotten-PIN step: B, then the add-only restore', () => {
  it('first run: the old PIN is gone, the file is fresh (settings taken), the breadcrumb is set after B and before any key write, and the old slot is byte-identical', async () => {
    await reinstalledDevice();
    const orphanBefore = mockPlatform.__secure.get(ORPHAN_SLOT);
    const incoming = standard('file-1');
    const file = [strip(incoming)];

    await removeOldPinForRestore(file);
    const result = await performFullRestore(file, SETTINGS, [], {} as never);

    expect(result.settingsRestored).toBe(true);
    expect(result.records[0].outcome).toBe('added');
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(orphanBefore);
    expect(mockPlatform.__secure.get(THROTTLE)).toBeUndefined();

    const ops = mockPlatform.__ops;
    const pinDeleted = ops.indexOf(`secure:del:${PIN_ITEM}`);
    const breadcrumb = ops.findIndex(
      (o) => o.includes(BREADCRUMB) && o.includes(':set:')
    );
    const firstKeyWrite = ops.findIndex((o) =>
      o.includes(':set:voi_account_secret_')
    );
    expect(pinDeleted).toBeGreaterThanOrEqual(0);
    expect(breadcrumb).toBeGreaterThan(pinDeleted);
    expect(firstKeyWrite).toBeGreaterThan(breadcrumb);
  });

  it('a repeat after a kill between the breadcrumb and the commit is not fresh: accounts only', async () => {
    await reinstalledDevice();
    const file = [strip(standard('file-1'))];
    await removeOldPinForRestore(file);
    mockPlatform.__kv.set(BREADCRUMB, '1');
    mockPlatform.__secure.set(BREADCRUMB, '1');

    const result = await performFullRestore(file, SETTINGS, [], {} as never);

    expect(result.settingsRestored).toBe(false);
  });

  it('refuses a file that adds nothing, and a file with no key: nothing is deleted', async () => {
    await reinstalledDevice();
    const before = new Map(mockPlatform.__secure);

    await expect(removeOldPinForRestore([])).rejects.toThrow(
      /nothing in this backup that can be added/
    );
    await expect(
      removeOldPinForRestore([watch('w-1'), watch('w-2')])
    ).rejects.toThrow(/doesn't hold any account keys/);

    expect(new Map(mockPlatform.__secure)).toEqual(before);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);
  });

  it('refuses when the device already lists accounts: the PIN is not removed', async () => {
    await restoreAccounts([strip(standard('dev-1'))]);
    await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
    const before = new Map(mockPlatform.__secure);

    await expect(
      removeOldPinForRestore([strip(standard('file-1'))])
    ).rejects.toThrow(/already has accounts/);

    expect(new Map(mockPlatform.__secure)).toEqual(before);
  });

  it('B empties the session vault first: a verified old PIN does not carry past it', async () => {
    await reinstalledDevice();
    SessionKeyVault.set(OLD_PIN, 'pin');
    await removeOldPinForRestore([strip(standard('file-1'))]);
    expect(SessionKeyVault.isUnlocked()).toBe(false);
  });

  it('a kill inside B, then a no-PIN restore and the real setupPin: the new PIN is not refused', async () => {
    await reinstalledDevice();
    mockPlatform.__flags.failAtOp = 2; // after the credential copies, before the salt
    await expect(
      removeOldPinForRestore([strip(standard('file-1'))])
    ).rejects.toThrow();
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);

    const file = [strip(standard('file-2'))];
    await performFullRestore(file, SETTINGS, [], {} as never);
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');

    expect(await AccountSecureStorage.verifyPin(NEW_PIN)).toBe(true);
  });

  it('the orphan test through the REAL step: after B, the restore and the real setupPin, the unlisted blob still opens from the old PIN, and the new PIN does not open it', async () => {
    const orphan = await reinstalledDevice();
    const slotBefore = mockPlatform.__secure.get(ORPHAN_SLOT);
    const file = [strip(standard('file-1'))];

    await removeOldPinForRestore(file);
    await performFullRestore(file, SETTINGS, [], {} as never);
    SessionKeyVault.clear();
    await AccountSecureStorage.setupPin(NEW_PIN, 'pin');
    expect(mockPlatform.__secure.get(ORPHAN_SLOT)).toBe(slotBefore);

    // Control: the NEW PIN cannot open the orphan.
    SessionKeyVault.set(NEW_PIN, 'pin');
    AccountSecureStorage.clearPrivateKeyCache();
    await expect(
      AccountSecureStorage.getPrivateKey('orphan-1')
    ).rejects.toBeDefined();

    // The OLD PIN, the device id and the blob open it.
    SessionKeyVault.clear();
    SessionKeyVault.set(OLD_PIN, 'pin');
    AccountSecureStorage.clearPrivateKeyCache();
    const key = await AccountSecureStorage.getPrivateKey('orphan-1');
    expect(Buffer.from(key).equals(Buffer.from(orphan.sk))).toBe(true);
    expect(await MultiAccountWalletService.getCurrentWallet()).toBeTruthy();
  });
});

describe('TASK-504: planRestore, the read-only classification for the consent screen', () => {
  it('counts T, N and the records that carry a key; duplicates of one address are one account', () => {
    const a = strip(standard('a'));
    const dup = { ...a, id: 'a-dup' };
    const invalidSigner = {
      ...watch('s'),
      type: AccountType.REMOTE_SIGNER,
      label: 'Airgap one',
    } as unknown as BackupAccountData;
    const plan = planRestore([a, dup, watch('w'), invalidSigner]);
    expect(plan.total).toBe(3);
    expect(plan.addable).toBe(2);
    expect(plan.addableWithKey).toBe(1);
    expect(plan.notAdded).toEqual([
      expect.objectContaining({ label: 'Airgap one' }),
    ]);
  });

  it('a file of only key-less records has none that carry a key', () => {
    const plan = planRestore([watch('w1'), watch('w2')]);
    expect(plan.addable).toBe(2);
    expect(plan.addableWithKey).toBe(0);
  });
});
