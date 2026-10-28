import { AccountMetadata, AccountType } from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

/** Conservative custody classification for the account-list deletion action. */
export async function isListDeletionProtected(
  account: AccountMetadata
): Promise<boolean> {
  if (account.type === AccountType.STANDARD) return true;
  if (account.type !== AccountType.REKEYED) return false;
  if (account.originalOwner === true) return true;

  try {
    return await AccountSecureStorage.probeSecretPresenceStrict(account.id);
  } catch {
    // An unavailable vault cannot establish that deletion is safe.
    return true;
  }
}
