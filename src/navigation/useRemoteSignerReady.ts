import { useEffect } from 'react';
import { useRemoteSignerStore } from '@/store/remoteSignerStore';
import { wipeEpoch, wipeWindowClosed, wipedSince } from '@/services/wipe/gate';

/**
 * The remote-signer store's `isInitialized`, initializing the store whenever it
 * reports uninitialized while the caller is mounted: on mount, and again after
 * a wipe resets it (TASK-469). The navigator stays mounted under the lock
 * overlay, so a one-shot start from the first mount would leave it waiting on
 * a store nobody initializes.
 *
 * It starts nothing while a wipe runs (a read then sees data being deleted),
 * and starts again if a wipe dropped the pass it waited on. initialize()
 * coalesces concurrent calls, so a second caller joins the pass under way.
 */
export function useRemoteSignerReady(): boolean {
  const isInitialized = useRemoteSignerStore((state) => state.isInitialized);

  useEffect(() => {
    if (isInitialized) return;
    let active = true;
    const run = async () => {
      while (active && !useRemoteSignerStore.getState().isInitialized) {
        await wipeWindowClosed();
        if (!active) return;
        const epoch = wipeEpoch();
        await useRemoteSignerStore.getState().initialize();
        // Only a wipe leaves the store uninitialized after a pass; anything
        // else would repeat the same result, so stop rather than spin.
        if (!wipedSince(epoch)) return;
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [isInitialized]);

  return isInitialized;
}
