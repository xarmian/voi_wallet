// TASK-504: the backup saves what it can and names what it leaves out. Real
// AccountSecureStorage + wallet service + collectAccounts; only platform
// storage and the fresh-auth gate are faked. Keys are generated in-process.

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

// The fresh-auth gate is a UI prompt; the capability is checked, not issued,
// here. Its failure type is the real one.
const mockConsume = jest.fn();
jest.mock('@/services/secure/freshAuth', () => {
  class FreshAuthError extends Error {}
  return {
    FreshAuthError,
    consumeFreshAuth: (...args: unknown[]) => mockConsume(...args),
  };
});

import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { FreshAuthError } from '@/services/secure/freshAuth';
import { AccountType } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import { collectAccounts } from '../collectors';
import type { BackupAccountData } from '../types';

const PIN = '123456';
const SECRET = 'voi_account_secret_';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};
const CAP = { __brand: 'FreshAuthCapability' } as never;

function standard(id: string, label = id) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  return {
    id,
    address,
    publicKey: Buffer.from(algosdk.decodeAddress(address).publicKey).toString(
      'hex'
    ),
    type: AccountType.STANDARD,
    label,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    mnemonic: algosdk.secretKeyToMnemonic(kp.sk),
    hasBackup: true,
  } as BackupAccountData;
}

function rekeyed(id: string, originalOwner: boolean, withKey: boolean) {
  const base = standard(id);
  return {
    ...base,
    type: AccountType.REKEYED,
    authAddress: algosdk.generateAccount().addr.toString(),
    originalOwner,
    canSign: false,
    mnemonic: withKey ? base.mnemonic : undefined,
  } as BackupAccountData;
}

function keyless(id: string, type: AccountType) {
  const address = algosdk.generateAccount().addr.toString();
  const base = {
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
  };
  if (type === AccountType.LEDGER) {
    return {
      ...base,
      deviceId: 'ledger-1',
      derivationIndex: 0,
      derivationPath: "44'/283'/0'/0/0",
    } as unknown as BackupAccountData;
  }
  if (type === AccountType.REMOTE_SIGNER) {
    return {
      ...base,
      signerDeviceId: 'signer-1',
      pairedAt: new Date().toISOString(),
    } as unknown as BackupAccountData;
  }
  return base as unknown as BackupAccountData;
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
  mockConsume.mockReset();
});

