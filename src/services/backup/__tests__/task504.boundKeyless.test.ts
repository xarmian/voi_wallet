// TASK-504 4.1 item 9 (DOC-507): the one exception to "a key-less record never
// binds to an occupied slot". Real storage; only the platform is in memory.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  return {
    __secure: secure,
    __kv: kv,
    __reset: () => {
      secure.clear();
      kv.clear();
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
        secure.set(k, v);
      },
      deleteItem: async (k: string) => {
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      setItem: async (k: string, v: string) => {
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
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
import { restoreAccounts } from '../restorers';
import type { BackupAccountData } from '../types';

const PIN = '123456';
const SLOT = 'voi_account_secret_orphan-1';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
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

/** A key-less rekeyed record: the file's no-key-on-device entry. */
function keylessRekeyed(id: string, address: string, publicKey: string) {
  return {
    id,
    address,
    publicKey,
    type: AccountType.REKEYED,
    label: 'rekeyed',
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    authAddress: algosdk.generateAccount().addr.toString(),
    originalOwner: true,
    canSign: false,
  } as unknown as BackupAccountData;
}

/** After a reinstall with the PIN credential kept: a PIN-wrapped orphan under
 *  orphan-1, no account list, and the vault filled as by a verified old PIN. */
async function oldPinDevice() {
  const orphan = standard('orphan-1');
  await restoreAccounts([orphan]);
  await AccountSecureStorage.setupPin(PIN, 'pin');
  mockPlatform.__kv.clear();
  SessionKeyVault.set(PIN, 'pin');
  AccountSecureStorage.clearPrivateKeyCache();
  return orphan;
}

async function ids(): Promise<string[]> {
  const wallet = await MultiAccountWalletService.getCurrentWallet();
  return (wallet?.accounts ?? []).map((a) => a.id);
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
});

describe('TASK-504 4.1 item 9: a key-less rekeyed record binds to its own surviving key on the old-PIN screen', () => {
  it('bound: listed under its own id, the slot byte-identical, a key read succeeds with the vault filled', async () => {
    const orphan = await oldPinDevice();
    const slotBefore = mockPlatform.__secure.get(SLOT);
    const epoch = SessionKeyVault.currentEpoch();

    const result = await restoreAccounts(
      [keylessRekeyed('orphan-1', orphan.address, orphan.publicKey)],
      { oldPinSession: { epoch } }
    );

    expect(result.records[0].outcome).toBe('added-in-place');
    expect(result.records[0].storedId).toBeUndefined();
    expect(await ids()).toEqual(['orphan-1']);
    expect(mockPlatform.__secure.get(SLOT)).toBe(slotBefore);
    const key = await AccountSecureStorage.getPrivateKey('orphan-1');
    expect(Buffer.from(key.slice(32)).toString('hex')).toBe(orphan.publicKey);
  });

  it('bound: only metadata is written, never a secret slot', async () => {
    const orphan = await oldPinDevice();
    const saveSecret = jest.spyOn(
      AccountSecureStorage as unknown as {
        saveSecret: (...a: unknown[]) => Promise<void>;
      },
      'saveSecret'
    );
    await restoreAccounts(
      [keylessRekeyed('orphan-1', orphan.address, orphan.publicKey)],
      { oldPinSession: { epoch: SessionKeyVault.currentEpoch() } }
    );
    expect(saveSecret).not.toHaveBeenCalled();
  });

  it('refused: the key derives to another address: a fresh id, the slot untouched', async () => {
    const orphan = await oldPinDevice();
    const other = standard('x');
    const slotBefore = mockPlatform.__secure.get(SLOT);

    const result = await restoreAccounts(
      [keylessRekeyed('orphan-1', other.address, other.publicKey)],
      { oldPinSession: { epoch: SessionKeyVault.currentEpoch() } }
    );

    expect(result.records[0].outcome).toBe('added-new-id');
    expect(await ids()).not.toContain('orphan-1');
    expect(mockPlatform.__secure.get(SLOT)).toBe(slotBefore);
    expect(orphan.address).not.toBe(other.address);
  });

  it('refused: the vault epoch moved since the verify: the restore stops at the record, nothing written', async () => {
    const orphan = await oldPinDevice();
    const epoch = SessionKeyVault.currentEpoch();
    SessionKeyVault.set(PIN, 'pin'); // another unlock: a new epoch
    const before = [...mockPlatform.__secure.entries()].sort();

    await expect(
      restoreAccounts(
        [keylessRekeyed('orphan-1', orphan.address, orphan.publicKey)],
        { oldPinSession: { epoch } }
      )
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });

    expect([...mockPlatform.__secure.entries()].sort()).toEqual(before);
    expect(await ids()).toEqual([]);
  });

  it('refused: the vault cleared before the write: the same stop', async () => {
    const orphan = await oldPinDevice();
    const epoch = SessionKeyVault.currentEpoch();
    SessionKeyVault.clear();

    await expect(
      restoreAccounts(
        [keylessRekeyed('orphan-1', orphan.address, orphan.publicKey)],
        { oldPinSession: { epoch } }
      )
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_REQUIRED' });
  });

  it('refused: no old-PIN session (an unlocked wallet with accounts, or the no-PIN path): a fresh id', async () => {
    const orphan = await oldPinDevice();
    const result = await restoreAccounts([
      keylessRekeyed('orphan-1', orphan.address, orphan.publicKey),
    ]);
    expect(result.records[0].outcome).toBe('added-new-id');
    expect(await ids()).not.toContain('orphan-1');
  });

  it('refused: no credential any more (after the forgotten-PIN step): a fresh id', async () => {
    const orphan = await oldPinDevice();
    mockPlatform.__secure.delete('voi_wallet_pin');
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    const result = await restoreAccounts(
      [keylessRekeyed('orphan-1', orphan.address, orphan.publicKey)],
      { oldPinSession: { epoch: SessionKeyVault.currentEpoch() } }
    );
    expect(result.records[0].outcome).toBe('added-new-id');
    expect(await ids()).not.toContain('orphan-1');
  });

  it('refused: only a rekeyed record binds; a watch record over the same slot gets a fresh id', async () => {
    const orphan = await oldPinDevice();
    const watch = {
      id: 'orphan-1',
      address: orphan.address,
      publicKey: orphan.publicKey,
      type: AccountType.WATCH,
      label: 'watch',
      color: '#000000',
      isHidden: false,
      createdAt: new Date().toISOString(),
    } as unknown as BackupAccountData;
    const result = await restoreAccounts([watch], {
      oldPinSession: { epoch: SessionKeyVault.currentEpoch() },
    });
    expect(result.records[0].outcome).toBe('added-new-id');
  });

  it('refused at the storage layer too: a non-rekeyed record handed a bind still gets a fresh id', async () => {
    const orphan = await oldPinDevice();
    const watch = {
      id: 'orphan-1',
      address: orphan.address,
      publicKey: orphan.publicKey,
      type: AccountType.WATCH,
      label: 'watch',
      color: '#000000',
      isHidden: false,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
    } as never;
    const stored = await AccountSecureStorage.storeKeylessAccountForRestore(
      watch,
      AccountSecureStorage.getResetGeneration(),
      'restore',
      { epoch: SessionKeyVault.currentEpoch() }
    );
    expect(stored.reassigned).toBe(true);
    expect(stored.bound).toBeUndefined();
    expect(stored.id).not.toBe('orphan-1');
  });
});
