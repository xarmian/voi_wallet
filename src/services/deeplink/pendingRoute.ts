/**
 * Cold-start route delivery seam (DR-10 / TASK-381).
 *
 * Under the UIScene lifecycle (Expo SDK 58) the initial URL and the launch
 * notification response can be available to JS before the NavigationContainer
 * has mounted its first navigator. The old code waited 100 ms for
 * `navigationRef.isReady()` and then DROPPED the route. This module instead
 * decides WHEN an existing routing call runs; it never decides HOW to route.
 *
 *  - `deliver(key, run)` queues `run` until `isReady()` is true, then runs the
 *    queue in arrival order, awaiting each `run` to completion before starting
 *    the next.
 *  - It dedupes by `key` (the URL or the notification identifier): a key that
 *    is queued, running, or finished within `dedupeWindowMs` is not run again.
 *    This is what lets `Linking.getInitialURL()` and the first `url` event for
 *    the same URL run exactly once.
 *  - If readiness has not arrived after `readyTimeoutMs` it LOGS and keeps
 *    waiting: a late-ready container still gets every queued route. Nothing
 *    queued is ever dropped.
 *
 * Keys may embed secrets (a WalletConnect pairing URI carries `symKey`), so
 * this module never logs a key; it lives only in memory for the dedupe window.
 *
 * Pure: readiness is injected, so it is unit-testable without React
 * Navigation (src/services/deeplink/__tests__/pendingRoute.test.ts).
 */

export type RouteRun = () => Promise<void> | void;

export interface PendingRouteDeps {
  /** True when the navigation container can accept navigation actions. */
  isReady: () => boolean;
  /**
   * Subscribe to "readiness may have changed" signals. Returns an
   * unsubscribe function. The callback may fire spuriously; `isReady()` is
   * always re-checked.
   */
  onReady: (cb: () => void) => () => void;
  /** Log (not drop) when still not ready after this long. Default 10 s. */
  readyTimeoutMs?: number;
  /** How long a completed key keeps suppressing duplicates. Default 5 s. */
  dedupeWindowMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Logger, injectable for tests. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface PendingRouteQueue {
  /**
   * Run `run` once navigation is ready, after every earlier delivery has
   * settled. Resolves when `run` has settled (or immediately for a duplicate
   * key). Never rejects: a throwing `run` is logged and the queue moves on.
   */
  deliver: (key: string, run: RouteRun) => Promise<void>;
  /**
   * Resolves once navigation is ready (immediately if it already is). Not
   * serialized with `deliver`; used by the routing call itself so it never
   * navigates into a container that is not mounted. Logs on the same timeout
   * as `deliver` and keeps waiting.
   */
  whenReady: () => Promise<void>;
}

interface QueuedItem {
  key: string;
  run: RouteRun;
  resolve: () => void;
}

export const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_DEDUPE_WINDOW_MS = 5_000;

export function createPendingRouteQueue(
  deps: PendingRouteDeps
): PendingRouteQueue {
  const {
    isReady,
    onReady,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
    now = Date.now,
    logger = console,
  } = deps;

  const queue: QueuedItem[] = [];
  /** Keys queued or running. */
  const active = new Set<string>();
  /** Completed keys -> completion time, for the dedupe window. */
  const completed = new Map<string, number>();
  const readyWaiters: (() => void)[] = [];

  let draining = false;
  let unsubscribe: (() => void) | null = null;
  let readyTimer: ReturnType<typeof setTimeout> | null = null;

  const safeIsReady = (): boolean => {
    try {
      return isReady();
    } catch {
      return false;
    }
  };

  const pruneCompleted = () => {
    const cutoff = now() - dedupeWindowMs;
    for (const [key, at] of completed) {
      if (at < cutoff) completed.delete(key);
    }
  };

  const stopWaiting = () => {
    if (unsubscribe) {
      const unsub = unsubscribe;
      unsubscribe = null;
      try {
        unsub();
      } catch {}
    }
    if (readyTimer) {
      clearTimeout(readyTimer);
      readyTimer = null;
    }
  };

  const onReadySignal = () => {
    if (!safeIsReady()) return;
    stopWaiting();
    readyWaiters.splice(0).forEach((resolve) => resolve());
    void drain();
  };

  /** Subscribe for readiness (once) while anything is waiting on it. */
  const waitForReady = () => {
    if (unsubscribe) return;
    unsubscribe = onReady(onReadySignal);
    if (!readyTimer) {
      readyTimer = setTimeout(() => {
        readyTimer = null;
        if (safeIsReady()) {
          // A readiness signal was missed; recover rather than wait forever.
          onReadySignal();
          return;
        }
        logger.error(
          `[PendingRoute] Navigation still not ready after ${readyTimeoutMs}ms; ${queue.length} route(s) stay queued and will be delivered when it is`
        );
      }, readyTimeoutMs);
    }
    // The signal may have fired between the caller's isReady() check and the
    // subscription; re-check so it is not missed.
    if (safeIsReady()) onReadySignal();
  };

  const runOne = async (item: QueuedItem) => {
    try {
      await item.run();
    } catch (error) {
      logger.error(
        '[PendingRoute] Route handler failed:',
        error instanceof Error ? error.message : 'unknown error'
      );
    } finally {
      active.delete(item.key);
      completed.set(item.key, now());
      item.resolve();
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    let needReady = false;
    try {
      while (queue.length > 0) {
        if (!safeIsReady()) {
          needReady = true;
          break;
        }
        await runOne(queue.shift()!);
      }
    } finally {
      draining = false;
    }
    // Subscribe only after `draining` is cleared: the subscription re-checks
    // readiness synchronously and may re-enter drain().
    if (needReady) waitForReady();
  };

  const deliver = (key: string, run: RouteRun): Promise<void> => {
    pruneCompleted();
    if (active.has(key) || completed.has(key)) {
      logger.log('[PendingRoute] Duplicate route ignored');
      return Promise.resolve();
    }
    active.add(key);
    return new Promise<void>((resolve) => {
      queue.push({ key, run, resolve });
      if (!draining && !safeIsReady()) {
        logger.warn('[PendingRoute] Navigation not ready; route queued');
      }
      void drain();
    });
  };

  const whenReady = (): Promise<void> => {
    if (safeIsReady()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      readyWaiters.push(resolve);
      waitForReady();
    });
  };

  return { deliver, whenReady };
}
