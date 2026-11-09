// TASK-508: setupPin clears the restore-before-PIN breadcrumb, with confirmed
// removal, just before the credential write (after the rewrap and read-back),
// not before the rewrap loop. A credential never coexists with the breadcrumb;
// a kill inside the loop leaves the breadcrumb set (SecuritySetup, not
// recovery); an unconfirmed clear aborts pre-commit and the rollback leaves the
// accounts readable through their device-key copy. Real AccountSecureStorage +
// SessionKeyVault + envelope crypto; only platform storage is in memory.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const events: { e: string; breadcrumbSet?: boolean }[] = [];
  const ctl = {
    writesLeft: null as number | null,
    dead: false,
    clearFails: false,
  };
  const guard = () => {
    if (ctl.dead) throw new Error('killed');
  };
  return {
    __secure: secure,
    __kv: kv,
    __events: events,
    __ctl: ctl,
    __reset: () => {
      secure.clear();
      kv.clear();
      events.length = 0;
      ctl.writesLeft = null;
      ctl.dead = false;
      ctl.clearFails = false;
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
        if (k === 'voi_wallet_pin') {
          events.push({
            e: 'cred',
            breadcrumbSet: kv.has('pin_setup_pending'),
          });
        }
        secure.set(k, v);
        if (k.startsWith('voi_account_secret_')) {
          events.push({ e: 'slot' });
          if (ctl.writesLeft !== null) {
            ctl.writesLeft -= 1;
            if (ctl.writesLeft === 0) ctl.dead = true;
          }
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
        if (k === 'pin_setup_pending') {
          if (ctl.clearFails) throw new Error('storage remove failed');
          events.push({ e: 'clear' });
        }
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
import {
  markPinSetupPending,
  readPinSetupPendingStrict,
} from '../pinSetupPending';

const PIN_1 = '111111';
const PIN_2 = '222222';
const SLOT_A = 'voi_account_secret_acct-A';
const SLOT_B = 'voi_account_secret_acct-B';

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __events: { e: string; breadcrumbSet?: boolean }[];
  __ctl: { writesLeft: number | null; dead: boolean; clearFails: boolean };
  __reset: () => void;
};

function makeAccount(id: string) {
  const kp = algosdk.generateAccount();
  const address = kp.addr.toString();
  const publicKey = Buffer.from(
    algosdk.decodeAddress(address).publicKey
  ).toString('hex');
  return {
    meta: {
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
    } as never,
    sk: kp.sk,
  };
}

type Slot = { blobs?: unknown[]; encryptedPrivateKey?: string };
const slot = (key: string): Slot =>
  JSON.parse(mockPlatform.__secure.get(key) as string) as Slot;

function restart() {
  mockPlatform.__ctl.writesLeft = null;
  mockPlatform.__ctl.dead = false;
  SessionKeyVault.clear();
  AccountSecureStorage.clearPrivateKeyCache();
}

describe('TASK-508: the breadcrumb clear sits just before the credential write', () => {
  let A: ReturnType<typeof makeAccount>;
  let B: ReturnType<typeof makeAccount>;

  beforeEach(async () => {
    mockPlatform.__reset();
    SessionKeyVault.clear();
    AccountSecureStorage.clearPrivateKeyCache();
    A = makeAccount('acct-A');
    B = makeAccount('acct-B');
    for (const x of [A, B]) {
      await AccountSecureStorage.storeAccountForCreation(
        x.meta,
        x.sk,
        AccountSecureStorage.getResetGeneration()
      );
    }
    await markPinSetupPending();
    mockPlatform.__events.length = 0;
  });

  it('a credential never coexists with the breadcrumb: the confirmed clear comes after the rewrap writes and before the credential write', async () => {
    await AccountSecureStorage.setupPin(PIN_1, 'pin');

    const ev = mockPlatform.__events;
    const clear = ev.findIndex((x) => x.e === 'clear');
    const cred = ev.findIndex((x) => x.e === 'cred');
    expect(clear).toBeGreaterThan(-1);
    expect(cred).toBeGreaterThan(-1);
    // Both accounts' new blobs are written before the clear...
    expect(ev.slice(0, clear).filter((x) => x.e === 'slot')).toHaveLength(2);
    // ...the clear comes before the credential...
    expect(clear).toBeLessThan(cred);
    // ...and at the moment the credential is written, no breadcrumb exists.
    expect(ev[cred].breadcrumbSet).toBe(false);
    expect(await readPinSetupPendingStrict()).toBe(false);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);
  });

  it('a kill inside the rewrap loop leaves the breadcrumb set and no PIN (SecuritySetup, not recovery); the rerun completes and clears it', async () => {
    mockPlatform.__ctl.writesLeft = 1;
    await expect(
      AccountSecureStorage.setupPin(PIN_1, 'pin')
    ).rejects.toBeDefined();
    expect(mockPlatform.__ctl.dead).toBe(true);
    restart();

    // The state the boot route reads: key-bearing accounts, no credential,
    // breadcrumb SET.
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(await readPinSetupPendingStrict()).toBe(true);
    expect(slot(SLOT_A).blobs).toHaveLength(1);

    await AccountSecureStorage.setupPin(PIN_2, 'pin');
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);
    expect(await readPinSetupPendingStrict()).toBe(false);
  });

  it('a clear that cannot be confirmed aborts BEFORE the credential: the new blobs are rolled back, the accounts still read through their device-key copy, no PIN exists and the breadcrumb is unchanged', async () => {
    mockPlatform.__ctl.clearFails = true;
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'restore setup marker'
    );

    expect(mockPlatform.__events.some((x) => x.e === 'cred')).toBe(false);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(await readPinSetupPendingStrict()).toBe(true);
    // The pre-commit rollback dropped this attempt's new blobs.
    for (const key of [SLOT_A, SLOT_B]) {
      expect(slot(key).blobs ?? []).toHaveLength(0);
      expect(slot(key).encryptedPrivateKey).toBeTruthy();
    }
    // Both keys still read, through the device-key copy (no PIN, empty vault).
    const keyA = await AccountSecureStorage.getPrivateKey('acct-A');
    const keyB = await AccountSecureStorage.getPrivateKey('acct-B');
    expect(Buffer.from(keyA).equals(Buffer.from(A.sk))).toBe(true);
    expect(Buffer.from(keyB).equals(Buffer.from(B.sk))).toBe(true);

    // And the retry, once the store answers, completes.
    mockPlatform.__ctl.clearFails = false;
    await AccountSecureStorage.setupPin(PIN_1, 'pin');
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);
    expect(await readPinSetupPendingStrict()).toBe(false);
  });

  it('a change of PIN with a credential present touches no breadcrumb', async () => {
    await AccountSecureStorage.setupPin(PIN_1, 'pin');
    SessionKeyVault.set(PIN_1, 'pin');
    mockPlatform.__events.length = 0;

    await AccountSecureStorage.changePin(PIN_1, PIN_2, 'pin');

    expect(mockPlatform.__events.some((x) => x.e === 'clear')).toBe(false);
    expect(mockPlatform.__events.some((x) => x.e === 'cred')).toBe(true);
    expect(await AccountSecureStorage.verifyPin(PIN_2)).toBe(true);
  });
});
