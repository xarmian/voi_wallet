import type { ExitReason } from './requestCoordinator';

export interface ResultDescription {
  title: string;
  message?: string;
}

export type ResultKind = 'request' | 'proposal';

const ENDED: ResultDescription = { title: 'Request ended' };

// Every string here already exists in the signing controller and the connect
// review. A request is always a signing request (algo_signTxn is the only
// method with a handler); a proposal has no decline string, so it stays neutral.
export function describeClose(
  reason: ExitReason,
  kind: ResultKind
): ResultDescription {
  if (kind === 'request' && reason === 'declined') {
    return {
      title: 'Transaction Request Rejected',
      message: 'You can return to the dApp.',
    };
  }
  return ENDED;
}

export function describeApproved(kind: ResultKind): ResultDescription {
  return kind === 'request'
    ? {
        title: 'Transaction Signed Successfully',
        message: 'You can now return to the dApp.',
      }
    : { title: 'Success', message: 'Successfully connected to dApp' };
}
