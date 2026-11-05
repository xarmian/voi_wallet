// TASK-504 (product e7912207, db99d45f, dev lead ef933e70, 89d3f459): every
// account goes in the file. An account whose key the file lacks is a record of
// its real type with no phrase and a without-key flag; the list names it. Real
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
import { AccountType } from '@/types/wallet';
import { restoreAccounts } from '../restorers';
import { collectAccounts } from '../collectors';
import type { BackupAccountData } from '../types';

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

async function addDuplicateRecord(fromId: string, newId: string) {
  const blob = JSON.parse(mockPlatform.__kv.get('voi_wallet_metadata')!);
  const src = blob.accounts.find((a: { id: string }) => a.id === fromId);
  blob.accounts.push({ ...src, id: newId, label: newId });
  mockPlatform.__kv.set('voi_wallet_metadata', JSON.stringify(blob));
}

describe('TASK-504: every account goes in the file', () => {
  it('a standard account whose key cannot be read is a record of its real type, no phrase, flagged; the list names it; the others carry their keys', async () => {
    const ok = standard('ok');
    const corrupt = standard('corrupt');
    await restoreAccounts([ok, corrupt]);
    mockPlatform.__secure.set(`${SECRET}corrupt`, 'not json');

    const c = await collectAccounts(CAP);

    expect(c.accounts.map((x) => x.id)).toEqual(['ok', 'corrupt']);
    const flagged = c.accounts.find((x) => x.id === 'corrupt')!;
    expect(flagged.type).toBe(AccountType.STANDARD);
    expect(flagged.address).toBe(corrupt.address);
    expect(flagged.mnemonic).toBeUndefined();
    expect(flagged.withoutKey).toBe(true);
    const keyed = c.accounts.find((x) => x.id === 'ok')!;
    expect(keyed.mnemonic).toBe(ok.mnemonic);
    expect(keyed.withoutKey).toBeUndefined();
    expect(c.leftOut).toEqual([
      { address: corrupt.address, label: 'corrupt', reason: 'key-unreadable' },
    ]);
    // Nothing secret anywhere in the flagged record.
    expect(JSON.stringify(flagged)).not.toContain(corrupt.mnemonic!);
  });

  it('a rekeyed account with a lost key keeps its rekey fields and is flagged; one that never owned a key is neither flagged nor listed', async () => {
    const lost = rekeyed('rk-lost', true, true);
    const foreign = rekeyed('rk-foreign', false, false);
    await restoreAccounts([lost, foreign]);
    mockPlatform.__secure.delete(`${SECRET}rk-lost`);

    const c = await collectAccounts(CAP);

    const lostRec = c.accounts.find((x) => x.id === 'rk-lost')!;
    expect(lostRec.type).toBe(AccountType.REKEYED);
    expect(lostRec.authAddress).toBe(lost.authAddress);
    expect(lostRec.originalOwner).toBe(true);
    expect(lostRec.mnemonic).toBeUndefined();
    expect(lostRec.withoutKey).toBe(true);
    const foreignRec = c.accounts.find((x) => x.id === 'rk-foreign')!;
    expect(foreignRec.withoutKey).toBeUndefined();
    expect(c.leftOut.map((x) => [x.label, x.reason])).toEqual([
      ['rk-lost', 'no-key-on-device'],
    ]);
  });

  it('a rekeyed account whose slot is occupied but unreadable is flagged and listed as unreadable', async () => {
    const r = rekeyed('rk-bad', true, true);
    await restoreAccounts([r]);
    mockPlatform.__secure.set(`${SECRET}rk-bad`, 'not json');

    const c = await collectAccounts(CAP);

    expect(c.accounts[0].withoutKey).toBe(true);
    expect(c.accounts[0].mnemonic).toBeUndefined();
    expect(c.leftOut.map((x) => x.reason)).toEqual(['key-unreadable']);
  });

  it('every flagged record has exactly one list entry and every entry (but the other-key reason) has one flagged record', async () => {
    await restoreAccounts([
      standard('a'),
      standard('b'),
      rekeyed('r', true, true),
      keyless('w', AccountType.WATCH),
    ]);
    mockPlatform.__secure.set(`${SECRET}b`, 'not json');
    mockPlatform.__secure.delete(`${SECRET}r`);

    const c = await collectAccounts(CAP);

    const flagged = c.accounts
      .filter((x) => x.withoutKey === true)
      .map((x) => x.address)
      .sort();
    const listed = c.leftOut.map((x) => x.address).sort();
    expect(flagged).toEqual(listed);
    expect(flagged).toHaveLength(2);
  });
});

