// TASK-504 step 2b: "fresh" is decided from strict reads, inside a wallet-queue
// task, before any account is added: no PIN, a zero-account wallet blob, an
// empty account list, journal and quarantine set, and no pin-setup-pending
// breadcrumb. It is checked again at the commit. A read error stops the
// restore with nothing written. Real AccountSecureStorage + wallet service +
// performFullRestore; only platform storage is in memory.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const flags = { kvReadFailsFor: null as string | null };
  return {
    __secure: secure,
    __kv: kv,
    __flags: flags,
    __reset: () => {
      secure.clear();
      kv.clear();
      flags.kvReadFailsFor = null;
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
      getItem: async (k: string) => {
        if (flags.kvReadFailsFor === k) throw new Error('storage read failed');
        return kv.has(k) ? kv.get(k)! : null;
      },
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as platform from '@/platform';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountType } from '@/types/wallet';
import { performFullRestore, restoreAccounts } from '../restorers';
import type { BackupAccountData, BackupSettings } from '../types';

const PIN = '123456';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __flags: { kvReadFailsFor: string | null };
  __reset: () => void;
};
const multiSet = AsyncStorage.multiSet as jest.Mock;

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

function fileSettings(pairings = 0): BackupSettings {
  return {
    network: 'voi-mainnet',
    remoteSigner:
      pairings > 0
        ? {
            appMode: 'wallet',
            signerConfig: null,
            pairedSigners: Array.from({ length: pairings }, (_, i) => ({
              deviceId: `signer-${i}`,
              pairedAt: 1,
            })),
          }
        : undefined,
  } as unknown as BackupSettings;
}

function restoreFile(
  account: BackupAccountData,
  settings: BackupSettings = fileSettings()
) {
  return performFullRestore(
    [account],
    settings,
    [],
    {} as Parameters<typeof performFullRestore>[3]
  );
}

function snapshot() {
  return {
    secure: new Map(mockPlatform.__secure),
    kv: new Map(mockPlatform.__kv),
  };
}

beforeEach(() => {
  mockPlatform.__reset();
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
  multiSet.mockClear();
  jest.restoreAllMocks();
});

