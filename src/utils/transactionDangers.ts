import algosdk from 'algosdk';

export interface TransactionDangers {
  /** Account's signing authority is transferred to this address (takeover). */
  rekeyTo?: string;
  /** Entire remaining native balance is swept here and the account closed. */
  closeRemainderTo?: string;
  /** Entire remaining balance of the asset is swept to this address. */
  assetCloseTo?: string;
}

const encodeMaybeAddress = (value: any): string | undefined => {
  if (!value) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (value.publicKey) {
    try {
      return algosdk.encodeAddress(new Uint8Array(value.publicKey));
    } catch {
      return undefined;
    }
  }
  return undefined;
};

/**
 * Extract the authority-transfer / balance-sweep fields from a decoded algosdk
 * v3 Transaction. These are the fields a malicious dApp/deeplink can hide behind
 * a normal-looking payment (S-01). Robust to Address objects or string addrs.
 */
export const detectTransactionDangers = (txn: any): TransactionDangers => {
  if (!txn) return {};
  return {
    rekeyTo: encodeMaybeAddress(txn.rekeyTo),
    closeRemainderTo: encodeMaybeAddress(txn.payment?.closeRemainderTo),
    // NOTE: algosdk v3 stores the asset close-out under assetTransfer.closeRemainderTo
    // (same field name as a payment close), NOT `assetCloseTo`. Reading the wrong
    // name would silently miss asset-drain transactions.
    assetCloseTo: encodeMaybeAddress(txn.assetTransfer?.closeRemainderTo),
  };
};

export const hasAnyDanger = (d?: TransactionDangers | null): boolean =>
  !!(d && (d.rekeyTo || d.closeRemainderTo || d.assetCloseTo));

/** Aggregate the first target of each danger kind across many transactions. */
export const aggregateDangers = (
  list: TransactionDangers[]
): TransactionDangers => ({
  rekeyTo: list.find((d) => d.rekeyTo)?.rekeyTo,
  closeRemainderTo: list.find((d) => d.closeRemainderTo)?.closeRemainderTo,
  assetCloseTo: list.find((d) => d.assetCloseTo)?.assetCloseTo,
});
