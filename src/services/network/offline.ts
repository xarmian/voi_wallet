/**
 * Offline gate (TASK-191).
 *
 * A synchronously-readable snapshot of connectivity, so a retry ladder can be
 * skipped outright while the device is offline instead of burning every attempt
 * (and its backoff) on a fetch that cannot succeed.
 *
 * Read through the platform `ConnectivityAdapter` (PLAN-12 DR-7) only — this
 * module is shared code, so it must never import NetInfo (a native module) or
 * branch on `Platform.OS` itself.
 *
 * Three states, not two. `connectivity.getState()` is async and the first
 * subscription callback has not necessarily fired yet, so before either
 * settles the snapshot is `unknown`. **`unknown` reads as online (fail open)**:
 * a probe that never resolves, or an adapter that throws, must never wedge the
 * app into believing it is permanently offline. Only a definite `offline`
 * gates anything. The cost is that the first few calls after a cold launch may
 * go out ungated, which is the correct trade.
 *
 * Priming is lazy and self-contained: the first read registers the
 * subscription and kicks off one `getState()`. Nothing needs to call this from
 * app bootstrap.
 */

import { connectivity, isOffline } from '@/platform';

/** `unknown` = not yet determined; treated as online everywhere below. */
export type Reachability = 'online' | 'offline' | 'unknown';

/**
 * Call sites that can skip work while offline. A closed literal union keeps
 * the counters below free of anything user-identifying — the only thing
 * recorded is which code path skipped, and how many times.
 */
export type OfflineSkipScope =
  | 'mimir'
  | 'voi-price'
  | 'algorand-price'
  | 'envoi'
  | 'messages-poll'
  | 'home-refresh';

const SKIP_SCOPES: readonly OfflineSkipScope[] = [
  'mimir',
  'voi-price',
  'algorand-price',
  'envoi',
  'messages-poll',
  'home-refresh',
];

export interface OfflineCounters {
  /** Total network attempts skipped because the device was offline. */
  offlineSkips: number;
  /** Skips broken down by call site. Counts only — no identifiers. */
  offlineSkipsByScope: Record<OfflineSkipScope, number>;
}

let reachability: Reachability = 'unknown';
let primed = false;
let unsubscribe: (() => void) | null = null;

const skipCounts = new Map<OfflineSkipScope, number>();

function prime(): void {
  if (primed) return;
  primed = true;

  try {
    unsubscribe = connectivity.subscribe((state) => {
      reachability = isOffline(state) ? 'offline' : 'online';
    });
  } catch {
    // No adapter available (or it threw on registration). Stay `unknown`,
    // which reads as online, rather than guessing offline.
  }

  try {
    void connectivity
      .getState()
      .then((state) => {
        // Only fills the initial gap. A subscription callback that already
        // landed is fresher than this in-flight probe, so it wins.
        if (reachability === 'unknown') {
          reachability = isOffline(state) ? 'offline' : 'online';
        }
      })
      .catch(() => {
        // Undeterminable connectivity stays `unknown` → online.
      });
  } catch {
    // Same: a throwing adapter must not change the answer.
  }
}

/**
 * Current snapshot, priming the subscription on first read.
 * Returns `unknown` until the adapter has answered at least once.
 */
export function getReachability(): Reachability {
  prime();
  return reachability;
}

/**
 * True only when connectivity is *definitely* offline. `unknown` is false.
 */
export function isDefinitelyOffline(): boolean {
  return getReachability() === 'offline';
}

/**
 * The gate itself: `true` means "do not attempt the network", and records the
 * skip. Combining the check and the counter keeps them from drifting apart.
 */
export function shouldSkipForOffline(scope: OfflineSkipScope): boolean {
  if (!isDefinitelyOffline()) return false;
  skipCounts.set(scope, (skipCounts.get(scope) ?? 0) + 1);
  return true;
}

/**
 * In-memory observability for the debug surface. Counts only: no addresses, no
 * amounts, no identifiers — `babel.config.js` strips `console.log` from release
 * bundles precisely because logs can carry those, and this must not become a
 * way around that.
 */
export function getOfflineCounters(): OfflineCounters {
  const offlineSkipsByScope = {} as Record<OfflineSkipScope, number>;
  let offlineSkips = 0;

  for (const scope of SKIP_SCOPES) {
    const count = skipCounts.get(scope) ?? 0;
    offlineSkipsByScope[scope] = count;
    offlineSkips += count;
  }

  return { offlineSkips, offlineSkipsByScope };
}

/** Reset counters only, leaving the connectivity subscription in place. */
export function resetOfflineCounters(): void {
  skipCounts.clear();
}

/**
 * Full reset — drops the subscription and the snapshot as well. For tests.
 */
export function resetOfflineGate(): void {
  unsubscribe?.();
  unsubscribe = null;
  primed = false;
  reachability = 'unknown';
  skipCounts.clear();
}
