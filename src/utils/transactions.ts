import { TransactionInfo } from '@/types/wallet';

/**
 * Deduplicate a list of transactions by their unique identifier.
 * Falls back to a composite key when id is missing to reduce duplication risk.
 */
export const dedupeTransactions = (
  transactions: TransactionInfo[]
): TransactionInfo[] => {
    const seen = new Set<string>();
    const result: TransactionInfo[] = [];

    for (const tx of transactions) {
      const fallbackKey = `${tx.assetId ?? 'na'}-${tx.timestamp ?? 'na'}-${tx.from ?? 'na'}-${tx.to ?? 'na'}-${tx.amount ?? 'na'}`;
      const key = tx.id || fallbackKey;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(tx);
    }

    return result;
};

