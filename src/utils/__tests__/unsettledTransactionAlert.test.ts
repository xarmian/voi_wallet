/**
 * TASK-447: a transaction that was, or may have been, submitted and is not
 * confirmed renders as its own state, never as a failure and never as an
 * invitation to retry.
 *
 * toUnsettledTransactionAlert is the switch every caller branches on, so it has
 * to recognise both outcomes after the wrapping they get on the way to a screen
 * (SecureTransactionManager prefixes the message; the remote-signer controller
 * rebuilds a plain Error from the message), and must stay silent for genuine
 * failures, which keep their caller's rendering.
 */

import {
  PENDING_TRANSACTION_ALERT,
  toErrorAlert,
  toUnsettledTransactionAlert,
} from '../errorMapping';
import {
  TransactionExpiredError,
  TransactionMaybeSubmittedError,
  TransactionPendingError,
  TransactionRejectedError,
} from '@/types/network';

const TXID = 'PENDINGTXID';

const neverFailureCopy = (alert: { title: string; message: string }) => {
  const text = `${alert.title} ${alert.message}`.toLowerCase();
  expect(text).not.toMatch(/fail|try again|retry|resend|send it again/);
};

describe('toUnsettledTransactionAlert', () => {
  it('renders a pending transaction as Not Confirmed Yet', () => {
    const alert = toUnsettledTransactionAlert(
      new TransactionPendingError(TXID)
    );

    expect(alert?.title).toBe('Not Confirmed Yet');
    expect(alert?.message).toContain('may still be committed');
    neverFailureCopy(alert!);
  });

  it('renders a maybe-submitted transaction as May Have Been Sent', () => {
    const alert = toUnsettledTransactionAlert(
      new TransactionMaybeSubmittedError()
    );

    expect(alert?.title).toBe('May Have Been Sent');
    expect(alert?.message).toContain('may already have been submitted');
    neverFailureCopy(alert!);
  });

  it('still recognises both after their class is lost on the way to a screen', () => {
    const prefixed = new Error(
      `Secure transaction failed: ${new TransactionPendingError(TXID).message}`
    );
    const rebuilt = new Error(new TransactionMaybeSubmittedError().message);

    expect(toUnsettledTransactionAlert(prefixed)?.title).toBe(
      'Not Confirmed Yet'
    );
    expect(toUnsettledTransactionAlert(rebuilt)?.title).toBe(
      'May Have Been Sent'
    );
  });

  it.each([
    ['an expired transaction', new TransactionExpiredError(TXID, 100n)],
    ['a rejected transaction', new TransactionRejectedError(TXID, 'overspend')],
    [
      'an algod overspend',
      new Error('TransactionPool.Remember: transaction X: overspend'),
    ],
    ['an unknown error', new Error('boom')],
    ['no error at all', undefined],
  ])('is undefined for %s, which keeps its failure rendering', (_, error) => {
    expect(toUnsettledTransactionAlert(error)).toBeUndefined();
  });
});

describe('PENDING_TRANSACTION_ALERT', () => {
  it('is the same copy a TransactionPendingError maps to', () => {
    expect(PENDING_TRANSACTION_ALERT).toEqual(
      toErrorAlert(new TransactionPendingError(TXID))
    );
    neverFailureCopy(PENDING_TRANSACTION_ALERT);
  });
});
