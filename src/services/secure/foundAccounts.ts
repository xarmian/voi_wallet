/**
 * TASK-478: accounts whose keys were found on this device.
 *
 * The boot reconcile quarantines a key that no wallet account owns (an
 * interrupted create, a lost wallet record). This module is the only caller of
 * the storage methods that read or delete such a key:
 *  - the summary reads no key: ids, presence of the found keys, and the public
 *    scan results. It reads no wallet account's slot either: whether a wallet
 *    account still holds its own key is the scan's recorded verdict;
 *  - the scan, a restore and a remove each need a fresh-auth capability.
 * A restore copies the key into a new account through the import's journaled
 * create, and deletes the found copy only once the new account's slot reads
 * the key back.
 */
import {
  AccountSecureStorage,
  FoundAccountNotQuarantinedError,
} from './AccountSecureStorage';
import { consumeFreshAuth, type FreshAuthCapability } from './freshAuth';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  AccountStorageError,
  AccountType,
  FoundRestoreUnconfirmedError,
} from '@/types/wallet';

export type FoundRow =
  | {
      kind: 'ready';
      id: string;
      ids: string[];
      address: string;
      label?: string;
    }
  | {
      kind: 'in-wallet';
      id: string;
      address: string;
      walletLabel: string;
      walletType: AccountType;
      /**
       * The last auth-gated scan's verdict on whether this wallet account's own
       * slot reads the key back. Missing: not checked (or checked for another
       * account id), which never counts as holding the key.
       */
      walletKeyUsable?: boolean;
    }
  | { kind: 'unscanned'; id: string; hintAddress?: string; hintLabel?: string };

export interface FoundSummary {
  hasPin: boolean;
  /** Registry ids, not owned by the wallet, whose secret slot holds something. */
  presentCount: number;
  rows: FoundRow[];
  unreadableIds: string[];
  unscannedIds: string[];
}

// The counting rule lives in a module with no storage imports, so a screen
// can count without loading the wallet service.
export { actionableCount, actionableOf } from './foundAccountsCount';

/** Reads no key. Any read failure throws, so the caller shows an error. */
export async function readFoundAccountsSummary(): Promise<FoundSummary> {
  const wallet = await MultiAccountWalletService.readWalletStrict();
  const accounts = wallet?.accounts ?? [];
  const owned = new Set(accounts.map((account) => account.id));
  const index = await AccountSecureStorage.readQuarantineIndex(owned);
  const present = index.filter((row) => row.present);
  const rows: FoundRow[] = [];
  const ready = new Map<string, Extract<FoundRow, { kind: 'ready' }>>();
  const unreadableIds: string[] = [];
  const unscannedIds: string[] = [];
  for (const row of present) {
    const scan = row.scan;
    if (scan && 'unreadable' in scan) {
      unreadableIds.push(row.id);
      continue;
    }
    if (!scan) {
      unscannedIds.push(row.id);
      rows.push({
        kind: 'unscanned',
        id: row.id,
        hintAddress: row.hint?.address,
        hintLabel: row.hint?.label,
      });
      continue;
    }
    const inWallet = accounts.find(
      (account) => account.address === scan.address
    );
    if (inWallet) {
      rows.push({
        kind: 'in-wallet',
        id: row.id,
        address: scan.address,
        walletLabel: inWallet.label ?? '',
        walletType: inWallet.type,
        // The scan's stored verdict, never a slot read here. One recorded for
        // another account id (the wallet changed since) reads as missing.
        ...(scan.wallet?.ownerId === inWallet.id
          ? { walletKeyUsable: scan.wallet.keyUsable }
          : {}),
      });
      continue;
    }
    // Copies of one key (a crash mid-restore can leave two) list as one row.
    const existing = ready.get(scan.address);
    if (existing) {
      existing.ids.push(row.id);
      continue;
    }
    const entry: Extract<FoundRow, { kind: 'ready' }> = {
      kind: 'ready',
      id: row.id,
      ids: [row.id],
      address: scan.address,
      ...(row.hint?.address === scan.address && row.hint.label
        ? { label: row.hint.label }
        : {}),
    };
    ready.set(scan.address, entry);
    rows.push(entry);
  }
  return {
    hasPin: await AccountSecureStorage.hasPinStrict(),
    presentCount: present.length,
    rows,
    unreadableIds,
    unscannedIds,
  };
}

/** True when the quarantine registry names any id. Reads no key. */
export async function hasFoundAccountCandidates(): Promise<boolean> {
  return (await AccountSecureStorage.readQuarantinedIdsSalvaged()).length > 0;
}

