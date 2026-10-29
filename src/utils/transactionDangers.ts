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

export const ASSET_AUTHORITY_ROLES = [
  'manager',
  'reserve',
  'freeze',
  'clawback',
] as const;
export type AssetAuthorityRole = (typeof ASSET_AUTHORITY_ROLES)[number];

/**
 * One dangerous operation in one transaction (TASK-440 audit #1, #2). A batch
 * review lists EVERY item; the old per-kind aggregate kept only the first
 * target of each kind, so a later, attacker-chosen rekey or close-out in the
 * same batch was signed under a warning that named an earlier one.
 */
export type DangerItem = {
  /** Sender of the transaction the operation is in. */
  sender?: string;
} & (
  | { kind: 'rekey' | 'closeAccount' | 'closeAsset'; target: string }
  | {
      /** Reconfiguring an existing asset hands this authority to `target`. */
      kind: 'assetAuthority';
      assetId: bigint;
      role: AssetAuthorityRole;
      target: string;
    }
  | {
      /** Reconfiguring an existing asset clears this authority, for good. */
      kind: 'assetAuthorityRemoved';
      assetId: bigint;
      role: AssetAuthorityRole;
    }
  | { kind: 'assetDestroy'; assetId: bigint }
);

/**
 * Every dangerous operation in one decoded transaction, in a fixed order.
 * Includes asset-configuration changes to an EXISTING asset (audit #2): on
 * Algorand a reconfiguration sets each of manager/reserve/freeze/clawback to
 * the given address and clears (permanently) any it omits, and one with no
 * fields at all destroys the asset. Asset creation (index 0) is not a danger.
 */
export const describeTransactionDangers = (txn: any): DangerItem[] => {
  if (!txn) return [];
  const sender = encodeMaybeAddress(txn.sender);
  const items: DangerItem[] = [];
  const basic = detectTransactionDangers(txn);
  if (basic.rekeyTo) {
    items.push({ sender, kind: 'rekey', target: basic.rekeyTo });
  }
  if (basic.closeRemainderTo) {
    items.push({
      sender,
      kind: 'closeAccount',
      target: basic.closeRemainderTo,
    });
  }
  if (basic.assetCloseTo) {
    items.push({ sender, kind: 'closeAsset', target: basic.assetCloseTo });
  }
  const acfg = txn.assetConfig;
  const assetId =
    acfg?.assetIndex !== undefined ? BigInt(acfg.assetIndex) : undefined;
  if (acfg && assetId !== undefined && assetId !== 0n) {
    const holders = ASSET_AUTHORITY_ROLES.map(
      (role) => [role, encodeMaybeAddress(acfg[role])] as const
    );
    if (holders.every(([, target]) => !target)) {
      items.push({ sender, kind: 'assetDestroy', assetId });
    } else {
      for (const [role, target] of holders) {
        items.push(
          target
            ? { sender, kind: 'assetAuthority', assetId, role, target }
            : { sender, kind: 'assetAuthorityRemoved', assetId, role }
        );
      }
    }
  }
  return items;
};
