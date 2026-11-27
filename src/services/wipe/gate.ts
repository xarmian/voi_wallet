/**
 * TASK-469 / TASK-492: in-memory resets for a wipe, and the wipe epoch.
 *
 * Dependency-free so any store can register without an import cycle. A module
 * registers its reset when it loads; a module that never loaded holds nothing
 * in memory, so it has nothing to reset.
 *
 * A reset sets the module back to its initial state WITHOUT persisting. It may
 * return a promise for local cleanup that has to settle before storage is
 * swept (the WalletConnect purge); the wipe bounds it and reports a rejection
 * or timeout as unresolved.
 *
 * The epoch moves once per wipe, before any reset runs. A write that captured
 * the epoch before an await skips its write if the epoch has moved since
 * (`wipedSince`), so data read before the wipe is not written back after it.
 */

export type WipeReset = () => void | Promise<unknown>;

const resets = new Map<string, WipeReset>();
let epoch = 0;

/** The current wipe epoch. Capture it before an await; check with wipedSince. */
export function wipeEpoch(): number {
  return epoch;
}

/** True when a wipe started after `captured` was read. */
export function wipedSince(captured: number): boolean {
  return epoch !== captured;
}

/**
 * Register `reset` under `name` (one per name; a later one replaces it).
 * Returns an unregister function that removes only this reset.
 */
export function registerWipeReset(name: string, reset: WipeReset): () => void {
  resets.set(name, reset);
  return () => {
    if (resets.get(name) === reset) resets.delete(name);
  };
}

export interface WipeResetRun {
  /** Resets that threw. */
  failed: string[];
  /** Resets that returned a promise, still settling. */
  pending: { name: string; done: Promise<unknown> }[];
}

/**
 * Move the epoch, then run every registered reset synchronously. A throwing
 * reset does not stop the others.
 */
export function runWipeResets(): WipeResetRun {
  epoch += 1;
  const run: WipeResetRun = { failed: [], pending: [] };
  for (const [name, reset] of [...resets]) {
    try {
      const result = reset();
      if (result && typeof (result as Promise<unknown>).then === 'function')
        run.pending.push({ name, done: result as Promise<unknown> });
    } catch {
      run.failed.push(name);
    }
  }
  return run;
}