describe('TASK-504: two records at one address (dev lead 89d3f459)', () => {
  it('one exported and the other with an empty slot: the address is not in the list, gets no row and no second record', async () => {
    const a = standard('dup-a');
    await restoreAccounts([a]);
    await addDuplicateRecord('dup-a', 'dup-b'); // dup-b: no slot of its own

    const c = await collectAccounts(CAP);

    expect(c.accounts.map((x) => x.id)).toEqual(['dup-a']);
    expect(c.accounts[0].mnemonic).toBe(a.mnemonic);
    expect(c.accounts[0].withoutKey).toBeUndefined();
    expect(c.leftOut).toEqual([]);
  });

  it('one exported and the other with an unreadable slot: also out of the list', async () => {
    const a = standard('dup-a');
    await restoreAccounts([a]);
    await addDuplicateRecord('dup-a', 'dup-b');
    mockPlatform.__secure.set(`${SECRET}dup-b`, 'not json');

    const c = await collectAccounts(CAP);

    expect(c.accounts.map((x) => x.id)).toEqual(['dup-a']);
    expect(c.leftOut).toEqual([]);
  });

  it('one exported and the other slot positively holding a DIFFERENT key: in the list, named, with the other-key reason; its own record stays ordinary and unflagged', async () => {
    const a = standard('dup-a');
    const x = standard('x-other');
    await restoreAccounts([a, x]);
    await addDuplicateRecord('dup-a', 'dup-b');
    // dup-b's slot reads, and derives to x's address, not to dup-a's.
    mockPlatform.__secure.set(
      `${SECRET}dup-b`,
      mockPlatform.__secure.get(`${SECRET}x-other`)!
    );

    const c = await collectAccounts(CAP);

    expect(c.accounts.map((r) => r.id)).toEqual(['dup-a', 'x-other']);
    expect(c.accounts[0].mnemonic).toBe(a.mnemonic);
    expect(c.accounts[0].withoutKey).toBeUndefined();
    expect(c.leftOut).toEqual([
      { address: a.address, label: 'dup-b', reason: 'other-key-on-device' },
    ]);
  });

  it('the exported phrase does not derive to the address: both records are in the list, flagged, and no phrase is written', async () => {
    const a = standard('dup-a');
    await restoreAccounts([a]);
    await addDuplicateRecord('dup-a', 'dup-b');
    const wrong = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    jest
      .spyOn(SecureKeyManager, 'revealMnemonicForRecord')
      .mockResolvedValue(wrong);

    const c = await collectAccounts(CAP);

    expect(c.accounts.map((r) => r.id)).toEqual(['dup-a', 'dup-b']);
    for (const r of c.accounts) {
      expect(r.mnemonic).toBeUndefined();
      expect(r.withoutKey).toBe(true);
    }
    expect(c.leftOut.map((r) => r.label)).toEqual(['dup-a', 'dup-b']);
    expect(JSON.stringify(c)).not.toContain(wrong);
  });

  it("a lone record whose slot holds another address's key is flagged and listed as unreadable, as before", async () => {
    const ok = standard('ok');
    const bad = standard('bad');
    await restoreAccounts([ok, bad]);
    mockPlatform.__secure.set(
      `${SECRET}bad`,
      mockPlatform.__secure.get(`${SECRET}ok`)!
    );

    const c = await collectAccounts(CAP);

    expect(c.leftOut).toEqual([
      { address: bad.address, label: 'bad', reason: 'key-unreadable' },
    ]);
    expect(c.accounts.find((r) => r.id === 'bad')?.withoutKey).toBe(true);
  });
});
