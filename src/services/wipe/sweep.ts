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

export interface SweepResult {
  /** Keys still present after the retry (STORAGE_KEYS_NAME when storage could not be listed). */
  unresolved: string[];
  /** Spared keys present at the last listing. */
  spared: string[];
}

/**
 * TASK-469: remove every general-storage key that is not kept (and not
 * spared), then list storage again. A key still there gets one more remove,
 * and is unresolved if it is still there after that. `keys` is the caller's
 * listing, taken after every in-memory reset ran; the read-back applies the
 * same rules to keys that were not in it.
 */
export async function sweepStorage(
  keys: string[],
  spare: (key: string) => boolean
): Promise<SweepResult> {
  const doomed = (list: string[]) =>
    list.filter((key) => !isKeptKey(key) && !spare(key));
  await removeInBatches(doomed(keys));
  for (let pass = 0; ; pass += 1) {
    let listed: string[];
    try {
      listed = await listStorageKeys();
    } catch {
      return { unresolved: [STORAGE_KEYS_NAME], spared: [] };
    }
    const left = doomed(listed);
    if (left.length === 0 || pass === 1)
      return {
        unresolved: left,
        spared: listed.filter((key) => !isKeptKey(key) && spare(key)),
      };
    await removeInBatches(left);
  }
}
