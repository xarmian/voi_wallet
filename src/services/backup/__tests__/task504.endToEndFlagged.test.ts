// TASK-504 end to end (dev lead ef933e70 conditions 1 and 3; product e7912207
// item 8): a real backup of a wallet with an account whose key cannot be read is
// written, read back, and shown on the forgotten-PIN consent with that account
// named; and the file round-trips onto a fresh device and onto a wallet that
// already has accounts, every account listed. Real storage, wallet service,
// collectors, encryption and restorers; only the platform layer, the file system
// and the fresh-auth gate are faked.

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
    multiGet: jest.fn(async (keys: string[]) => keys.map((k) => [k, null])),
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

const mockFiles = new Map<string, string>();
jest.mock('expo-file-system', () => {
  class Directory {
    get exists() {
      return true;
    }
    async create() {}
  }
  class File {
    uri: string;
    constructor(a: unknown, b?: string) {
      this.uri = typeof a === 'string' ? a : `file:///mock/${b}`;
    }
    async write(content: string) {
      mockFiles.set(this.uri, content);
    }
    async text() {
      return mockFiles.get(this.uri) ?? '';
    }
  }
  return { Directory, File, Paths: { cache: 'file:///mock/cache' } };
});
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => {},
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import { BackupService } from '../index';
import { decryptBackup } from '../encryption';
import { restoreAccounts, planRestore } from '../restorers';
import { forgottenPinIncompleteWarning } from '../forgottenPinCopy';
import { buildBackupReport } from '../backupReport';
import type { BackupAccountData, VoiBackupFile } from '../types';

const PASSWORD = 'correct horse battery staple backup!';
const SECRET = 'voi_account_secret_';
const CAP = { __brand: 'FreshAuthCapability' } as never;
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

