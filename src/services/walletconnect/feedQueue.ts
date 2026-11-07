import { RequestCoordinator } from './requestCoordinator';
import { RequestQueue } from './requestQueue';
import type { QueueItem } from './requestQueue';

export type FeedOutcome = Awaited<ReturnType<RequestQueue['push']>>;

/**
 * The one place an arrival that the coordinator has admitted ('show') enters
 * the review queue. Every producer (v2 proposal, v2 request, v1 request, v1
 * proposal) calls this and nothing else, so the outcomes are decided once:
 *
 * - 'head' / 'queued': the host draws it; nothing more to do.
 * - 'duplicate' / 'not-open': the coordinator already owns the answer (a
 *   second arrival of an open ref, or a ref closed between admit and push).
 * - 'full': the waiting list is at its limit and the queue took nothing, so
 *   the dApp is answered 'busy' through the coordinator, once.
 *
 * It never calls coordinator.release(): release clears every listener on the
 * entry, the queue's and the review's, so after a push it would leave a head
 * that no coordinator close could finish.
 */
export async function feedQueue(
  item: Omit<QueueItem, 'arrivalSeq' | 'kind'>,
  deps: {
    queue?: RequestQueue;
    coordinator?: RequestCoordinator;
  } = {}
): Promise<FeedOutcome> {
  const queue = deps.queue ?? RequestQueue.getInstance();
  const outcome = queue.push(item);
  if (outcome === 'full') {
    const coordinator = deps.coordinator ?? RequestCoordinator.getInstance();
    try {
      await coordinator.settle(item.ref, 'busy');
    } catch {
      // The request is closed in the coordinator whatever the answer does;
      // the deadline bounds anything left unanswered.
      console.warn('WalletConnect request could not be answered as busy');
    }
  }
  return outcome;
}
