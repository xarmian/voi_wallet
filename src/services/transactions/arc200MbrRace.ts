import algosdk from 'algosdk';
import type { Arc200TransactionGroup } from './arc200';

export const ARC200_RECONFIRM_MESSAGE =
  'Network state changed, please confirm again.';

// algod checks modified accounts after executing the app (including box creates).
// Match its exact minimum-balance rejection AND an escrow in the reviewed group.
// Sender shortfalls, AVM box/resource errors and transport failures are unrelated.
// Source: go-algorand ledger/eval/eval.go checkMinBalance (MinBalanceError).
export function isArc200MbrRace(error: unknown, group: Arc200TransactionGroup) {
  if (!(error instanceof Error)) return false;
  const match =
    /account ([A-Z2-7]{58}) balance (\d+) below min (\d+) \(\d+ assets\)/.exec(
      error.message
    );
  if (!match || BigInt(match[2]) >= BigInt(match[3])) return false;
  const isEscrow = group.transactions.some((txn) => {
    const appId = txn.applicationCall?.appIndex;
    return (
      appId && algosdk.getApplicationAddress(appId).toString() === match[1]
    );
  });
  const funded = group.transactions.some(
    (txn) =>
      txn.payment?.receiver.toString() === match[1] &&
      txn.payment.amount >= 28500n
  );
  return isEscrow && !funded;
}

// Match algod's round-range rejection, and only an expired range in this group.
export function isArc200ExpiredGroup(
  error: unknown,
  group: Arc200TransactionGroup
) {
  if (!(error instanceof Error)) return false;
  const match =
    /(?:txn|transaction) dead: round (\d+) outside of (\d+)--(\d+)/.exec(
      error.message
    );
  return (
    !!match &&
    BigInt(match[1]) > BigInt(match[3]) &&
    group.transactions.some(
      (txn) =>
        txn.firstValid === BigInt(match[2]) &&
        txn.lastValid === BigInt(match[3])
    )
  );
}
