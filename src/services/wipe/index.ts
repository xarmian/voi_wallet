import { storage } from '@/platform';
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
  SECURE_LEFTOVERS_RECORD_KEY,
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

/** Every name in a list of storage keys that a leftover presence marker points at. */
function markedNames(keys: string[]): string[] {
  return keys
    .filter((key) => key.startsWith(PRESENCE_SENTINEL_PREFIX))
    .map((key) => key.slice(PRESENCE_SENTINEL_PREFIX.length))
    .filter((name) => !SECURE_KEEP.includes(name));
}

/**
 * Delete secure items by name. Returns the ones that could not be confirmed
 * deleted.
 */
async function deleteSecureItems(names: Set<string>): Promise<string[]> {
  const list = [...names];
  const outcomes = await Promise.allSettled(
    list.map((name) => AccountSecureStorage.deleteSecureKeyVerified(name))
  );
  return list.filter((_, i) => outcomes[i].status === 'rejected');
}

type LeftoverRecord =
  | { state: 'read'; names: string[] }
  | { state: 'corrupt' }
  | { state: 'unreadable' };

/** The secure items an earlier wipe could not delete (names only), bounded. */
async function readLeftoverRecord(): Promise<LeftoverRecord> {
  let raw: string | null;
  try {
    raw = await withTimeout(
      storage.getItem(SECURE_LEFTOVERS_RECORD_KEY),
      WRITE_TIMEOUT_MS,
      stepTimedOut
    );
  } catch {
    return { state: 'unreadable' };
  }
  if (raw === null) return { state: 'read', names: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'string'))
      return { state: 'read', names: parsed };
  } catch {
    // Falls through to corrupt.
  }
  return { state: 'corrupt' };
}

/**
 * Delete the secure items clearAll does not know: the named leftovers, any
 * item a leftover presence marker in `keys` points at, and any item an earlier
 * wipe recorded as not deleted. Records the ones that could not be confirmed
 * deleted, so the retry deletes them even though their markers are gone.
 * Returns the names still unresolved and the names confirmed deleted.
 */
async function deleteSecureLeftovers(
  keys: string[]
): Promise<{ unresolved: string[]; deleted: Set<string> }> {
  const record = await readLeftoverRecord();
  const names = new Set([
    ...Object.keys(SECURE_LEFTOVER_KEYS),
    ...markedNames(keys),
    ...(record.state === 'read' ? record.names : []),
  ]);
  const failed = await deleteSecureItems(names);
  const deleted = new Set([...names].filter((name) => !failed.includes(name)));
  const unresolved = [...failed];
  // An unreadable record is left as it is: rewriting it would lose its names.
  if (record.state === 'unreadable') {
    unresolved.push(SECURE_LEFTOVERS_RECORD_KEY);
  } else if (
    failed.length > 0 ||
    record.state === 'corrupt' ||
    record.names.length > 0
  ) {
    if (record.state === 'corrupt') unresolved.push(SECURE_LEFTOVERS_RECORD_KEY);
    try {
      await withTimeout(
        storage.setItem(SECURE_LEFTOVERS_RECORD_KEY, JSON.stringify(failed)),
        WRITE_TIMEOUT_MS,
        stepTimedOut
      );
    } catch {
      unresolved.push(SECURE_LEFTOVERS_RECORD_KEY);
    }
  }
  return { unresolved, deleted };
}

/** Remove the leftover record once the wipe is complete, bounded. */
async function clearLeftoverRecord(): Promise<void> {
  try {
    await withTimeout(
      storage.removeItem(SECURE_LEFTOVERS_RECORD_KEY),
      WRITE_TIMEOUT_MS,
      stepTimedOut
    );
  } catch {
    throw new WipeIncompleteError([SECURE_LEFTOVERS_RECORD_KEY]);
  }
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
  const leftovers = await deleteSecureLeftovers(keys);
  leftovers.unresolved.forEach((name) => unresolved.add(name));
  // The sweep removes a presence marker only when the item behind it was
  // deleted above. Any other marker (the first listing failed, or it appeared
  // after that listing) is the only pointer to its item, so it stays for the
  // retry, and the wipe is incomplete while one is there. An item whose delete
  // failed is in the leftover record; on mobile its marker is already gone
  // (the adapter removes it even when the native delete fails).
  const isMarker = (key: string) =>
    key.startsWith(PRESENCE_SENTINEL_PREFIX) &&
    !leftovers.deleted.has(key.slice(PRESENCE_SENTINEL_PREFIX.length));
  const swept = await sweepStorage(keys, isMarker);
  swept.unresolved.forEach((key) => unresolved.add(key));
  const failedNames = new Set(leftovers.unresolved);
  for (const key of swept.spared)
    if (!failedNames.has(key.slice(PRESENCE_SENTINEL_PREFIX.length)))
      unresolved.add(key);
  if (unresolved.size > 0)
    throw new WipeIncompleteError([...unresolved].map(redactKeyName));
  await clearLeftoverRecord();
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