export async function scanFoundAccounts(
  ids: string[],
  cap: FreshAuthCapability
): Promise<void> {
  consumeFreshAuth(cap, 'scan_found_accounts');
  const wallet = await MultiAccountWalletService.readWalletStrict();
  await AccountSecureStorage.scanQuarantinedAddresses(
    ids,
    walletAccountsOf(wallet?.accounts ?? [])
  );
}

function walletAccountsOf(
  accounts: readonly { id: string; address: string; type: AccountType }[]
) {
  return accounts.map((account) => ({
    id: account.id,
    address: account.address,
    type: account.type,
  }));
}

async function walletOwns(id: string): Promise<boolean> {
  const wallet = await MultiAccountWalletService.readWalletStrict();
  return !!wallet?.accounts.some((account) => account.id === id);
}

/**
 * 'restored-unconfirmed': the account was added to the wallet, then a later
 * step failed; the found copy may still be on this device.
 */
export type FoundRestoreOutcome =
  'restored' | 'restored-copy-kept' | 'restored-unconfirmed';

export async function restoreFoundAccount(
  id: string,
  listedAddress: string,
  cap: FreshAuthCapability
): Promise<{ kind: FoundRestoreOutcome; address: string }> {
  consumeFreshAuth(cap, 'restore_found_account');
  // A key-bearing account on a device with no PIN boots to recovery.
  if (!(await AccountSecureStorage.hasPinStrict())) {
    throw new AccountStorageError('A PIN is required to restore this account');
  }
  // A wallet account's id is never treated as found.
  if (await walletOwns(id)) throw new FoundAccountNotQuarantinedError();
  // Taken before the key is read, so a reset during the restore wins.
  const creationGen = AccountSecureStorage.getResetGeneration();
  const hint = await AccountSecureStorage.readQuarantineHint(id);
  const hintLabel = hint?.address === listedAddress ? hint.label : undefined;
  const key = await AccountSecureStorage.readQuarantinedKeyForRestore(
    id,
    listedAddress
  );
  let newId: string;
  let upgradeDue: boolean;
  try {
    ({ id: newId, upgradeDue } =
      await MultiAccountWalletService.restoreFoundStandardAccount(
        key,
        hintLabel,
        creationGen
      ));
  } catch (error) {
    if (error instanceof FoundRestoreUnconfirmedError) {
      console.warn(
        '[foundAccounts] restore step after the wallet write failed'
      );
      return { kind: 'restored-unconfirmed', address: listedAddress };
    }
    throw error;
  } finally {
    key.fill(0);
  }
  // The account is in the wallet from here on: no failure below may read as
  // "nothing happened".
  try {
    if (await walletOwns(id)) {
      return { kind: 'restored-copy-kept', address: listedAddress };
    }
    const released = await AccountSecureStorage.releaseRestoredOrphan(
      id,
      newId,
      listedAddress
    );
    return {
      kind: released === 'released' ? 'restored' : 'restored-copy-kept',
      address: listedAddress,
    };
  } catch {
    console.warn('[foundAccounts] restore step after the wallet write failed');
    return { kind: 'restored-unconfirmed', address: listedAddress };
  } finally {
    // TASK-529: the new id's v2 upgrade is queued only once the release has
    // settled, whatever its outcome. Queued before it, the release would wait
    // behind a scrypt run, and a lock in that window would keep the copy.
    if (upgradeDue) AccountSecureStorage.scheduleV2UpgradeAfterStore([newId]);
  }
}

/**
 * Removes each id in turn under one fresh authentication (a ready row's
 * copies), stopping at the first failure. An id whose address is a wallet
 * account is removed only while that account's slot reads the key back, checked
 * again here whatever the scan recorded (FoundAccountWalletKeyUncheckedError
 * when the vault is locked; FoundAccountOnlyCopyError otherwise, including for
 * a watch, Ledger or remote-signer account).
 */
export async function removeFoundAccount(
  ids: string[],
  cap: FreshAuthCapability
): Promise<void> {
  consumeFreshAuth(cap, 'remove_found_account');
  for (const id of ids) {
    const wallet = await MultiAccountWalletService.readWalletStrict();
    const accounts = walletAccountsOf(wallet?.accounts ?? []);
    // A wallet account's id is never treated as found.
    if (accounts.some((account) => account.id === id))
      throw new FoundAccountNotQuarantinedError();
    await AccountSecureStorage.deleteQuarantinedOrphan(id, accounts);
  }
}
