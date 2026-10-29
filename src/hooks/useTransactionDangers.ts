import { useEffect, useMemo, useState } from 'react';

import { NetworkService } from '@/services/network';
import type { NetworkId } from '@/types/network';
import {
  AssetAuthorities,
  DangerItem,
  resolveAssetAuthorityDangers,
} from '@/utils/transactionDangers';

/** A danger item with the index of the transaction it is in. */
export type IndexedDanger = DangerItem & { txnIndex: number };

/** One transaction's dangers and the network its asset lookups resolve on. */
export interface DangerEntry {
  /** Undefined for a transaction this review does not sign (pre-signed). */
  dangers?: DangerItem[];
  /** Undefined when the network can't be named: lookups then fail closed. */
  networkId?: NetworkId;
}

/**
 * The asset's current authority holders, read fresh from algod rather than
 * from the display-metadata cache: a stale holder would make a real hand-over
 * read as unchanged. Null when the asset can't be read.
 */
export const readAssetAuthorities = async (
  networkId: NetworkId,
  assetId: bigint
): Promise<AssetAuthorities | null> => {
  if (assetId > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  const info = await NetworkService.getInstance(networkId).getAssetInfo(
    Number(assetId)
  );
  const params = info?.params;
  if (!params) {
    return null;
  }
  return {
    manager: params.manager,
    reserve: params.reserve,
    freeze: params.freeze,
    clawback: params.clawback,
  };
};

const indexAll = (lists: (DangerItem[] | undefined)[]): IndexedDanger[] =>
  lists.flatMap((items, txnIndex) =>
    (items ?? []).map((item) => ({ ...item, txnIndex }))
  );

/**
 * Every dangerous operation across a batch, for the signing reviews (the
 * WalletConnect/universal screen and the remote signer share it, TASK-440 /
 * TASK-445). Asset-authority items start out unverified and are narrowed to
 * the roles that actually change once each asset's current holders are read
 * (resolveAssetAuthorityDangers). Narrowing only removes items or their
 * unverified mark, so an acknowledgment given earlier never covers more than
 * what is shown.
 */
export function useTransactionDangers(entries: DangerEntry[]): IndexedDanger[] {
  const pending = useMemo(
    () =>
      indexAll(
        entries.map((entry) =>
          entry.dangers?.map((item) =>
            item.kind === 'assetAuthority' ||
            item.kind === 'assetAuthorityRemoved'
              ? { ...item, unverified: true }
              : item
          )
        )
      ),
    [entries]
  );
  const [resolved, setResolved] = useState<{
    entries: DangerEntry[];
    items: IndexedDanger[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const reads = new Map<string, Promise<AssetAuthorities | null>>();
    const lookupOn =
      (networkId: NetworkId | undefined) =>
      (assetId: bigint): Promise<AssetAuthorities | null> => {
        if (!networkId) {
          return Promise.resolve(null);
        }
        const key = `${networkId}:${assetId}`;
        let read = reads.get(key);
        if (!read) {
          read = readAssetAuthorities(networkId, assetId);
          reads.set(key, read);
        }
        return read;
      };
    (async () => {
      const lists = await Promise.all(
        entries.map((entry) =>
          entry.dangers
            ? resolveAssetAuthorityDangers(
                entry.dangers,
                lookupOn(entry.networkId)
              )
            : Promise.resolve(undefined)
        )
      );
      if (!cancelled) {
        setResolved({ entries, items: indexAll(lists) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entries]);

  return resolved && resolved.entries === entries ? resolved.items : pending;
}
