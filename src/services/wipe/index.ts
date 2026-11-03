import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { WipeIncompleteError } from '@/types/wallet';

/** Name reported when the wallet blob (account metadata) could not be cleared. */
export const WALLET_BLOB_NAME = 'wallet_metadata';

/**
 * TASK-469: the one way to erase the wallet from this device.
 *
 * Order: record the wipe request (so a crash or an incomplete wipe is finished
 * by the next boot instead of being mistaken for a finished one), erase secure
 * storage (bounded, outcomes checked), erase the wallet blob, and only then
 * clear the request. It resolves ONLY when every step is complete; otherwise it
 * throws WipeIncompleteError naming what is unresolved (never values). Callers
 * must not show "deleted" or route to onboarding on any throw.
 */
export async function wipeWalletData(): Promise<void> {
  await AccountSecureStorage.beginWipe();
  await AccountSecureStorage.clearAll();
  try {
    await MultiAccountWalletService.clearAllWallets();
  } catch {
    throw new WipeIncompleteError([WALLET_BLOB_NAME]);
  }
  await AccountSecureStorage.endWipe();
}
