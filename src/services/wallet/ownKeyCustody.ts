import {
  AccountMetadata,
  AccountType,
  LedgerAccountMetadata,
  RekeyedAccountMetadata,
  StandardAccountMetadata,
} from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { NetworkService } from '@/services/network';
import { keyBelongsToAddress } from '@/utils/keyIdentity';

/** The record types that can carry the account's own secret. */
export type OwnKeyAccount = StandardAccountMetadata | RekeyedAccountMetadata;

export function isOwnKeyType(
  account: AccountMetadata
): account is OwnKeyAccount {
  return (
    account.type === AccountType.STANDARD ||
    account.type === AccountType.REKEYED
  );
}

/**
 * Whether this device holds the account's OWN secret (TASK-425 U2), with a
 * probe error kept distinct from absence. A STANDARD record is its key by
 * definition (a missing one is a phantom the boot reconcile prunes), so only a
 * REKEYED record, which keeps its original key or not (TASK-419), is probed.
 * Presence is not proof the key is readable or is this address's: every path
 * that uses the key still reads it and checks keyBelongsToAddress.
 */
export async function probeOwnKey(
  account: AccountMetadata
): Promise<'present' | 'absent' | 'unresolved'> {
  if (account.type === AccountType.STANDARD) return 'present';
  if (account.type !== AccountType.REKEYED) return 'absent';
  try {
    return (await AccountSecureStorage.probeSecretPresenceStrict(account.id))
      ? 'present'
      : 'absent';
  } catch {
    return 'unresolved';
  }
}

/** probeOwnKey, failing closed: an unresolved probe is not custody. */
export async function holdsOwnKey(account: AccountMetadata): Promise<boolean> {
  return (await probeOwnKey(account)) === 'present';
}

/** The accounts whose own secret this device holds, in input order. */
export async function filterOwnKeyAccounts(
  accounts: readonly AccountMetadata[]
): Promise<OwnKeyAccount[]> {
  const held = await Promise.all(accounts.map(holdsOwnKey));
  return accounts.filter((account, i): account is OwnKeyAccount => held[i]);
}

/**
 * The software record that signs AS `address` when it is a rekey authority:
 * the record at that address whose own secret this device holds (TASK-425 U3).
 * A rekey authority signs with its own key whatever its own rekey state, so a
 * retained REKEYED key qualifies. After U4 an undone rekey stays REKEYED, so a
 * STANDARD-only lookup would strand every account rekeyed to it.
 */
export async function findOwnKeySigner(
  address: string,
  accounts: readonly AccountMetadata[]
): Promise<OwnKeyAccount | undefined> {
  const target = address.toUpperCase();
  for (const account of accounts) {
    if (
      account.address.toUpperCase() === target &&
      (await holdsOwnKey(account))
    ) {
      return account as OwnKeyAccount;
    }
  }
  return undefined;
}

/**
 * holdsOwnKey for an irreversible hand-over of authority TO this key (a rekey
 * target, or removing a rekey back to the account itself). A presence probe
 * also reads a keyless legacy blob as present, so a REKEYED record qualifies
 * only once its key reads and belongs to its address (TASK-425 U3 hunter
 * review). originalOwner is not enough: it can outlive the key (U4). Any
 * failure is not custody.
 */
export async function holdsUsableOwnKey(
  account: AccountMetadata
): Promise<boolean> {
  if (!(await holdsOwnKey(account))) return false;
  if (account.type === AccountType.STANDARD) return true;
  let key: Uint8Array | null = null;
  try {
    key = await AccountSecureStorage.getPrivateKey(account.id);
    return keyBelongsToAddress(key, account.address);
  } catch {
    return false;
  } finally {
    key?.fill(0);
  }
}

/** The accounts holdsUsableOwnKey admits, in input order. */
export async function filterUsableOwnKeyAccounts(
  accounts: readonly AccountMetadata[]
): Promise<OwnKeyAccount[]> {
  const ok = await Promise.all(accounts.map(holdsUsableOwnKey));
  return accounts.filter((account, i): account is OwnKeyAccount => ok[i]);
}

/** findOwnKeySigner under holdsUsableOwnKey. */
export async function findUsableOwnKey(
  address: string,
  accounts: readonly AccountMetadata[]
): Promise<OwnKeyAccount | undefined> {
  const target = address.toUpperCase();
  for (const account of accounts) {
    if (
      account.address.toUpperCase() === target &&
      (await holdsUsableOwnKey(account))
    ) {
      return account as OwnKeyAccount;
    }
  }
  return undefined;
}

/**
 * Airgap transfer hands the account's own key to the signer and converts the
 * record to REMOTE_SIGNER, so that key must be the account's authority. Any
 * record qualifies only while chain state shows no rekey on any network: a
 * REKEYED one once its rekey is undone, and a STANDARD one too, because the
 * persisted type can lag the chain (a rekey made elsewhere, or one that was
 * still pending when the app finished and landed later, TASK-452). A lookup
 * error fails closed. (TASK-425 U2 hunter review.) `fresh` bypasses the
 * rekey-info cache; the destructive convert passes it, so a cached "not
 * rekeyed" can't authorize deleting the key (U2 Codex confirm).
 */
export async function canTransferOwnKey(
  account: AccountMetadata,
  { fresh = false }: { fresh?: boolean } = {}
): Promise<boolean> {
  if (!(await holdsOwnKey(account))) return false;
  try {
    for (const networkId of Object.values(NetworkId)) {
      const info = await NetworkService.getInstance(
        networkId
      ).getAccountRekeyInfo(account.address, true, fresh);
      if (info.isRekeyed) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The accounts canTransferOwnKey admits, in input order. */
export async function filterTransferableAccounts(
  accounts: readonly AccountMetadata[]
): Promise<OwnKeyAccount[]> {
  const ok = await Promise.all(
    accounts.map((account) => canTransferOwnKey(account))
  );
  return accounts.filter((account, i): account is OwnKeyAccount => ok[i]);
}

/** What an airgap signer can sign for: its own keys plus Ledger accounts. */
export async function filterAirgapSignableAccounts(
  accounts: readonly AccountMetadata[]
): Promise<(OwnKeyAccount | LedgerAccountMetadata)[]> {
  const own = new Set((await filterOwnKeyAccounts(accounts)).map((a) => a.id));
  return accounts.filter(
    (account): account is OwnKeyAccount | LedgerAccountMetadata =>
      own.has(account.id) || account.type === AccountType.LEDGER
  );
}
