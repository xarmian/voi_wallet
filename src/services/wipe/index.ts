import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { WipeIncompleteError } from '@/types/wallet';

/** Name reported when the wallet blob (account metadata) could not be cleared. */
export const WALLET_BLOB_NAME = 'wallet_metadata';

/** Bound on each wallet-blob step, so a stalled store cannot hang a wipe. */
export const BLOB_STEP_TIMEOUT_MS = 15000;

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('wipe step timed out')),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

let inFlight: Promise<void> | null = null;

/** True while a wipe is running (started by anyone, including an abandoned one). */
export function isWipeInFlight(): boolean {
  return inFlight !== null;
}

async function runWipe(): Promise<void> {
  await AccountSecureStorage.beginWipe();
  await AccountSecureStorage.clearAll();
  try {
    await bounded(
      MultiAccountWalletService.clearAllWallets(),
      BLOB_STEP_TIMEOUT_MS
    );
    // Verify, do not assume: the blob must read back as absent.
    const stillThere = await bounded(
      MultiAccountWalletService.hasWalletWithAccountsStrict(),
      BLOB_STEP_TIMEOUT_MS
    );
    if (stillThere !== false) throw new Error('wallet blob remains');
  } catch {
    throw new WipeIncompleteError([WALLET_BLOB_NAME]);
  }
  await AccountSecureStorage.endWipe();
}

/**
 * TASK-469: the one way to erase the wallet from this device.
 *
 * Order: record the wipe request (so a crash or an incomplete wipe is finished
 * by the next boot instead of being mistaken for a finished one), erase secure
 * storage (bounded, outcomes checked), erase the wallet blob and verify it reads
 * back absent, and only then clear the request. It resolves ONLY when every step
 * is complete; otherwise it throws WipeIncompleteError naming what is unresolved
 * (never values). Callers must not show "deleted" or route to onboarding on any
 * throw.
 *
 * One wipe at a time: a call made while a wipe is running (a Retry after a
 * boot-time timeout abandoned it, or a recheck during a user-started wipe)
 * joins that wipe instead of starting a second one.
 */
export function wipeWalletData(): Promise<void> {
  if (inFlight) return inFlight;
  const run = runWipe().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}
