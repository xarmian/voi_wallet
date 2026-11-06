/**
 * Answers signing requests dropped by the queue through the coordinator,
 * recording the decision before publishing. The queue never imports services.
 */
import { redactError } from '@/utils/logRedaction';
import type {
  DroppedRequestReason,
  QueuedTransactionRequest,
} from './TransactionRequestQueue';
import { RequestCoordinator } from './requestCoordinator';
import { requestRefFor } from './requestRefs';

/** A failed publish stays handled; coordinator admission can answer a replay. */
export const answerDroppedRequests = (
  entries: QueuedTransactionRequest[],
  reason: DroppedRequestReason
): void => {
  for (const entry of entries) {
    void RequestCoordinator.getInstance()
      .settle(
        requestRefFor(entry, entry.version === 1 ? 1 : 2),
        reason === 'full' ? 'busy' : 'expired'
      )
      .catch((error: unknown) => {
        console.warn(
          `[WalletConnect] Failed to answer dropped request (${reason}):`,
          redactError(error)
        );
      });
  }
};