describe('TASK-504: collectAccounts saves what it can and names what it leaves out', () => {
  it('Dave shape: a keyless rekeyed entry among others writes every other key, and names the one left out', async () => {
    const a = standard('std-a');
    const b = standard('std-b');
    const lost = rekeyed('rk-lost', true, true);
    const w = keyless('watch-1', AccountType.WATCH);
    const l = keyless('ledger-1', AccountType.LEDGER);
    const s = keyless('signer-1', AccountType.REMOTE_SIGNER);
    await restoreAccounts([a, lost, b, w, l, s]);
    // The retained key of the rekeyed entry is gone from this device.
    mockPlatform.__secure.delete(`${SECRET}rk-lost`);

    const collected = await collectAccounts(CAP);

    expect(collected.total).toBe(6);
    expect(collected.accounts.map((x) => x.id)).toEqual([
      'std-a',
      'rk-lost',
      'std-b',
      'watch-1',
      'ledger-1',
      'signer-1',
    ]);
    expect(collected.accounts.find((x) => x.id === 'std-a')?.mnemonic).toBe(
      a.mnemonic
    );
    expect(collected.accounts.find((x) => x.id === 'std-b')?.mnemonic).toBe(
      b.mnemonic
    );
    // Its metadata still goes in the file, without a key.
    expect(
      collected.accounts.find((x) => x.id === 'rk-lost')?.mnemonic
    ).toBeUndefined();
    expect(collected.leftOut).toEqual([
      {
        address: lost.address,
        label: 'rk-lost',
        reason: 'no-key-on-device',
      },
    ]);
  });

  it('a key-less account never makes a file incomplete: watch, Ledger, Airgap, and a rekeyed entry that never owned a key', async () => {
    await restoreAccounts([
      keyless('w', AccountType.WATCH),
      keyless('l', AccountType.LEDGER),
      keyless('s', AccountType.REMOTE_SIGNER),
      rekeyed('rk-foreign', false, false),
    ]);
    const collected = await collectAccounts(CAP);
    expect(collected.accounts).toHaveLength(4);
    expect(collected.leftOut).toEqual([]);
  });

  it('a standard account whose key cannot be read is left out as a possible key problem, never quietly skipped, and the rest are saved', async () => {
    const ok = standard('ok');
    const corrupt = standard('corrupt');
    const other = standard('other');
    const empty = standard('empty');
    await restoreAccounts([ok, corrupt, other, empty]);
    mockPlatform.__secure.set(`${SECRET}corrupt`, 'not json');
    mockPlatform.__secure.set(
      `${SECRET}other`,
      mockPlatform.__secure.get(`${SECRET}ok`)!
    );
    mockPlatform.__secure.delete(`${SECRET}empty`);
    const reveal = jest.spyOn(SecureKeyManager, 'revealMnemonicForRecord');

    const collected = await collectAccounts(CAP);

    // Only the record whose slot proved readable is ever revealed.
    expect(reveal).toHaveBeenCalledTimes(1);
    // Every account is in the file; the three without a key carry the flag and
    // no phrase (TASK-504, product e7912207).
    expect(collected.accounts.map((x) => x.id)).toEqual([
      'ok',
      'corrupt',
      'other',
      'empty',
    ]);
    expect(collected.accounts.map((x) => !!x.withoutKey)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(
      collected.accounts.filter((x) => x.withoutKey).every((x) => !x.mnemonic)
    ).toBe(true);
    expect(collected.leftOut.map((x) => [x.label, x.reason])).toEqual([
      ['corrupt', 'key-unreadable'],
      ['other', 'key-unreadable'],
      ['empty', 'key-unreadable'],
    ]);
    // Address and label only: no key material in the list.
    expect(JSON.stringify(collected.leftOut)).not.toContain(ok.mnemonic);
    expect(JSON.stringify(collected.leftOut)).not.toContain(corrupt.mnemonic);
  });

  it('with duplicate entries for one address, each record is read under its own id', async () => {
    const a = standard('dup-a');
    await restoreAccounts([a]);
    const blob = JSON.parse(mockPlatform.__kv.get('voi_wallet_metadata')!);
    blob.accounts.push({ ...blob.accounts[0], id: 'dup-b', label: 'dup-b' });
    mockPlatform.__kv.set('voi_wallet_metadata', JSON.stringify(blob));
    // dup-b has no key of its own; dup-a does.
    const reveal = jest.spyOn(SecureKeyManager, 'revealMnemonicForRecord');

    const collected = await collectAccounts(CAP);

    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'dup-a' }),
      CAP,
      'export_backup'
    );
    expect(collected.accounts.map((x) => x.id)).toEqual(['dup-a']);
    // dup-a exported its key at this address, so dup-b's empty slot is not a
    // second account: not listed, not written (dev lead 89d3f459).
    expect(collected.leftOut).toEqual([]);
  });

  it('a locked vault on a PIN device stops the backup: no key is read and no file would be written', async () => {
    await restoreAccounts([standard('p-1')]);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.clear();
    const reveal = jest.spyOn(SecureKeyManager, 'revealMnemonicForRecord');

    await expect(collectAccounts(CAP)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
    expect(reveal).not.toHaveBeenCalled();
  });

  it('a vault that locks after the first record stops the backup instead of listing every later key as unreadable', async () => {
    await restoreAccounts([standard('p-1'), standard('p-2')]);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.set(PIN, 'pin');
    const original =
      SecureKeyManager.revealMnemonicForRecord.bind(SecureKeyManager);
    jest
      .spyOn(SecureKeyManager, 'revealMnemonicForRecord')
      .mockImplementationOnce(async (...args) => {
        const phrase = await original(...args);
        SessionKeyVault.clear();
        return phrase;
      });

    await expect(collectAccounts(CAP)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('a key read that fails because the vault locked stops the backup, even when it is the only record', async () => {
    await restoreAccounts([standard('p-1')]);
    await AccountSecureStorage.setupPin(PIN, 'pin');
    SessionKeyVault.set(PIN, 'pin');
    jest
      .spyOn(SecureKeyManager, 'revealMnemonicForRecord')
      .mockImplementationOnce(async () => {
        SessionKeyVault.clear();
        throw new Error('vault locked');
      });

    await expect(collectAccounts(CAP)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('a slot read that throws is a key the wallet cannot read: left out and named, for an expected key and an unexpected one alike', async () => {
    await restoreAccounts([standard('r-1'), rekeyed('r-2', false, false)]);
    jest
      .spyOn(AccountSecureStorage, 'inspectSecretSlot')
      .mockRejectedValue(new Error('keychain read failed'));

    const collected = await collectAccounts(CAP);

    // Both are in the file, without keys; nothing was exported.
    expect(
      collected.accounts.map((x) => [x.id, !!x.withoutKey, !!x.mnemonic])
    ).toEqual([
      ['r-1', true, false],
      ['r-2', true, false],
    ]);
    expect(collected.leftOut.map((x) => [x.label, x.reason])).toEqual([
      ['r-1', 'key-unreadable'],
      ['r-2', 'key-unreadable'],
    ]);
  });

  it('an unusable fresh-auth capability stops the backup; it is not a key problem', async () => {
    await restoreAccounts([standard('f-1')]);
    mockConsume.mockImplementation(() => {
      throw new FreshAuthError('failed');
    });

    await expect(collectAccounts(CAP)).rejects.toMatchObject({
      code: 'AUTHENTICATION_REQUIRED',
    });
  });

  it('an empty wallet collects nothing', async () => {
    expect(await collectAccounts(CAP)).toEqual({
      accounts: [],
      leftOut: [],
      total: 0,
    });
  });
});
