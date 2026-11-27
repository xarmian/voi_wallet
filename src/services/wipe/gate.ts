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
 *
 * The wipe window is open from the resets until the wipe call settles. A
 * capture taken while it is open counts as wiped for good: a load or write
 * that starts during a wipe may read data the wipe has not deleted yet, so it
 * must not install or persist it, even after the wipe ends.
 */

export type WipeReset = () => void | Promise<unknown>;

const resets = new Map<string, WipeReset>();
let epoch = 0;
let windowOpen = false;
let windowWaiters: (() => void)[] = [];

/** What wipeEpoch returns while the wipe window is open. Never a real epoch. */
const DURING_WIPE = -1;

/** The current wipe epoch. Capture it before an await; check with wipedSince. */
export function wipeEpoch(): number {
  return windowOpen ? DURING_WIPE : epoch;
}

/**
 * True when a wipe started after `captured` was read, or `captured` was read
 * while a wipe was running.
 */
export function wipedSince(captured: number): boolean {
  return epoch !== captured;
}

/** Open the wipe window. The wipe calls this right before the resets. */
export function openWipeWindow(): void {
  windowOpen = true;
}

/** Close the wipe window. The wipe calls this when it settles, either way. */
export function closeWipeWindow(): void {
  windowOpen = false;
  const waiters = windowWaiters;
  windowWaiters = [];
  waiters.forEach((resolve) => resolve());
}

/** True from the wipe's resets until the wipe settles. */
export function isWipeWindowOpen(): boolean {
  return windowOpen;
}

/** Resolves when no wipe window is open (at once when none is). */
export function wipeWindowClosed(): Promise<void> {
  if (!windowOpen) return Promise.resolve();
  return new Promise((resolve) => windowWaiters.push(resolve));
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
