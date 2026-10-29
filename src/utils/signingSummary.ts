import { AssetParams } from '@/types/wallet';
import { formatBaseUnitsToAmount } from './bigint';

export function safeDappText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .trim()
    .slice(0, 60);
}

export function signingSummary(
  transactions: { amount?: bigint; to?: string; assetId?: bigint }[],
  currency: string | null,
  assets: Record<string, AssetParams | null>,
  dapp = 'the dApp'
): string {
  const txn = transactions[0];
  if (transactions.length === 1 && txn.amount !== undefined && txn.to) {
    let amount: string;
    if (txn.assetId && txn.assetId > 0n) {
      const asset = assets[txn.assetId.toString()];
      amount = asset
        ? `${formatBaseUnitsToAmount(txn.amount, asset.decimals)} ${safeDappText(asset.unitName || `Asset #${txn.assetId}`)}`
        : `${txn.amount} base units (Asset #${txn.assetId})`;
    } else {
      amount = `${formatBaseUnitsToAmount(txn.amount, 6)} ${currency ?? '(unknown currency)'}`;
    }
    return `Send ${amount} to ${txn.to.slice(0, 4)}…${txn.to.slice(-4)}`;
  }
  return `Sign ${transactions.length} transaction${transactions.length === 1 ? '' : 's'} for ${safeDappText(dapp) || 'the dApp'}`;
}
