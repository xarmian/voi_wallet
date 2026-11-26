import { withTimeout } from '@/utils/withTimeout';

/**
 * Wall-clock deadline for one messaging network request (a Supabase query or
 * an indexer call). Neither client supports abort, and the messages store keeps
 * a per-account in-flight guard across them, so a request that never settles
 * would suppress every later poll and refresh until the app restarts.
 */
export const MESSAGING_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Bound `request` by MESSAGING_REQUEST_TIMEOUT_MS. A timeout rejects like any
 * other failed request, so each caller's existing failure path applies (Mimir
 * falls back to the indexer; the indexer surfaces a load error). A response
 * that lands after the deadline is discarded.
 *
 * Accepts a PromiseLike because Supabase query builders are thenables.
 */
export function withMessagingDeadline<T>(
  request: PromiseLike<T>,
  what: string
): Promise<T> {
  return withTimeout(
    Promise.resolve(request),
    MESSAGING_REQUEST_TIMEOUT_MS,
    () => new Error(`Messaging request timed out: ${what}`)
  );
}
