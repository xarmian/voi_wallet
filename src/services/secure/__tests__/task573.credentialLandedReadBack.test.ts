// TASK-573: when the PIN credential write throws inside the rewrap+commit
// transaction, a strict read-back decides the outcome. On Android the keystore
// value is written before the presence sentinel, so a write can throw after the
// credential has already landed. A read-back that shows the new credential
// treats the attempt as committed (it finishes and resolves); a read-back that
// shows no credential or a different one rolls back as before; a read-back that
// throws or times out keeps every blob, so each account decrypts under
// whichever credential is stored. Real AccountSecureStorage + SessionKeyVault +
// envelope crypto; only platform storage is in memory.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const events: { e: string }[] = [];
  const ctl = {
    credWrite: null as null | 'throw' | 'land-then-throw',
    pinReadThrowsAfterCred: false,
    pinReadThrows: false,
    pinReadHangsAfterCred: false,
    pinReadHangs: false,
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
      ctl.credWrite = null;
      ctl.pinReadThrowsAfterCred = false;
      ctl.pinReadThrows = false;
      ctl.pinReadHangsAfterCred = false;
      ctl.pinReadHangs = false;
    },
    crypto: {
      getRandomBytes: async (n: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(n)),
      sha256: async (input: string): Promise<string> =>
        nodeCrypto.createHash('sha256').update(input).digest('hex'),
      randomUUID: () => nodeCrypto.randomUUID(),
    },
    secureStorage: {
      getItem: async (k: string) => {
        if (k === 'voi_wallet_pin') {
          if (ctl.pinReadThrows) throw new Error('keystore read failed');
          if (ctl.pinReadHangs) {
            events.push({ e: 'pinReadHung' });
            return new Promise<string | null>(() => {});
          }
        }
        return secure.has(k) ? secure.get(k)! : null;
      },
      setItem: async (k: string, v: string) => {
        if (k === 'voi_wallet_pin') {
          events.push({ e: 'cred' });
          if (ctl.pinReadThrowsAfterCred) ctl.pinReadThrows = true;
          if (ctl.pinReadHangsAfterCred) ctl.pinReadHangs = true;
          if (ctl.credWrite === 'throw') {
            throw new Error('credential write failed');
          }
          if (ctl.credWrite === 'land-then-throw') {
            secure.set(k, v);
            throw new Error('credential write failed');
          }
        }
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
        if (k === 'pin_setup_pending') events.push({ e: 'mark' });
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        if (k === 'pin_setup_pending') events.push({ e: 'clear' });
        kv.delete(k);
      },
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: { getDeviceId: async () => 'task573-device-idfv' },
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

const OLD_PIN = '480213';
const NEW_PIN = '935716';
const SLOT_A = 'voi_account_secret_acct-A';
const SLOT_B = 'voi_account_secret_acct-B';
const SLOTS = [SLOT_A, SLOT_B];

const mockPlatform = platform as unknown as {
  __secure: Map<string, string>;
  __kv: Map<string, string>;
  __events: { e: string }[];
  __ctl: {
    credWrite: null | 'throw' | 'land-then-throw';
    pinReadThrowsAfterCred: boolean;
    pinReadThrows: boolean;
    pinReadHangsAfterCred: boolean;
    pinReadHangs: boolean;
  };
  __reset: () => void;
};

const timeoutHost = AccountSecureStorage as unknown as {
  KEYCHAIN_READ_TIMEOUT_MS: number;
};
const ORIGINAL_READ_TIMEOUT_MS = timeoutHost.KEYCHAIN_READ_TIMEOUT_MS;

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

type Slot = {
  version?: number;
  blobs?: { mac: string }[];
  encryptedPrivateKey?: string;
};
const slot = (key: string): Slot =>
  JSON.parse(mockPlatform.__secure.get(key) as string) as Slot;
/** Slot contents without the per-write nonce every checked save refreshes. */
const slotContent = (key: string): Omit<Slot, 'writeNonce'> => {
  const { writeNonce: _nonce, ...rest } = slot(key) as Slot & {
    writeNonce?: string;
  };
  return rest;
};

const marks = () => mockPlatform.__events.filter((x) => x.e === 'mark');

describe('TASK-573: a credential write that throws is settled by a read-back', () => {
  let A: ReturnType<typeof makeAccount>;
  let B: ReturnType<typeof makeAccount>;
  let warnSpy: jest.SpyInstance;

  async function expectKeysUnder(pin: string): Promise<void> {
    AccountSecureStorage.clearPrivateKeyCache();
    SessionKeyVault.clear();
    SessionKeyVault.set(pin, 'pin');
    const keyA = await AccountSecureStorage.getPrivateKey('acct-A');
    const keyB = await AccountSecureStorage.getPrivateKey('acct-B');
    expect(Buffer.from(keyA).equals(Buffer.from(A.sk))).toBe(true);
    expect(Buffer.from(keyB).equals(Buffer.from(B.sk))).toBe(true);
  }

  /** setupPin(OLD) on a clean store, then an unlocked session (changePin cases). */
  async function withOldPin(): Promise<void> {
    await AccountSecureStorage.setupPin(OLD_PIN, 'pin');
    SessionKeyVault.set(OLD_PIN, 'pin');
    mockPlatform.__events.length = 0;
  }

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
    mockPlatform.__events.length = 0;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    timeoutHost.KEYCHAIN_READ_TIMEOUT_MS = ORIGINAL_READ_TIMEOUT_MS;
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('(a) changePin, the credential lands and then the write throws: resolves, the NEW PIN verifies, and every key reads under it after a lock', async () => {
    await withOldPin();
    mockPlatform.__ctl.credWrite = 'land-then-throw';

    await expect(
      AccountSecureStorage.changePin(OLD_PIN, NEW_PIN, 'pin')
    ).resolves.toBeUndefined();

    mockPlatform.__ctl.credWrite = null;
    expect(await AccountSecureStorage.verifyPin(NEW_PIN)).toBe(true);
    expect(await AccountSecureStorage.verifyPin(OLD_PIN)).toBe(false);
    for (const key of SLOTS) {
      expect(slot(key).blobs ?? []).toHaveLength(1);
      expect(slot(key).encryptedPrivateKey).toBeFalsy();
    }
    await expectKeysUnder(NEW_PIN);
  });

  it('(b) setupPin, the credential lands and then the write throws: resolves, no device-key copy remains, nothing re-marked', async () => {
    await markPinSetupPending();
    mockPlatform.__events.length = 0;
    mockPlatform.__ctl.credWrite = 'land-then-throw';

    await expect(
      AccountSecureStorage.setupPin(NEW_PIN, 'pin')
    ).resolves.toBeUndefined();

    mockPlatform.__ctl.credWrite = null;
    for (const key of SLOTS) {
      expect(slot(key).blobs ?? []).toHaveLength(1);
      expect(slot(key).encryptedPrivateKey).toBeFalsy();
    }
    expect(marks()).toHaveLength(0);
    expect(await readPinSetupPendingStrict()).toBe(false);
    expect(await AccountSecureStorage.verifyPin(NEW_PIN)).toBe(true);
    await expectKeysUnder(NEW_PIN);
  });

  it('(c) changePin, the write throws without landing: rejects with the original error, each slot returns to its pre-call state', async () => {
    await withOldPin();
    const before = SLOTS.map((key) => slotContent(key));
    mockPlatform.__ctl.credWrite = 'throw';

    await expect(
      AccountSecureStorage.changePin(OLD_PIN, NEW_PIN, 'pin')
    ).rejects.toThrow('Failed to change PIN: credential write failed');

    mockPlatform.__ctl.credWrite = null;
    expect(await AccountSecureStorage.verifyPin(OLD_PIN)).toBe(true);
    expect(SLOTS.map((key) => slotContent(key))).toEqual(before);
    await expectKeysUnder(OLD_PIN);
  });

  it('(d) changePin, the write throws without landing and the read-back throws: rejects, both blobs kept, keys read under the OLD PIN once reads recover', async () => {
    await withOldPin();
    const oldMacs = SLOTS.map((key) => slot(key).blobs![0].mac);
    mockPlatform.__ctl.credWrite = 'throw';
    mockPlatform.__ctl.pinReadThrowsAfterCred = true;

    await expect(
      AccountSecureStorage.changePin(OLD_PIN, NEW_PIN, 'pin')
    ).rejects.toThrow('credential write failed');

    SLOTS.forEach((key, i) => {
      const blobs = slot(key).blobs ?? [];
      expect(blobs).toHaveLength(2);
      expect(blobs.map((b) => b.mac)).toContain(oldMacs[i]);
    });
    mockPlatform.__ctl.credWrite = null;
    mockPlatform.__ctl.pinReadThrowsAfterCred = false;
    mockPlatform.__ctl.pinReadThrows = false;
    expect(await AccountSecureStorage.verifyPin(OLD_PIN)).toBe(true);
    await expectKeysUnder(OLD_PIN);
  });

  it('(e) changePin, the credential lands and the read-back throws: rejects, both blobs kept, every key reads under the NEW PIN once reads recover', async () => {
    await withOldPin();
    mockPlatform.__ctl.credWrite = 'land-then-throw';
    mockPlatform.__ctl.pinReadThrowsAfterCred = true;

    await expect(
      AccountSecureStorage.changePin(OLD_PIN, NEW_PIN, 'pin')
    ).rejects.toThrow('credential write failed');

    for (const key of SLOTS) {
      expect(slot(key).blobs ?? []).toHaveLength(2);
    }
    mockPlatform.__ctl.credWrite = null;
    mockPlatform.__ctl.pinReadThrowsAfterCred = false;
    mockPlatform.__ctl.pinReadThrows = false;
    expect(await AccountSecureStorage.verifyPin(NEW_PIN)).toBe(true);
    await expectKeysUnder(NEW_PIN);
  });

  it('(f) a read-back that outlives the read timeout counts as unknown: rejects, both blobs kept', async () => {
    await withOldPin();
    timeoutHost.KEYCHAIN_READ_TIMEOUT_MS = 50;
    mockPlatform.__ctl.credWrite = 'land-then-throw';
    mockPlatform.__ctl.pinReadHangsAfterCred = true;

    await expect(
      AccountSecureStorage.changePin(OLD_PIN, NEW_PIN, 'pin')
    ).rejects.toThrow('credential write failed');

    for (const key of SLOTS) {
      expect(slot(key).blobs ?? []).toHaveLength(2);
    }
    mockPlatform.__ctl.credWrite = null;
    mockPlatform.__ctl.pinReadHangsAfterCred = false;
    mockPlatform.__ctl.pinReadHangs = false;
    timeoutHost.KEYCHAIN_READ_TIMEOUT_MS = ORIGINAL_READ_TIMEOUT_MS;
    expect(await AccountSecureStorage.verifyPin(NEW_PIN)).toBe(true);
    await expectKeysUnder(NEW_PIN);
  });

  it('(g) the landed path logs no hash, salt or PIN', async () => {
    await withOldPin();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy.mockClear();
    mockPlatform.__ctl.credWrite = 'land-then-throw';

    await AccountSecureStorage.changePin(OLD_PIN, NEW_PIN, 'pin');

    const stored = JSON.parse(
      mockPlatform.__secure.get('voi_wallet_pin') as string
    ) as { hash: string; salt: string };
    expect(stored.hash).toBeTruthy();
    expect(stored.salt).toBeTruthy();

    const render = (arg: unknown): string => {
      if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    };
    const logged = [
      ...warnSpy.mock.calls,
      ...logSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]
      .flat()
      .map(render)
      .join('\n');

    // The landed path did log its one warning...
    expect(warnSpy).toHaveBeenCalledWith(
      'PIN credential write threw, but a read-back shows it landed; treating it as committed',
      expect.any(String)
    );
    // ...and nothing logged carries the credential or either PIN.
    for (const secret of [stored.hash, stored.salt, OLD_PIN, NEW_PIN]) {
      expect(logged).not.toContain(secret);
    }
  });
});
