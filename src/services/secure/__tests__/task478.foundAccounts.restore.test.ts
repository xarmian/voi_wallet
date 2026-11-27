// TASK-478: restoring a quarantined key. The key is copied into a fresh id
// through the import's journaled create, the new slot is verified, and only
// then is the old slot deleted. At every step the key stays in the old slot or
// in a wallet account whose slot reads key-matches (invariant K).

jest.mock('@/platform', () =>
  require('./fixtures/task478Platform').createTask478Platform()
);
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
// The PIN and device-key KDFs run on node's native crypto, as they run on a
// device through react-native-quick-crypto. Each backend must pass its
// known-answer check before it is used, so the bytes are the same as the
// pure-JS fallback's; only the CPU time differs. On the fallback every case
// here spent 2-2.5 s in key derivation, which pushed the slowest past 5 s on CI.
jest.mock('react-native-quick-crypto', () => {
  const nodeCrypto = require('crypto');
  return { pbkdf2: nodeCrypto.pbkdf2, scrypt: nodeCrypto.scrypt };
});

import algosdk from 'algosdk';
import nacl from 'tweetnacl';
import {
  AccountSecureStorage,
  FoundAccountMismatchError,
} from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { ledgerAlgorandService } from '@/services/ledger/algorand';
import { NetworkService } from '@/services/network';
import { NetworkId } from '@/types/network';
import { WriteOutcomeUnknownError } from '@/services/secure/boundedWrites';
import * as freshAuth from '@/services/secure/freshAuth';
import type { FreshAuthCapability } from '@/services/secure/freshAuth';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  readFoundAccountsSummary,
  restoreFoundAccount,
  scanFoundAccounts,
} from '../foundAccounts';
import { idsNeedingScan } from '../foundAccountsCount';
import {
  PIN,
  SECRET,
  addWatch,
  authed,
  boot,
  installPrompter,
  mockPlatform,
  pinDeviceWithTwoOrphans,
  readRegistry,
  readScanMap,
  resetAll,
  slotState,
  spyDecryptors,
  unlock,
  writeUnboundKey,
  type Orphan,
} from './fixtures/task478Helpers';

const service = AccountSecureStorage as unknown as Record<
  string,
  (...args: unknown[]) => Promise<unknown>
>;
const wallet = MultiAccountWalletService as unknown as Record<
  string,
  (...args: unknown[]) => Promise<unknown>
>;

let unregister: (() => void) | undefined;
beforeEach(() => {
  resetAll();
  jest.restoreAllMocks();
  unregister = installPrompter(true).unregister;
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

async function scanAll() {
  const summary = await readFoundAccountsSummary();
  if (summary.unscannedIds.length > 0)
    await authed('scan_found_accounts', (cap) =>
      scanFoundAccounts(summary.unscannedIds, cap)
    );
}

function restore(o: Orphan, listedAddress = o.address) {
  return authed('restore_found_account', (cap) =>
    restoreFoundAccount(o.id, listedAddress, cap)
  );
}

/** For an attempt that never returns: a prompt left open would hold the
 *  app-wide prompt lock for the rest of the file, so the capability check is
 *  stubbed instead (the auth gate itself is covered by the reads tests). */
function restoreWithoutPrompt(o: Orphan) {
  jest.spyOn(freshAuth, 'consumeFreshAuth').mockImplementation(() => {});
  return restoreFoundAccount(
    o.id,
    o.address,
    {} as unknown as FreshAuthCapability
  );
}

async function walletAccountAt(address: string) {
  const w = await MultiAccountWalletService.readWalletStrict();
  return w?.accounts.find((a) => a.address === address);
}

/** A 0-amount self-payment on fixed params: nothing reaches a network. */
function selfPayment(address: string) {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    suggestedParams: {
      fee: 1000,
      minFee: 1000,
      flatFee: true,
      firstValid: 1,
      lastValid: 100,
      genesisID: 'task478',
      genesisHash: new Uint8Array(32),
    },
  });
}

/** Signs a payment with the stored key of `id` and checks the signature. */
async function signsAs(id: string, address: string): Promise<boolean> {
  const sk = await AccountSecureStorage.getPrivateKey(id);
  try {
    const txn = selfPayment(address);
    const signed = algosdk.signTransaction(txn, sk);
    const decoded = algosdk.decodeSignedTransaction(signed.blob);
    return (
      decoded.txn.sender.toString() === address &&
      nacl.sign.detached.verify(
        txn.bytesToSign(),
        decoded.sig!,
        algosdk.decodeAddress(address).publicKey
      )
    );
  } finally {
    sk.fill(0);
  }
}

