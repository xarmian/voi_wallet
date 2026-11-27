/**
 * TASK-478: accounts whose keys were found on this device.
 *
 * The boot reconcile quarantines a key that no wallet account owns (an
 * interrupted create, a lost wallet record). This module is the only caller of
 * the storage methods that read or delete such a key:
 *  - the summary reads no key: ids, presence, and the public scan results;
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
import { AccountStorageError, AccountType } from '@/types/wallet';

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
      keyed: boolean;
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

/** Every present id the summary names (ready rows count each copy). */
export function presentIdsOf(summary: FoundSummary): string[] {
  return [
    ...summary.rows.flatMap((row) =>
      row.kind === 'ready' ? row.ids : [row.id]
    ),
    ...summary.unreadableIds,
  ];
}

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
        keyed:
          inWallet.type === AccountType.STANDARD ||
          (inWallet.type === AccountType.REKEYED &&
            (inWallet as { originalOwner?: boolean }).originalOwner === true),
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
  await AccountSecureStorage.scanQuarantinedAddresses(ids);
}

async function walletOwns(id: string): Promise<boolean> {
  const wallet = await MultiAccountWalletService.readWalletStrict();
  return !!wallet?.accounts.some((account) => account.id === id);
}

export async function restoreFoundAccount(
  id: string,
  listedAddress: string,
  cap: FreshAuthCapability
): Promise<{ kind: 'restored' | 'restored-copy-kept'; address: string }> {
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
  try {
    ({ id: newId } =
      await MultiAccountWalletService.restoreFoundStandardAccount(
        key,
        hintLabel,
        creationGen
      ));
  } finally {
    key.fill(0);
  }
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
}

export async function removeFoundAccount(
  id: string,
  cap: FreshAuthCapability
): Promise<void> {
  consumeFreshAuth(cap, 'remove_found_account');
  if (await walletOwns(id)) throw new FoundAccountNotQuarantinedError();
  await AccountSecureStorage.deleteQuarantinedOrphan(id);
}
