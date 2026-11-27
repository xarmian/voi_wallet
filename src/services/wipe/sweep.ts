import { storage } from '@/platform';
import { WRITE_TIMEOUT_MS } from '@/services/secure/boundedWrites';
import { withTimeout } from '@/utils/withTimeout';
import { isKeptKey } from './allowList';

/** Keys removed per storage call. */
export const SWEEP_BATCH_SIZE = 50;

/** Name reported when general storage could not be listed. */
export const STORAGE_KEYS_NAME = 'storage_keys';

/** Every general-storage key, bounded. Rejects on a failure or a timeout. */
export function listStorageKeys(): Promise<string[]> {
  return withTimeout(
    storage.getAllKeys(),
    WRITE_TIMEOUT_MS,
    () => new Error('storage listing timed out')
  );
}

/** Remove `keys` in bounded batches; a failed batch does not stop the rest. */
async function removeInBatches(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += SWEEP_BATCH_SIZE) {
    try {
      await withTimeout(
        storage.multiRemove(keys.slice(i, i + SWEEP_BATCH_SIZE)),
        WRITE_TIMEOUT_MS,
        () => new Error('storage remove timed out')
      );
    } catch {
      // The read-back below finds whatever this batch left.
    }
  }
}

/**
 * TASK-469: remove every general-storage key that is not kept (and not in
 * `spare`), then list storage again. A key still there gets one more remove,
 * and is unresolved if it is still there after that. Returns the unresolved key
 * names (STORAGE_KEYS_NAME when storage could not be listed). `keys` is the
 * caller's listing, taken after every in-memory reset ran.
 */
export async function sweepStorage(
  keys: string[],
  spare: ReadonlySet<string>
): Promise<string[]> {
  const doomed = (list: string[]) =>
    list.filter((key) => !isKeptKey(key) && !spare.has(key));
  await removeInBatches(doomed(keys));
  for (let pass = 0; ; pass += 1) {
    let left: string[];
    try {
      left = doomed(await listStorageKeys());
    } catch {
      return [STORAGE_KEYS_NAME];
    }
    if (left.length === 0 || pass === 1) return left;
    await removeInBatches(left);
  }
}
