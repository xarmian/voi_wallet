import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { WRITE_TIMEOUT_MS } from '@/services/secure/boundedWrites';
import { MultiAccountWalletService } from '@/services/wallet';
import { WipeIncompleteError } from '@/types/wallet';
import { withTimeout } from '@/utils/withTimeout';
import {
  PRESENCE_SENTINEL_PREFIX,
  SECURE_KEEP,
  SECURE_LEFTOVER_KEYS,
  redactKeyName,
} from './allowList';
import {
  LEGACY_WALLET_BLOB_NAME,
  LEGACY_WALLET_SECURE_KEY,
  WALLET_BLOB_NAME,
} from './constants';
import { WipeResetRun, runWipeResets } from './gate';
import { STORAGE_KEYS_NAME, listStorageKeys, sweepStorage } from './sweep';

export {
  LEGACY_WALLET_BLOB_NAME,
  LEGACY_WALLET_SECURE_KEY,
  WALLET_BLOB_NAME,
} from './constants';
export { STORAGE_KEYS_NAME } from './sweep';

/** Bound on each wallet-blob step, so a stalled store cannot hang a wipe. */
export const BLOB_STEP_TIMEOUT_MS = 15000;

const stepTimedOut = () => new Error('wipe step timed out');

let inFlight: Promise<void> | null = null;

/** True while a wipe is running (started by anyone, including an abandoned one). */
export function isWipeInFlight(): boolean {
  return inFlight !== null;
}

/**
 * Wait for the local cleanups resets started, each bounded. Never rejects:
 * returns the names of the ones that failed or did not finish.
 */
async function settleResets(run: WipeResetRun): Promise<string[]> {
  const outcomes = await Promise.allSettled(
    run.pending.map(({ done }) =>
      withTimeout(Promise.resolve(done), WRITE_TIMEOUT_MS, stepTimedOut)
    )
  );
  return [
    ...run.failed,
    ...run.pending
      .filter((_, i) => outcomes[i].status === 'rejected')
      .map(({ name }) => name),
  ].map((name) => `memory:${name}`);
}

/**
 * Delete the secure items clearAll does not know: the named leftovers, and any
 * item a leftover presence marker still points at. Returns the ones that could
 * not be confirmed deleted.
 */
async function deleteSecureLeftovers(keys: string[]): Promise<string[]> {
  const names = new Set(Object.keys(SECURE_LEFTOVER_KEYS));
  for (const key of keys) {
    if (!key.startsWith(PRESENCE_SENTINEL_PREFIX)) continue;
    const name = key.slice(PRESENCE_SENTINEL_PREFIX.length);
    if (!SECURE_KEEP.includes(name)) names.add(name);
  }
  const list = [...names];
  const outcomes = await Promise.allSettled(
    list.map((name) => AccountSecureStorage.deleteSecureKeyVerified(name))
  );
  return list.filter((_, i) => outcomes[i].status === 'rejected');
}

async function runWipe(): Promise<void> {
  await AccountSecureStorage.beginWipe();
  // Before the first delete: every store forgets the previous wallet, and
  // writes that captured the epoch earlier skip.
  const purges = settleResets(runWipeResets());
  await AccountSecureStorage.clearAll();
  try {
    await withTimeout(
      MultiAccountWalletService.clearAllWallets(),
      BLOB_STEP_TIMEOUT_MS,
      stepTimedOut
    );
    // Verify, do not assume: the blob must read back as absent.
    const stillThere = await withTimeout(
      MultiAccountWalletService.hasWalletWithAccountsStrict(),
      BLOB_STEP_TIMEOUT_MS,
      stepTimedOut
    );
    if (stillThere !== false) throw new Error('wallet blob remains');
  } catch {
    throw new WipeIncompleteError([WALLET_BLOB_NAME]);
  }
  // clearAllWallets deletes the legacy secure-store copy fire-and-forget (so a
  // hung keychain cannot block its write chain). The wipe confirms it here,
  // bounded: the tombstone alone makes the copy unreadable, not gone.
  try {
    await withTimeout(
      AccountSecureStorage.deleteSecureKeyVerified(LEGACY_WALLET_SECURE_KEY),
      BLOB_STEP_TIMEOUT_MS,
      stepTimedOut
    );
  } catch {
    throw new WipeIncompleteError([LEGACY_WALLET_BLOB_NAME]);
  }

  // The local purges write their own (emptied) records; let them land before
  // general storage is listed and swept.
  const unresolved = new Set<string>(await purges);
  let keys: string[] = [];
  try {
    keys = await listStorageKeys();
  } catch {
    unresolved.add(STORAGE_KEYS_NAME);
  }
  const secureLeft = await deleteSecureLeftovers(keys);
  secureLeft.forEach((name) => unresolved.add(name));
  // A presence marker whose item could not be deleted stays, so a later read
  // of that item fails instead of reading as absent.
  const spare = new Set(
    secureLeft.map((name) => `${PRESENCE_SENTINEL_PREFIX}${name}`)
  );
  for (const key of await sweepStorage(keys, spare)) unresolved.add(key);
  if (unresolved.size > 0)
    throw new WipeIncompleteError([...unresolved].map(redactKeyName));
  await AccountSecureStorage.endWipe();
}

/**
 * TASK-469: the one way to erase the wallet from this device.
 *
 * Order: record the wipe request (so a crash or an incomplete wipe is finished
 * by the next boot instead of being mistaken for a finished one); reset every
 * in-memory store; erase secure storage (bounded, outcomes checked); erase the
 * wallet blob and verify it reads back absent; delete secure items outside the
 * account layer; remove every general-storage key not on the allow-list and
 * list storage again to confirm; only then clear the request. It resolves ONLY
 * when every step is complete; otherwise it throws WipeIncompleteError naming
 * what is unresolved (never values). Callers must not show "deleted" or route
 * to onboarding on any throw.
 *
 * One wipe at a time: a call made while a wipe is running (a Retry after a
 * boot-time timeout abandoned it, or a recheck during a user-started wipe)
 * joins that wipe instead of starting a second one.
 */
export function wipeAllLocalData(): Promise<void> {
  if (inFlight) return inFlight;
  const run = runWipe().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}
