import { AccountMetadata, classifyKeyHolding } from '@/types/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';

/** Conservative custody classification for the account-list deletion action. */
export async function isListDeletionProtected(
  account: AccountMetadata
): Promise<boolean> {
  const holding = classifyKeyHolding(account);
  if (holding !== 'unresolved') return holding === 'present';

  try {
    return await AccountSecureStorage.probeSecretPresenceStrict(account.id);
  } catch {
    // An unavailable vault cannot establish that deletion is safe.
    return true;
  }
}