/** Invariant K for one orphan. */
async function keyReachable(o: Orphan): Promise<boolean> {
  if (
    readRegistry().includes(o.id) &&
    (await slotState(o.id, o.address)) === 'key-matches'
  )
    return true;
  const account = await walletAccountAt(o.address);
  return (
    account !== undefined &&
    (await slotState(account.id, o.address)) === 'key-matches'
  );
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}

/** A restart: the hung attempt is abandoned, the vault starts locked, the
 *  boot reconcile runs, then the user unlocks. */
async function restart() {
  jest.restoreAllMocks();
  await boot();
  unlock();
}

describe('TASK-478 restore a found account', () => {
  it('restore uses the journaled create under a fresh id', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    const store = jest.spyOn(service, 'storeAccountForCreation');
    const add = jest.spyOn(wallet, 'addAccountToWallet');
    const commit = jest.spyOn(service, 'commitPendingCreate');
    const del = jest.spyOn(service, 'deleteAccountLocked');
    mockPlatform.__state.writes.length = 0;

    const outcome = await restore(formatA);

    expect(outcome).toEqual({ kind: 'restored', address: formatA.address });
    expect(store).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    const newId = (store.mock.calls[0][0] as { id: string }).id;
    expect(newId).not.toBe(formatA.id);
    expect((add.mock.calls[0][0] as { id: string }).id).toBe(newId);
    expect(commit.mock.calls[0][0]).toBe(newId);
    const secretSets = mockPlatform.__state.writes
      .filter(
        (w) => w.op === 'secure.set' && w.key.startsWith('voi_account_secret_')
      )
      .map((w) => w.key);
    expect([...new Set(secretSets)]).toEqual([SECRET(newId)]);
    const oldDelete = del.mock.calls.findIndex(([id]) => id === formatA.id);
    expect(oldDelete).toBeGreaterThanOrEqual(0);
    expect(del.mock.invocationCallOrder[oldDelete]).toBeGreaterThan(
      commit.mock.invocationCallOrder[0]
    );
    expect(mockPlatform.__secure.has(SECRET(formatA.id))).toBe(false);
    expect(readRegistry()).not.toContain(formatA.id);
    expect(readScanMap()).not.toHaveProperty(formatA.id);
    expect(await slotState(newId, formatA.address)).toBe('key-matches');
    expect((await walletAccountAt(formatA.address))?.id).toBe(newId);
    expect(await signsAs(newId, formatA.address)).toBe(true);
  });

  it('restores a Format A orphan and a v2 orphan end to end, and each signs', async () => {
    const { v2, formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    for (const o of [v2, formatA]) {
      expect(await restore(o)).toEqual({
        kind: 'restored',
        address: o.address,
      });
      const account = await walletAccountAt(o.address);
      expect(account?.type).toBe('standard');
      expect(account?.id).not.toBe(o.id);
      expect(await signsAs(account!.id, o.address)).toBe(true);
      expect(mockPlatform.__secure.has(SECRET(o.id))).toBe(false);
    }
    expect(readRegistry()).toEqual([]);
    expect((await readFoundAccountsSummary()).presentCount).toBe(0);
  });

  it('refuses on address mismatch', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    const other = algosdk.generateAccount().addr.toString();
    const map = readScanMap()!;
    map[formatA.id] = { address: other };
    mockPlatform.__kv.set('voi_reconcile_quarantine_scan', JSON.stringify(map));
    const before = mockPlatform.__secure.get(SECRET(formatA.id));
    const store = jest.spyOn(service, 'storeAccountForCreation');

    await expect(restore(formatA, other)).rejects.toBeInstanceOf(
      FoundAccountMismatchError
    );
    expect(store).not.toHaveBeenCalled();
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
    expect(readScanMap()).not.toHaveProperty(formatA.id);
    expect(readRegistry()).toContain(formatA.id);
  });

  it('refuses without a PIN', async () => {
    await addWatch();
    const orphan = await writeUnboundKey('orphan-nopin');
    await boot();
    const reads = spyDecryptors();
    mockPlatform.__state.writes.length = 0;
    await expect(restore(orphan)).rejects.toThrow();
    expect(reads.total()).toBe(0);
    expect(mockPlatform.__state.writes).toEqual([]);
    expect(readRegistry()).toContain(orphan.id);
  });

  it('release keeps the old copy when the new slot does not verify', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    const before = mockPlatform.__secure.get(SECRET(formatA.id));
    const original =
      AccountSecureStorage.commitPendingCreate.bind(AccountSecureStorage);
    jest
      .spyOn(AccountSecureStorage, 'commitPendingCreate')
      .mockImplementation(async (id, token) => {
        await original(id, token);
        // The new slot no longer holds this key.
        mockPlatform.__secure.set(SECRET(id), '{"accountId":"x"}');
      });

    expect(await restore(formatA)).toEqual({
      kind: 'restored-copy-kept',
      address: formatA.address,
    });
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
    expect(readRegistry()).toContain(formatA.id);
  });

  it("a kept copy records the new account's verdict: no rescan needed", async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    const before = mockPlatform.__secure.get(SECRET(formatA.id));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The new slot reads the key back, then the old slot's delete fails.
    mockPlatform.__state.fault = (op, key) =>
      op === 'secure.delete' && key === SECRET(formatA.id)
        ? 'reject'
        : undefined;
    expect(await restore(formatA)).toEqual({
      kind: 'restored-copy-kept',
      address: formatA.address,
    });
    mockPlatform.__state.fault = undefined;
    warn.mockRestore();
    const account = await walletAccountAt(formatA.address);
    expect(await slotState(account!.id, formatA.address)).toBe('key-matches');
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
    expect(readScanMap()?.[formatA.id]).toEqual({
      address: formatA.address,
      wallet: { ownerId: account!.id, keyUsable: true },
    });
    const summary = await readFoundAccountsSummary();
    expect(summary.rows.find((r) => r.id === formatA.id)).toMatchObject({
      kind: 'in-wallet',
      walletKeyUsable: true,
    });
    // The screen's load goes straight to the list: nothing needs a scan.
    expect(idsNeedingScan(summary)).toEqual([]);
  });

  it('a kept copy whose new slot does not verify records false', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    const original =
      AccountSecureStorage.commitPendingCreate.bind(AccountSecureStorage);
    jest
      .spyOn(AccountSecureStorage, 'commitPendingCreate')
      .mockImplementation(async (id, token) => {
        await original(id, token);
        mockPlatform.__secure.set(SECRET(id), '{"accountId":"x"}');
      });
    expect((await restore(formatA)).kind).toBe('restored-copy-kept');
    const account = await walletAccountAt(formatA.address);
    expect(readScanMap()?.[formatA.id]).toEqual({
      address: formatA.address,
      wallet: { ownerId: account!.id, keyUsable: false },
    });
  });

  it('a kept copy under a locked vault records nothing', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    jest
      .spyOn(service, 'inspectSlotUnderOneVaultState')
      .mockResolvedValueOnce({ state: 'occupied-unreadable', vault: 'locked' });
    expect((await restore(formatA)).kind).toBe('restored-copy-kept');
    expect(readScanMap()?.[formatA.id]).toEqual({ address: formatA.address });
  });

  it('a failed verdict write at release still keeps the copy', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPlatform.__state.fault = (op, key) =>
      (op === 'secure.delete' && key === SECRET(formatA.id)) ||
      (op === 'kv.set' && key === 'voi_reconcile_quarantine_scan')
        ? 'reject'
        : undefined;
    expect((await restore(formatA)).kind).toBe('restored-copy-kept');
    mockPlatform.__state.fault = undefined;
    expect(warn).toHaveBeenCalledWith('[foundAccounts] scan record not saved');
    expect(readScanMap()?.[formatA.id]).toEqual({ address: formatA.address });
    expect(readRegistry()).toContain(formatA.id);
  });

  it('a commit failure after the wallet write reports restored-unconfirmed', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    const before = mockPlatform.__secure.get(SECRET(formatA.id));
    jest
      .spyOn(AccountSecureStorage, 'commitPendingCreate')
      .mockRejectedValueOnce(new Error('journal commit failed'));

    expect(await restore(formatA)).toEqual({
      kind: 'restored-unconfirmed',
      address: formatA.address,
    });
    const account = await walletAccountAt(formatA.address);
    expect(account?.type).toBe('standard');
    expect(await slotState(account!.id, formatA.address)).toBe('key-matches');
    expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
    expect(readRegistry()).toContain(formatA.id);
  });

  it('an unknown outcome at release reports restored-unconfirmed', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    jest
      .spyOn(AccountSecureStorage, 'releaseRestoredOrphan')
      .mockRejectedValueOnce(new WriteOutcomeUnknownError(true));

    expect(await restore(formatA)).toEqual({
      kind: 'restored-unconfirmed',
      address: formatA.address,
    });
    expect((await walletAccountAt(formatA.address))?.type).toBe('standard');
  });

  it('a failure before the wallet write still throws', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    jest
      .spyOn(wallet, 'addAccountToWallet')
      .mockRejectedValueOnce(new Error('blob write failed'));
    await expect(restore(formatA)).rejects.toThrow('blob write failed');
    expect(await walletAccountAt(formatA.address)).toBeUndefined();
  });

  describe('interruption leaves the key reachable', () => {
    type Case = {
      name: string;
      arm: (o: Orphan) => void;
      crash?: () => boolean;
      beforeBlob: boolean;
    };
    let hung: jest.SpyInstance | undefined;
    const cases: Case[] = [
      {
        name: 'journal write rejects',
        beforeBlob: true,
        arm: () => {
          mockPlatform.__state.fault = (op, key) =>
            op === 'kv.set' && key === 'voi_pending_account_creates'
              ? 'reject'
              : undefined;
        },
      },
      {
        name: 'new secret write rejects',
        beforeBlob: true,
        arm: (o) => {
          mockPlatform.__state.fault = (op, key) =>
            op === 'secure.set' &&
            key.startsWith('voi_account_secret_') &&
            key !== SECRET(o.id)
              ? 'reject'
              : undefined;
        },
      },
      {
        name: 'crash after the new secret, before the wallet blob',
        beforeBlob: true,
        arm: () => {
          hung = jest
            .spyOn(wallet, 'addAccountToWallet')
            .mockReturnValue(new Promise(() => {}));
        },
        crash: () => (hung?.mock.calls.length ?? 0) > 0,
      },
      {
        name: 'addAccountToWallet rejects',
        beforeBlob: true,
        arm: () => {
          jest
            .spyOn(wallet, 'addAccountToWallet')
            .mockRejectedValueOnce(new Error('blob write failed'));
        },
      },
      {
        name: 'crash after the blob, before the commit',
        beforeBlob: false,
        arm: () => {
          hung = jest
            .spyOn(service, 'commitPendingCreate')
            .mockReturnValue(new Promise(() => {}));
        },
        crash: () => (hung?.mock.calls.length ?? 0) > 0,
      },
      {
        name: 'crash after the commit, before the release',
        beforeBlob: false,
        arm: () => {
          hung = jest
            .spyOn(service, 'releaseRestoredOrphan')
            .mockReturnValue(new Promise(() => {}));
        },
        crash: () => (hung?.mock.calls.length ?? 0) > 0,
      },
      {
        name: 'the old slot delete rejects at release',
        beforeBlob: false,
        arm: (o) => {
          mockPlatform.__state.fault = (op, key) =>
            op === 'secure.delete' && key === SECRET(o.id)
              ? 'reject'
              : undefined;
        },
      },
    ];

    it.each(cases)('$name', async ({ arm, crash, beforeBlob }) => {
      hung = undefined;
      const { formatA } = await pinDeviceWithTwoOrphans();
      await scanAll();
      const before = mockPlatform.__secure.get(SECRET(formatA.id));
      arm(formatA);
      if (crash) {
        void restoreWithoutPrompt(formatA).catch(() => {});
        await until(crash);
        mockPlatform.__state.fault = undefined;
        await restart();
      } else {
        await restore(formatA).catch(() => undefined);
        mockPlatform.__state.fault = undefined;
      }
      expect(await keyReachable(formatA)).toBe(true);
      // Every case here stops before the old slot is released.
      expect(readRegistry()).toContain(formatA.id);
      expect(mockPlatform.__secure.get(SECRET(formatA.id))).toBe(before);
      expect(await slotState(formatA.id, formatA.address)).toBe('key-matches');
      if (!beforeBlob) {
        // The new account is live, so the old copy is offered for removal.
        const summary = await readFoundAccountsSummary();
        const row = summary.rows.find((r) => r.id === formatA.id);
        expect(row?.kind).toBe('in-wallet');
      }
    });

    it('a crash before the blob leaves two copies that list as one ready row', async () => {
      const { formatA } = await pinDeviceWithTwoOrphans();
      await scanAll();
      hung = jest
        .spyOn(wallet, 'addAccountToWallet')
        .mockReturnValue(new Promise(() => {}));
      void restoreWithoutPrompt(formatA).catch(() => {});
      await until(() => (hung?.mock.calls.length ?? 0) > 0);
      await restart();
      await scanAll();
      const summary = await readFoundAccountsSummary();
      const ready = summary.rows.filter(
        (r) => r.kind === 'ready' && r.address === formatA.address
      );
      expect(ready).toHaveLength(1);
      expect(ready[0].kind === 'ready' && ready[0].ids.length).toBe(2);
    });
  });
});