function keyed(id: string) {
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

beforeEach(() => {
  mockPlatform.__reset();
  mockFiles.clear();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  jest.restoreAllMocks();
  mockConsume.mockReset();
});

async function backUpWalletWithUnreadableKey() {
  const good = keyed('good');
  const broken = keyed('broken');
  const watch = {
    ...keyed('watch'),
    type: AccountType.WATCH,
    mnemonic: undefined,
  } as BackupAccountData;
  await restoreAccounts([good, broken, watch]);
  mockPlatform.__secure.set(`${SECRET}broken`, 'not json');
  const made = await BackupService.createBackup(PASSWORD, CAP);
  return { good, broken, watch, made };
}

describe('TASK-504 end to end: a backup with an unreadable key', () => {
  it('is written with every account, the same file name as a complete backup, and the broken one flagged and named', async () => {
    const { good, broken, watch, made } = await backUpWalletWithUnreadableKey();

    expect(made.filename).toMatch(/^voi-wallet-\d{4}-\d{2}-\d{2}\.voibackup$/);
    expect(made.accountCount).toBe(3);
    expect(made.incomplete?.leftOut).toEqual([
      expect.objectContaining({
        address: broken.address,
        label: 'broken',
        reason: 'key-unreadable',
      }),
    ]);
    const envelope = JSON.parse(made.fileContent);
    expect(envelope.version).toBe(3);
    // Nothing in the clear names the account or carries a phrase.
    expect(made.fileContent).not.toContain(broken.address);
    expect(made.fileContent).not.toContain(good.mnemonic!);

    const inner = JSON.parse(
      await decryptBackup(envelope, PASSWORD)
    ) as VoiBackupFile;
    expect(inner.accounts.map((a) => a.id)).toEqual([
      'good',
      'broken',
      'watch',
    ]);
    expect(inner.accounts.find((a) => a.id === 'good')?.mnemonic).toBe(
      good.mnemonic
    );
    const flagged = inner.accounts.find((a) => a.id === 'broken')!;
    expect(flagged.withoutKey).toBe(true);
    expect(flagged.mnemonic).toBeUndefined();
    expect(
      inner.accounts.find((a) => a.id === 'watch')?.withoutKey
    ).toBeUndefined();
    expect(inner.accounts.find((a) => a.id === 'watch')?.address).toBe(
      watch.address
    );
  });

  it('the forgotten-PIN consent for that file is the incomplete variant and names the account (condition 1)', async () => {
    const { broken, made } = await backUpWalletWithUnreadableKey();

    const info = await BackupService.validateBackupFile(made.fileUri, PASSWORD);

    expect(info.incomplete?.leftOut.map((a) => a.address)).toEqual([
      broken.address,
    ]);
    const warning = forgottenPinIncompleteWarning(info);
    expect(warning).not.toBeNull();
    expect(warning?.rows.map((r) => r.label)).toEqual(['broken']);
    // The flagged record carries no key, so it is not counted as supplying one.
    const accounts = (
      JSON.parse(
        await decryptBackup(JSON.parse(made.fileContent), PASSWORD)
      ) as VoiBackupFile
    ).accounts;
    const plan = planRestore(accounts);
    expect(plan.total).toBe(3);
    expect(plan.addable).toBe(3);
    expect(plan.addableWithKey).toBe(1);
  });

  it('the backup report for that file leads with the without-key block', async () => {
    const { made } = await backUpWalletWithUnreadableKey();
    const report = buildBackupReport(made);
    expect(report.withoutKeyCount).toBe(1);
    expect(report.title).toBe("A key isn't in this backup");
    expect(report.withoutKey?.rows.map((r) => r.label)).toEqual(['broken']);
  });
});

describe('TASK-504 end to end: the file round-trips', () => {
  async function accountsFromFile(content: string) {
    const inner = JSON.parse(
      await decryptBackup(JSON.parse(content), PASSWORD)
    ) as VoiBackupFile;
    return inner.accounts;
  }

  it('onto a fresh device: every account is listed; the keyed one signs, the others are added without a key', async () => {
    const { good, broken, watch, made } = await backUpWalletWithUnreadableKey();
    const accounts = await accountsFromFile(made.fileContent);

    mockPlatform.__reset(); // a fresh install
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const result = await restoreAccounts(accounts);

    expect(result.records.map((r) => r.outcome)).toEqual([
      'added',
      'added',
      'added',
    ]);
    expect(result.records.map((r) => r.withoutKey)).toEqual([
      undefined,
      'watch-only',
      undefined,
    ]);
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    const byAddress = new Map(
      (wallet?.accounts ?? []).map((a) => [a.address, a])
    );
    expect(byAddress.size).toBe(3);
    expect(byAddress.get(good.address)?.type).toBe(AccountType.STANDARD);
    expect(byAddress.get(broken.address)?.type).toBe(AccountType.WATCH);
    expect(byAddress.get(watch.address)?.type).toBe(AccountType.WATCH);
    const key = await AccountSecureStorage.getPrivateKey('good');
    expect(Buffer.from(key.slice(32)).toString('hex')).toBe(good.publicKey);
  });

  it('onto a wallet that already has accounts: the new ones are added, the existing one is untouched', async () => {
    const { broken, made } = await backUpWalletWithUnreadableKey();
    const accounts = await accountsFromFile(made.fileContent);

    mockPlatform.__reset();
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const existing = keyed('existing');
    await restoreAccounts([existing]);

    const result = await restoreAccounts(accounts);

    expect(result.records.every((r) => r.outcome === 'added')).toBe(true);
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    expect((wallet?.accounts ?? []).map((a) => a.address)).toContain(
      existing.address
    );
    expect(
      (wallet?.accounts ?? []).find((a) => a.address === broken.address)?.type
    ).toBe(AccountType.WATCH);
    expect(wallet?.accounts).toHaveLength(4);
  });
});

describe('TASK-504 end to end: shapes the first tests did not cover (hunter r4 A)', () => {
  async function innerOf(content: string) {
    return JSON.parse(
      await decryptBackup(JSON.parse(content), PASSWORD)
    ) as VoiBackupFile;
  }

  it('a real collectAccounts result with an other-key-on-device entry passes the export check and the import check', async () => {
    const a = keyed('dup-a');
    const x = keyed('x-other');
    await restoreAccounts([a, x]);
    const blob = JSON.parse(mockPlatform.__kv.get('voi_wallet_metadata')!);
    blob.accounts.push({ ...blob.accounts[0], id: 'dup-b', label: 'dup-b' });
    mockPlatform.__kv.set('voi_wallet_metadata', JSON.stringify(blob));
    mockPlatform.__secure.set(
      `${SECRET}dup-b`,
      mockPlatform.__secure.get(`${SECRET}x-other`)!
    );

    const made = await BackupService.createBackup(PASSWORD, CAP);

    expect(made.incomplete?.leftOut).toEqual([
      expect.objectContaining({
        address: a.address,
        label: 'dup-b',
        reason: 'other-key-on-device',
      }),
    ]);
    expect(made.accountCount).toBe(2);
    // The importer accepts what the exporter wrote.
    const info = await BackupService.validateBackupFile(made.fileUri, PASSWORD);
    expect(info.incomplete?.leftOut).toHaveLength(1);
    const report = buildBackupReport(made);
    expect(report.withoutKeyCount).toBe(0);
    expect(report.otherKeyCount).toBe(1);
    expect(report.title).toBe("A key isn't in this backup");
  });

  it('a flagged rekeyed record goes out and comes back: key-less rekeyed, its rekey fields kept', async () => {
    const lost = {
      ...keyed('rk'),
      type: AccountType.REKEYED,
      authAddress: algosdk.generateAccount().addr.toString(),
      originalOwner: true,
      canSign: false,
      rekeyedAt: '2026-10-01T00:00:00.000Z',
    } as unknown as BackupAccountData;
    await restoreAccounts([lost]);
    mockPlatform.__secure.delete(`${SECRET}rk`);

    const made = await BackupService.createBackup(PASSWORD, CAP);
    const inner = await innerOf(made.fileContent);
    expect(inner.accounts[0].withoutKey).toBe(true);
    expect(inner.accounts[0].authAddress).toBe(lost.authAddress);
    expect(made.incomplete?.leftOut.map((x) => x.reason)).toEqual([
      'no-key-on-device',
    ]);

    mockPlatform.__reset();
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    const result = await restoreAccounts(inner.accounts);

    expect(result.records[0].withoutKey).toBe('rekeyed');
    const [stored] = (await MultiAccountWalletService.getCurrentWallet())!
      .accounts;
    expect(stored.type).toBe(AccountType.REKEYED);
    expect((stored as { authAddress: string }).authAddress).toBe(
      lost.authAddress
    );
  });

  it('the preview counts a flagged standard record as Watch Only, as the restore does', async () => {
    const { made } = await backUpWalletWithUnreadableKey();
    const info = await BackupService.validateBackupFile(made.fileUri, PASSWORD);
    // good = standard; watch + the flagged broken one = watch.
    expect(info.accountTypes).toMatchObject({ standard: 1, watch: 2 });
  });
});
