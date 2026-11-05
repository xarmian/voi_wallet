// TASK-508 / TASK-504: a setupPin that is killed inside its rewrap loop, then
// run again with a DIFFERENT PIN, must end clean: every listed key reads under
// the new PIN, and each slot holds exactly one blob (the new one) and no
// device-key copy. This is the premise of moving the breadcrumb clear to just
// before the credential write (a kill during the loop then lands on
// SecuritySetup, which reruns setupPin, possibly with another PIN).
//
// A "kill" here is a storage that goes dead after the Nth write to a secret
// slot: that write persists, and every later write (secure or app storage)
// throws. setupPin's pre-commit rollback is best-effort and its writes throw
// too, so the disk is exactly what a process kill at that point would leave.
// Real AccountSecureStorage + SessionKeyVault + envelope crypto; only the
// platform storage is an in-memory mock. Keys are generated in-process.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const kill = { writesLeft: null as number | null, dead: false };
  const guard = () => {
    if (kill.dead) throw new Error('killed');
  };
  return {
    __secure: secure,
    __kv: kv,
    __kill: kill,
    __reset: () => {
      secure.clear();
      kv.clear();
      kill.writesLeft = null;
      kill.dead = false;
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
        guard();
        secure.set(k, v);
        if (k.startsWith('voi_account_secret_') && kill.writesLeft !== null) {
          kill.writesLeft -= 1;
          if (kill.writesLeft === 0) kill.dead = true;
        }
      },
      deleteItem: async (k: string) => {
        guard();
        secure.delete(k);
      },
      getItemWithAuth: async (k: string) =>
        secure.has(k) ? secure.get(k)! : null,
    },
    storage: {
      getItem: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
      setItem: async (k: string, v: string) => {
        guard();
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        guard();
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

import algosdk from 'algosdk';
import * as platform from '@/platform';
import { AccountSecureStorage } from '../AccountSecureStorage';
import { SessionKeyVault } from '../SessionKeyVault';
import { markPinSetupPending } from '../pinSetupPending';

const PIN_1 = '111111';
const PIN_2 = '222222';
const PIN_3 = '333333';
const SLOT_A = 'voi_account_secret_acct-A';
const SLOT_B = 'voi_account_secret_acct-B';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __kill: { writesLeft: number | null; dead: boolean };
  __reset: () => void;
};

function makeAccount(id: string) {
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

type Slot = { blobs?: unknown[]; encryptedPrivateKey?: string };
function slot(key: string): Slot {
  return JSON.parse(mockPlatform.__secure.get(key) as string) as Slot;
}

/** Process restart: the storage comes back, in-memory state is gone. */
function restart() {
  mockPlatform.__kill.writesLeft = null;
  mockPlatform.__kill.dead = false;
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
}

async function killedSetupPin(pin: string, secretWritesBeforeKill: number) {
  mockPlatform.__kill.writesLeft = secretWritesBeforeKill;
  mockPlatform.__kill.dead = false;
  await expect(AccountSecureStorage.setupPin(pin, 'pin')).rejects.toBeDefined();
  expect(mockPlatform.__kill.dead).toBe(true);
}

async function readKey(id: string, pin: string): Promise<Buffer> {
  SessionKeyVault.clear();
  SessionKeyVault.set(pin, 'pin');
  AccountSecureStorage.clearPrivateKeyCache();
  return Buffer.from(await AccountSecureStorage.getPrivateKey(id));
}

describe('TASK-508: setupPin killed inside the rewrap loop, then rerun with a different PIN', () => {
  let A: ReturnType<typeof makeAccount>;
  let B: ReturnType<typeof makeAccount>;

  beforeEach(async () => {
    mockPlatform.__reset();
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    A = makeAccount('acct-A');
    B = makeAccount('acct-B');
    // The post-restore state: two key-bearing accounts, device-key copies only,
    // no PIN, and the restore-before-PIN breadcrumb set.
    for (const x of [A, B]) {
      await AccountSecureStorage.storeAccountForCreation(
        x.meta,
        x.sk,
        AccountSecureStorage.getResetGeneration()
      );
    }
    await markPinSetupPending();
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
  });

  it('kill after the first of two ids gets its new blob: the disk is as described, then the rerun with another PIN ends clean', async () => {
    await killedSetupPin(PIN_1, 1);

    // State a kill leaves: A has its device-key copy plus one new-PIN blob, B is
    // untouched, and there is no credential.
    expect(slot(SLOT_A).blobs).toHaveLength(1);
    expect(slot(SLOT_A).encryptedPrivateKey).toBeTruthy();
    expect(slot(SLOT_B).blobs ?? []).toHaveLength(0);
    expect(slot(SLOT_B).encryptedPrivateKey).toBeTruthy();
    restart();
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);

    // Rerun with a DIFFERENT PIN.
    await AccountSecureStorage.setupPin(PIN_2, 'pin');
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);

    // One blob each, no device-key copy left.
    for (const key of [SLOT_A, SLOT_B]) {
      expect(slot(key).blobs).toHaveLength(1);
      expect(slot(key).encryptedPrivateKey ?? '').toBe('');
    }

    // Both keys read under the new PIN and are the original bytes.
    expect((await readKey('acct-A', PIN_2)).equals(Buffer.from(A.sk))).toBe(
      true
    );
    expect((await readKey('acct-B', PIN_2)).equals(Buffer.from(B.sk))).toBe(
      true
    );

    // The PIN that was killed mid-way is not the credential.
    restart();
    expect(await AccountSecureStorage.verifyPin(PIN_2)).toBe(true);
    expect(await AccountSecureStorage.verifyPin(PIN_1)).toBe(false);
    // And its blob is gone, so it opens nothing.
    await expect(readKey('acct-A', PIN_1)).rejects.toBeDefined();
  });

  it('kill after both ids got their new blob, before the credential: the rerun with another PIN ends clean', async () => {
    await killedSetupPin(PIN_1, 2);
    expect(slot(SLOT_A).blobs).toHaveLength(1);
    expect(slot(SLOT_B).blobs).toHaveLength(1);
    restart();
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);

    await AccountSecureStorage.setupPin(PIN_2, 'pin');

    for (const key of [SLOT_A, SLOT_B]) {
      expect(slot(key).blobs).toHaveLength(1);
      expect(slot(key).encryptedPrivateKey ?? '').toBe('');
    }
    expect((await readKey('acct-A', PIN_2)).equals(Buffer.from(A.sk))).toBe(
      true
    );
    expect((await readKey('acct-B', PIN_2)).equals(Buffer.from(B.sk))).toBe(
      true
    );
  });

  it('two interrupted attempts with different PINs, then a good one: the two-blob cap is not hit and the end state is clean', async () => {
    await killedSetupPin(PIN_1, 2);
    restart();
    await killedSetupPin(PIN_2, 2);
    // Each interrupted attempt appended one blob; the cap is 2 per slot.
    expect(slot(SLOT_A).blobs).toHaveLength(2);
    expect(slot(SLOT_B).blobs).toHaveLength(2);
    restart();

    await AccountSecureStorage.setupPin(PIN_3, 'pin');

    for (const key of [SLOT_A, SLOT_B]) {
      expect(slot(key).blobs).toHaveLength(1);
      expect(slot(key).encryptedPrivateKey ?? '').toBe('');
    }
    expect((await readKey('acct-A', PIN_3)).equals(Buffer.from(A.sk))).toBe(
      true
    );
    expect((await readKey('acct-B', PIN_3)).equals(Buffer.from(B.sk))).toBe(
      true
    );
    restart();
    expect(await AccountSecureStorage.verifyPin(PIN_3)).toBe(true);
  });
});