describe('TASK-478 a restored found key signs through the app signing path', () => {
  it('SecureKeyManager.signTransaction signs as the listed address after a restore (Format A and v2)', async () => {
    const { v2, formatA } = await pinDeviceWithTwoOrphans();
    await scanAll();
    // The route's one network read is the rekey lookup: not rekeyed. Nothing
    // else on the route is replaced; the key comes from the real slot read.
    const rekeyLookup = jest.fn(async () => ({ isRekeyed: false }));
    const network = jest.spyOn(NetworkService, 'getInstance').mockReturnValue({
      getAccountRekeyInfo: rekeyLookup,
    } as unknown as NetworkService);
    // Spies that call through: they only record which path was taken.
    const ledgerSign = jest.spyOn(ledgerAlgorandService, 'signTransaction');
    const keyRead = jest.spyOn(AccountSecureStorage, 'getPrivateKey');

    for (const o of [formatA, v2]) {
      const outcome = await restore(o);
      keyRead.mockClear();
      const txn = selfPayment(o.address);

      const blob = await SecureKeyManager.signTransaction(
        txn,
        o.address,
        undefined,
        NetworkId.VOI_MAINNET
      );

      const decoded = algosdk.decodeSignedTransaction(blob);
      expect(decoded.txn.sender.toString()).toBe(o.address);
      // Signed by the account's own key, not by a rekey authority.
      expect(decoded.sgnr).toBeUndefined();
      expect(
        nacl.sign.detached.verify(
          txn.bytesToSign(),
          decoded.sig!,
          algosdk.decodeAddress(o.address).publicKey
        )
      ).toBe(true);
      expect(outcome).toEqual({ kind: 'restored', address: o.address });
      const account = await walletAccountAt(o.address);
      expect(account?.id).not.toBe(o.id);
      // The key was read from the restored account's slot.
      expect(keyRead.mock.calls.map(([id]) => id)).toEqual([account!.id]);
      expect(network).toHaveBeenLastCalledWith(NetworkId.VOI_MAINNET);
      expect(rekeyLookup).toHaveBeenLastCalledWith(o.address, true);
    }
    expect(ledgerSign).not.toHaveBeenCalled();
  });
});

