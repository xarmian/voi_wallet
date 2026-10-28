import {
  AccountMetadata,
  AccountType,
  RekeyedAccountMetadata,
  StandardAccountMetadata,
} from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

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
 * Positive evidence that this device holds the account's OWN secret (TASK-425
 * U2). The persisted type only narrows which records can carry one: a REKEYED
 * record keeps its original key or not (TASK-419), and it is no longer
 * converted back to STANDARD when a rekey is undone. A probe error fails
 * closed, so no export or signing path offers an account it can't vouch for.
 */
export async function holdsOwnKey(account: AccountMetadata): Promise<boolean> {
  if (!isOwnKeyType(account)) return false;
  try {
    return await AccountSecureStorage.probeSecretPresenceStrict(account.id);
  } catch {
    return false;
  }
}

/** The accounts whose own secret this device holds, in input order. */
export async function filterOwnKeyAccounts(
  accounts: readonly AccountMetadata[]
): Promise<OwnKeyAccount[]> {
  const held = await Promise.all(accounts.map(holdsOwnKey));
  return accounts.filter((account, i): account is OwnKeyAccount => held[i]);
}
