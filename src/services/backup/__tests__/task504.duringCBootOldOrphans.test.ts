// TASK-504: the state a crash during
// restore step C leaves (new slots written and journaled, no wallet blob),
// with the device's OLD unjournaled orphan slots next to them. Boot runs
// reconcileCrossStoreHalfState. Every old slot must be byte-identical after it.
// Real AccountSecureStorage + wallet service + reconcile; only platform storage
// is in memory. Keys are generated in-process.

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
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';

const OLD_PIN = '123456';
const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __reset: () => void;
};

function makeKeyed(id: string) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  const publicKey = Buffer.from(
    algosdk.decodeAddress(address).publicKey
  ).toString('hex');
  const meta = {
    id,
    address,
    publicKey,
    type: 'standard',
    label: id,
    color: '#000000',
    isHidden: false,
    createdAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
    lastUsed: new Date().toISOString(),
    mnemonic: '',
    hasBackup: false,
    backupVerified: false,
  };
  return { meta: meta as never, sk: kp.sk };
}

describe('TASK-504: boot reconcile in the during-C state leaves the old orphan slots byte-identical', () => {
  it('old unjournaled PIN-wrapped and device-key orphans survive a boot that finds new journaled slots and no wallet blob', async () => {
    mockPlatform.__reset();
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();

    // Old device: a PIN-wrapped key (present at PIN setup) and a device-key key
    // (added after), the PIN removed (step B), app storage gone (reinstall).
    const wrapped = makeKeyed('old-wrapped');
    const devkey = makeKeyed('old-devkey');
    await AccountSecureStorage.storeAccountForCreation(
      wrapped.meta,
      wrapped.sk,
      AccountSecureStorage.getResetGeneration()
    );
    await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
    await AccountSecureStorage.storeAccountForCreation(
      devkey.meta,
      devkey.sk,
      AccountSecureStorage.getResetGeneration()
    );
    mockPlatform.__kv.clear();
    mockPlatform.__secure.delete('voi_wallet_pin');
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();

    // Step C, killed after the slot writes and before the wallet-blob commit:
    // new keys written through the journaled writer.
    const fresh1 = makeKeyed('new-1');
    const fresh2 = makeKeyed('new-2');
    for (const f of [fresh1, fresh2]) {
      await AccountSecureStorage.storeAccountForCreation(
        f.meta,
        f.sk,
        AccountSecureStorage.getResetGeneration(),
        'restore'
      );
    }
    const oldSlots = ['old-wrapped', 'old-devkey'].map((id) => [
      `voi_account_secret_${id}`,
      mockPlatform.__secure.get(`voi_account_secret_${id}`),
    ]);
    expect(oldSlots.every(([, v]) => typeof v === 'string')).toBe(true);
    const newBefore = ['new-1', 'new-2'].map((id) =>
      mockPlatform.__secure.has(`voi_account_secret_${id}`)
    );
    expect(newBefore).toEqual([true, true]);

    // Boot.
    const result = await reconcileCrossStoreHalfState();
    console.log(
      'RECONCILE RESULT',
      JSON.stringify({
        orphansDeleted: (result as { orphanSecretsDeleted?: string[] })
          .orphanSecretsDeleted,
        quarantined: result.orphanSecretsQuarantined,
        phantoms: result.phantomAccountsPruned,
        staleJournal: result.staleJournalDropped,
      })
    );
    console.log(
      'NEW SLOTS AFTER BOOT',
      JSON.stringify(
        ['new-1', 'new-2'].map((id) =>
          mockPlatform.__secure.has(`voi_account_secret_${id}`)
        )
      )
    );

    // The assertion that matters: every OLD slot is byte-identical.
    for (const [key, value] of oldSlots) {
      expect(mockPlatform.__secure.get(key as string)).toBe(value);
    }
  });
});