describe('TASK-478 PIN change and a quarantined v2 key', () => {
  it('a failed rewrap keeps the old envelope byte for byte, and the key still reads', async () => {
    const { v2 } = await pinDeviceWithTwoOrphans();
    const before = mockPlatform.__secure.get(SECRET(v2.id));
    mockPlatform.__state.fault = (op, key) =>
      op === 'secure.set' && key === SECRET(v2.id) ? 'reject' : undefined;
    await expect(
      AccountSecureStorage.changePin(PIN, '654321', 'pin')
    ).rejects.toThrow();
    mockPlatform.__state.fault = undefined;
    expect(mockPlatform.__secure.get(SECRET(v2.id))).toBe(before);
    expect(await AccountSecureStorage.verifyPin(PIN)).toBe(true);
    SessionKeyVault.clear();
    unlock();
    await scanAll();
    expect(readScanMap()?.[v2.id]).toEqual({ address: v2.address });
  });

  it('after a PIN change the quarantined v2 key reads under the new PIN', async () => {
    const { v2 } = await pinDeviceWithTwoOrphans();
    await AccountSecureStorage.changePin(PIN, '654321', 'pin');
    SessionKeyVault.clear();
    SessionKeyVault.set('654321', 'pin');
    await scanAll();
    expect(readScanMap()?.[v2.id]).toEqual({ address: v2.address });
  });
});