describe('TASK-504 step 2b: fresh is decided from strict reads', () => {
  it('a device with nothing on it is fresh: the file settings are taken', async () => {
    const result = await restoreFile(keyed('f-1'));
    expect(result.settingsRestored).toBe(true);
    expect(multiSet).toHaveBeenCalled();
    expect(result.records[0].outcome).toBe('added');
  });

  // Each arrangement leaves every OTHER condition at "empty", so a single
  // dropped check is the only thing that can make the device read as fresh.
  const arrangements: [string, () => Promise<void> | void][] = [
    [
      'a PIN credential survives (no accounts, no list)',
      async () => {
        const orphan = keyed('orphan');
        await restoreAccounts([orphan]);
        await AccountSecureStorage.setupPin(PIN, 'pin');
        SessionKeyVault.clear();
        mockPlatform.__kv.clear(); // app storage gone, keychain kept
      },
    ],
    [
      'the account list holds an id (no PIN, no blob)',
      () => {
        mockPlatform.__kv.set('voi_account_list', JSON.stringify(['x']));
      },
    ],
    [
      'the pending-creates journal holds an entry',
      () => {
        mockPlatform.__kv.set(
          'voi_pending_account_creates',
          JSON.stringify({ x: 'token' })
        );
      },
    ],
    [
      'the quarantine registry holds an id',
      () => {
        mockPlatform.__kv.set(
          'voi_reconcile_quarantined_ids',
          JSON.stringify(['x'])
        );
      },
    ],
    [
      'the pin-setup-pending breadcrumb is set',
      () => {
        mockPlatform.__kv.set('pin_setup_pending', '1');
      },
    ],
    [
      'the wallet blob holds an account (list and journal empty)',
      async () => {
        await restoreAccounts([keyed('dev-1')]);
        mockPlatform.__kv.delete('voi_account_list');
      },
    ],
  ];

  it.each(arrangements)(
    'not fresh when %s: accounts are still added, settings are not',
    async (_name, arrange) => {
      await arrange();
      multiSet.mockClear();
      const incoming = keyed('f-2');
      const result = await restoreFile(incoming);
      expect(result.settingsRestored).toBe(false);
      expect(multiSet).not.toHaveBeenCalled();
      expect(result.friendsCount).toBe(0);
      expect(result.remoteSignerSettingsRestored).toBe(false);
      expect(result.records[0].outcome).toBe('added');
    }
  );

  it('a corrupt quarantine registry stops the restore with nothing written', async () => {
    mockPlatform.__kv.set('voi_reconcile_quarantined_ids', 'not json');
    const before = snapshot();
    await expect(restoreFile(keyed('f-3'))).rejects.toMatchObject({
      code: 'RESTORE_FAILED',
    });
    expect(snapshot()).toEqual(before);
    expect(multiSet).not.toHaveBeenCalled();
  });

  it('a failed read of the breadcrumb stops the restore: it is never read as absent', async () => {
    mockPlatform.__flags.kvReadFailsFor = 'pin_setup_pending';
    const before = snapshot();
    await expect(restoreFile(keyed('f-4'))).rejects.toMatchObject({
      code: 'RESTORE_FAILED',
    });
    expect(snapshot()).toEqual(before);
    expect(multiSet).not.toHaveBeenCalled();
  });

  it('a wallet blob with an account is not fresh even when the file adds nothing (only the early check can see it: the commit never runs)', async () => {
    const dev = keyed('dev-1');
    await restoreAccounts([dev]);
    mockPlatform.__kv.delete('voi_account_list');
    multiSet.mockClear();

    const result = await restoreFile({ ...dev });

    expect(result.records[0].outcome).toBe('already-present');
    expect(result.settingsRestored).toBe(false);
    expect(multiSet).not.toHaveBeenCalled();
  });

  it('an account another writer lands before the commit makes the device not fresh: settings are not taken', async () => {
    const original = MultiAccountWalletService.mergeRestoredAccounts.bind(
      MultiAccountWalletService
    );
    jest
      .spyOn(MultiAccountWalletService, 'mergeRestoredAccounts')
      .mockImplementationOnce(async (...args) => {
        // A different writer commits a wallet with an account first.
        await MultiAccountWalletService.persistRestoredWallet({
          id: 'wallet_other',
          version: '2.0',
          createdAt: new Date().toISOString(),
          settings: args[2].settings,
          activeAccountId: 'other-1',
          accounts: [
            {
              id: 'other-1',
              address: keyed('tmp').address,
              publicKey: '',
              type: AccountType.WATCH,
              label: 'other',
              color: '#000000',
              isHidden: false,
              createdAt: new Date().toISOString(),
              lastUsed: new Date().toISOString(),
            },
          ] as never,
        });
        return original(...args);
      });
    const result = await restoreFile(keyed('f-5'));
    expect(result.records[0].outcome).toBe('added');
    expect(result.settingsRestored).toBe(false);
    expect(multiSet).not.toHaveBeenCalled();
  });

  it('the wallet blob settings of a device that has a wallet are not replaced by an add', async () => {
    await restoreAccounts([keyed('dev-1')]);
    const blobBefore = JSON.parse(
      mockPlatform.__kv.get('voi_wallet_metadata')!
    );
    blobBefore.settings = {
      ...blobBefore.settings,
      theme: 'dark',
      autoLock: 1,
    };
    mockPlatform.__kv.set('voi_wallet_metadata', JSON.stringify(blobBefore));

    await restoreFile(keyed('f-6'));

    const blobAfter = JSON.parse(mockPlatform.__kv.get('voi_wallet_metadata')!);
    expect(blobAfter.settings).toEqual(blobBefore.settings);
    expect(blobAfter.accounts).toHaveLength(2);
  });

  it('pairings left out are counted on a fresh restore only: a restore that is not fresh takes and claims nothing of the file signer settings', async () => {
    const fresh = await restoreFile(keyed('f-7'), fileSettings(2));
    expect(fresh.settingsRestored).toBe(true);
    expect(fresh.pairedSignersNotRestored).toBe(2);

    const notFresh = await restoreFile(keyed('f-8'), fileSettings(3));
    expect(notFresh.settingsRestored).toBe(false);
    expect(notFresh.pairedSignersNotRestored).toBe(0);

    const none = await restoreFile(keyed('f-9'), fileSettings(0));
    expect(none.pairedSignersNotRestored).toBe(0);
  });
});
