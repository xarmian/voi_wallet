/**
 * Answers WalletConnect signing requests the transaction queue drops without
 * showing them (TASK-394), so the dApp gets an error instead of hanging until
 * its own timeout. Installed on the queue by the service boot via
 * `TransactionRequestQueue.setDroppedRequestHandler` (the queue itself must not
 * import the WalletConnect services: DR-2).
 *
 * The payloads match the user-decline path in TransactionRequestScreen
 * (code 5001 for v2; the v1 client's USER_REJECTED error), so a dApp that
 * handles a user rejection handles these too.
 */

import { WalletConnectService } from '@/services/walletconnect';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import { redactError } from '@/utils/logRedaction';
import {
  TransactionRequestQueue,
  type DroppedRequestReason,
  type QueuedTransactionRequest,
} from './TransactionRequestQueue';

export const DROPPED_REQUEST_ERROR_CODE = 5001;

export const DROPPED_REQUEST_MESSAGES: Record<DroppedRequestReason, string> = {
  full: 'Wallet busy: too many pending requests. Please retry.',
  expired: 'Request expired before it could be reviewed.',
};

const answer = async (
  entry: QueuedTransactionRequest,
  message: string
): Promise<void> => {
  if (entry.version === 1) {
    await WalletConnectV1Client.getInstance().rejectRequest(
      entry.id as number,
      message
    );
  } else {
    await WalletConnectService.getInstance().rejectRequest(
      entry.topic,
      entry.id as number,
      { code: DROPPED_REQUEST_ERROR_CODE, message }
    );
  }
};

/**
 * Fire-and-forget: sends one error response per entry and never throws back
 * into the queue. A failed send is logged (redacted) and its delivery mark is
 * forgotten, so a relay redelivery surfaces and the dApp can still get an
 * answer (the TASK-257 rule for a failed answer).
 */
export const answerDroppedRequests = (
  entries: QueuedTransactionRequest[],
  reason: DroppedRequestReason
): void => {
  const message = DROPPED_REQUEST_MESSAGES[reason];
  for (const entry of entries) {
    // answer() is async, so a synchronous throw inside it is a rejection too.
    answer(entry, message).catch((error) => {
      console.warn(
        `[WalletConnect] Failed to answer dropped request (${reason}):`,
        redactError(error)
      );
      // Only an answered drop's own mark: never one the UI set.
      TransactionRequestQueue.forgetDeliveryIfAnsweredDrop(
        entry.id,
        entry.topic
      );
    });
  }
};
