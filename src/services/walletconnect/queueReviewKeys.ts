import {
  walletConnectProposalKey,
  walletConnectRequestKey,
  walletConnectV1ProposalKey,
} from '@/services/auth/reviewGrant';
import { RequestCoordinator } from './requestCoordinator';
import { RequestQueue } from './requestQueue';
import type { QueueItem, QueueSnapshot } from './requestQueue';

interface Deps {
  queue?: { getSnapshot(): QueueSnapshot };
  coordinator?: { isOpen(ref: QueueItem['ref']): boolean };
}

/**
 * The review-grant key the item's own review checks. Each branch calls the
 * function the review screen or sign controller calls, so a key can never
 * drift from the one it must match.
 */
export function reviewKeyFor(item: QueueItem): string {
  const { ref } = item;
  if (ref.kind === 'request') return walletConnectRequestKey(ref.topic, ref.id);
  if (ref.version === 1) {
    return walletConnectV1ProposalKey(
      (item.payload as { peerId?: string } | null | undefined)?.peerId
    );
  }
  return walletConnectProposalKey(ref.topic, ref.id);
}

/**
 * Keys for every item still open in front of the person: the head and the
 * waiting list. A result card and an item the coordinator already settled get
 * no key, because there is nothing left to review.
 */
export function openReviewKeys(deps: Deps = {}): string[] {
  const queue = deps.queue ?? RequestQueue.getInstance();
  const coordinator = deps.coordinator ?? RequestCoordinator.getInstance();
  const { head, waiting } = queue.getSnapshot();
  const items = head ? [head, ...waiting] : [...waiting];
  return items.filter((item) => coordinator.isOpen(item.ref)).map(reviewKeyFor);
}
