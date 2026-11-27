// TASK-511: setupPin confirms the restore-before-PIN breadcrumb is gone just
// before the credential write. If that write then fails and a strict read-back
// shows no credential exists, the breadcrumb is set again, so a later kill
// boots to SecuritySetup (resume) and not to the recovery screen. If the write
// landed, or the read-back cannot tell, nothing is re-marked. changePin never
// reads back or marks. Real AccountSecureStorage + SessionKeyVault + envelope
// crypto; only platform storage is in memory.

jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  const secure = new Map<string, string>();
  const kv = new Map<string, string>();
  const events: { e: string }[] = [];
  const ctl = {
    credWrite: null as null | 'throw' | 'land-then-throw',
    pinReadThrowsAfterCred: false,
    pinReadThrows: false,
    markFails: false,
    clearFails: false,
    pendingReadThrows: false,
    pendingVerifyThrows: false,
    removedPending: false,
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
      ctl.markFails = false;
      ctl.clearFails = false;
      ctl.pendingReadThrows = false;
      ctl.pendingVerifyThrows = false;
      ctl.removedPending = false;
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
        if (k === 'voi_wallet_pin' && ctl.pinReadThrows) {
          throw new Error('keystore read failed');
        }
        return secure.has(k) ? secure.get(k)! : null;
      },
      setItem: async (k: string, v: string) => {
        if (k === 'voi_wallet_pin') {
          events.push({ e: 'cred' });
          if (ctl.pinReadThrowsAfterCred) ctl.pinReadThrows = true;
          if (ctl.credWrite === 'throw') {
            throw new Error('credential write failed');
          }
          if (ctl.credWrite === 'land-then-throw') {
            secure.set(k, v);
            throw new Error('credential write failed');
          }
        }
        if (k.startsWith('voi_account_secret_')) {
          events.push({ e: 'slot' });
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
      getItem: async (k: string) => {
        if (k === 'pin_setup_pending') {
          if (ctl.pendingReadThrows) throw new Error('storage read failed');
          if (ctl.pendingVerifyThrows && ctl.removedPending) {
            throw new Error('storage read timed out');
          }
        }
        return kv.has(k) ? kv.get(k)! : null;
      },
      setItem: async (k: string, v: string) => {
        if (k === 'pin_setup_pending') {
          events.push({ e: 'mark' });
          if (ctl.markFails) throw new Error('storage write failed');
        }
        kv.set(k, v);
      },
      removeItem: async (k: string) => {
        if (k === 'pin_setup_pending') {
          if (ctl.clearFails) throw new Error('storage remove failed');
          events.push({ e: 'clear' });
          ctl.removedPending = true;
        }
        kv.delete(k);
      },
    },
    biometrics: {
      isAvailable: async () => false,
      isEnrolled: async () => false,
    },
    deviceId: { getDeviceId: async () => 'task511-device-idfv' },
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
  __events: { e: string }[];
  __ctl: {
    credWrite: null | 'throw' | 'land-then-throw';
    pinReadThrowsAfterCred: boolean;
    pinReadThrows: boolean;
    markFails: boolean;
    clearFails: boolean;
    pendingReadThrows: boolean;
    pendingVerifyThrows: boolean;
    removedPending: boolean;
  };
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

const marks = () => mockPlatform.__events.filter((x) => x.e === 'mark');

describe('TASK-511: a definite first-PIN write failure re-marks the breadcrumb', () => {
  let A: ReturnType<typeof makeAccount>;
  let B: ReturnType<typeof makeAccount>;
  let hasPinSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

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
    const realHasPinStrict =
      AccountSecureStorage.hasPinStrict.bind(AccountSecureStorage);
    hasPinSpy = jest
      .spyOn(AccountSecureStorage, 'hasPinStrict')
      .mockImplementation(async () => {
        mockPlatform.__events.push({ e: 'hasPinStrict' });
        return realHasPinStrict();
      });
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    hasPinSpy.mockRestore();
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('(a) the credential write throws and no credential exists: the breadcrumb is set again, the accounts still read through their device-key copy, and no new-secret blob remains', async () => {
    mockPlatform.__ctl.credWrite = 'throw';
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'credential write failed'
    );

    // The breadcrumb was cleared, the credential write failed, and only then
    // was the breadcrumb set again.
    const order = mockPlatform.__events
      .map((x) => x.e)
      .filter((e) => e === 'clear' || e === 'cred' || e === 'mark');
    expect(order).toEqual(['clear', 'cred', 'mark']);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(mockPlatform.__kv.get('pin_setup_pending')).toBe('true');
    expect(await readPinSetupPendingStrict()).toBe(true);
    for (const key of [SLOT_A, SLOT_B]) {
      expect(slot(key).blobs ?? []).toHaveLength(0);
      expect(slot(key).encryptedPrivateKey).toBeTruthy();
    }
    const keyA = await AccountSecureStorage.getPrivateKey('acct-A');
    const keyB = await AccountSecureStorage.getPrivateKey('acct-B');
    expect(Buffer.from(keyA).equals(Buffer.from(A.sk))).toBe(true);
    expect(Buffer.from(keyB).equals(Buffer.from(B.sk))).toBe(true);

    // The retry, once the store answers, completes and clears it.
    mockPlatform.__ctl.credWrite = null;
    await AccountSecureStorage.setupPin(PIN_1, 'pin');
    expect(await AccountSecureStorage.hasPinStrict()).toBe(true);
    expect(await readPinSetupPendingStrict()).toBe(false);
  });

  it('(b) the credential write lands and then throws: no re-mark, the breadcrumb stays absent', async () => {
    mockPlatform.__ctl.credWrite = 'land-then-throw';
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'credential write failed'
    );

    expect(mockPlatform.__secure.has('voi_wallet_pin')).toBe(true);
    expect(marks()).toHaveLength(0);
    expect(await readPinSetupPendingStrict()).toBe(false);
  });

  it('(c) the credential write throws and the strict PIN read throws: no re-mark (unknown outcome)', async () => {
    mockPlatform.__ctl.credWrite = 'throw';
    mockPlatform.__ctl.pinReadThrowsAfterCred = true;
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'credential write failed'
    );

    const ev = mockPlatform.__events;
    const cred = ev.findIndex((x) => x.e === 'cred');
    // The read-back was attempted (and threw)...
    expect(ev.slice(cred + 1).some((x) => x.e === 'hasPinStrict')).toBe(true);
    // ...and nothing was marked.
    expect(marks()).toHaveLength(0);
    mockPlatform.__ctl.pinReadThrows = false;
    expect(await readPinSetupPendingStrict()).toBe(false);
  });

  it('(d1) an error in the phase-3 verify (before the clear) never marks', async () => {
    jest
      .spyOn(
        AccountSecureStorage as unknown as {
          constantTimeEqualBytes: (a: Uint8Array, b: Uint8Array) => boolean;
        },
        'constantTimeEqualBytes'
      )
      .mockReturnValue(false);
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'Re-wrap verification failed'
    );

    expect(mockPlatform.__events.some((x) => x.e === 'clear')).toBe(false);
    expect(mockPlatform.__events.some((x) => x.e === 'cred')).toBe(false);
    expect(marks()).toHaveLength(0);
    expect(await readPinSetupPendingStrict()).toBe(true);
  });

  it('(d2) a clear whose removal never lands: no credential write, the breadcrumb ends set', async () => {
    mockPlatform.__ctl.clearFails = true;
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'restore setup marker'
    );

    expect(mockPlatform.__events.some((x) => x.e === 'cred')).toBe(false);
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(await readPinSetupPendingStrict()).toBe(true);
  });

  it('(h) a clear whose removal lands but cannot be confirmed: the breadcrumb is set again, no credential write', async () => {
    mockPlatform.__ctl.pendingVerifyThrows = true;
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'restore setup marker'
    );

    const order = mockPlatform.__events
      .map((x) => x.e)
      .filter((e) => e === 'clear' || e === 'cred' || e === 'mark');
    expect(order[0]).toBe('clear');
    expect(order).not.toContain('cred');
    expect(order[order.length - 1]).toBe('mark');
    mockPlatform.__ctl.pendingVerifyThrows = false;
    expect(await AccountSecureStorage.hasPinStrict()).toBe(false);
    expect(await readPinSetupPendingStrict()).toBe(true);
    for (const key of [SLOT_A, SLOT_B]) {
      expect(slot(key).blobs ?? []).toHaveLength(0);
      expect(slot(key).encryptedPrivateKey).toBeTruthy();
    }
  });

  it('(i) the breadcrumb read before the clear throws: counted as absent, never marks', async () => {
    mockPlatform.__ctl.pendingReadThrows = true;
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'restore setup marker'
    );

    expect(mockPlatform.__events.some((x) => x.e === 'cred')).toBe(false);
    expect(marks()).toHaveLength(0);
  });

  it('(e) a throwing re-mark is swallowed: the rejection still carries the original credential-write error', async () => {
    mockPlatform.__ctl.credWrite = 'throw';
    mockPlatform.__ctl.markFails = true;
    const rejection = AccountSecureStorage.setupPin(PIN_1, 'pin');
    await expect(rejection).rejects.toThrow(
      'Failed to set up PIN: credential write failed'
    );

    // The re-mark was attempted after the failed write, and its failure was
    // logged rather than replacing the original error.
    const ev = mockPlatform.__events;
    const cred = ev.findIndex((x) => x.e === 'cred');
    expect(ev.slice(cred + 1).some((x) => x.e === 'mark')).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'Could not restore the PIN setup marker after a failed PIN write',
      expect.anything()
    );
    expect(await readPinSetupPendingStrict()).toBe(false);
  });

  it('(g) no breadcrumb before setupPin (create flow): a failed credential write never creates one', async () => {
    mockPlatform.__kv.delete('pin_setup_pending');
    mockPlatform.__ctl.credWrite = 'throw';
    await expect(AccountSecureStorage.setupPin(PIN_1, 'pin')).rejects.toThrow(
      'credential write failed'
    );

    expect(mockPlatform.__events.some((x) => x.e === 'cred')).toBe(true);
    expect(marks()).toHaveLength(0);
    expect(await readPinSetupPendingStrict()).toBe(false);
  });

  it('(f) changePin with a throwing credential write never reads back or marks', async () => {
    await AccountSecureStorage.setupPin(PIN_1, 'pin');
    SessionKeyVault.set(PIN_1, 'pin');
    mockPlatform.__events.length = 0;
    mockPlatform.__ctl.credWrite = 'throw';

    await expect(
      AccountSecureStorage.changePin(PIN_1, PIN_2, 'pin')
    ).rejects.toThrow('credential write failed');

    const ev = mockPlatform.__events;
    const cred = ev.findIndex((x) => x.e === 'cred');
    expect(cred).toBeGreaterThan(-1);
    expect(ev.slice(cred + 1).some((x) => x.e === 'hasPinStrict')).toBe(false);
    expect(marks()).toHaveLength(0);
    expect(await AccountSecureStorage.verifyPin(PIN_1)).toBe(true);
  });
});
