/**
 * Keyreg signing guard (TASK-439).
 *
 * On Algorand/Voi a key registration with nonParticipation=true marks the
 * account permanently non-participating: it can never register keys and go
 * online again. A normal "go offline" keyreg carries no participation fields
 * and no such flag. The wallet never builds one itself, and refuses to sign
 * one that a dApp, a remote-signer request or any other caller hands it.
 */

import algosdk from 'algosdk';

export class PermanentNonParticipationError extends Error {
  constructor() {
    super(
      'This key registration would permanently stop the account from ever going online again (nonParticipation). The wallet will not sign it.'
    );
    this.name = 'PermanentNonParticipationError';
  }
}

/**
 * Throws PermanentNonParticipationError for a keyreg with
 * nonParticipation=true. Accepts a decoded transaction or its unsigned
 * msgpack bytes (the Ledger path takes either).
 */
export function assertSignableKeyreg(
  transaction: algosdk.Transaction | Uint8Array
): void {
  const txn =
    transaction instanceof Uint8Array
      ? algosdk.decodeUnsignedTransaction(transaction)
      : transaction;
  if (
    txn.type === algosdk.TransactionType.keyreg &&
    txn.keyreg?.nonParticipation === true
  ) {
    throw new PermanentNonParticipationError();
  }
}
