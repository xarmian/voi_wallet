import { safeDappText } from '@/utils/signingSummary';
import type { QueueDapp, QueueSnapshot } from './requestQueue';
import { describeAge } from './requestTiming';

export function dappHost(dapp?: QueueDapp): string {
  try {
    return new URL(dapp?.url ?? '').hostname || 'Unknown website';
  } catch {
    return 'Unknown website';
  }
}

export interface WaitingSummary {
  count: number;
  title: string;
  dappLine: string;
  detailLine: string;
  ageLine: string;
  moreLine: string | null;
}

export function buildWaitingSummary(
  snapshot: QueueSnapshot,
  nowMs: number
): WaitingSummary | null {
  const first = snapshot.head ?? snapshot.waiting[0];
  if (!first) return null;
  const count = (snapshot.head ? 1 : 0) + snapshot.waiting.length;
  const name = safeDappText(first.dapp?.name ?? '') || 'Unknown dApp';
  const host = safeDappText(dappHost(first.dapp)) || 'Unknown website';
  const network = safeDappText(first.network ?? '');
  const action = first.kind === 'proposal' ? 'Connect' : 'Sign transactions';

  return {
    count,
    title:
      count === 1
        ? 'WalletConnect request waiting'
        : `${count} WalletConnect requests waiting`,
    dappLine: `${name} · ${host}`,
    detailLine: network ? `${network} · ${action}` : action,
    ageLine: describeAge({
      firstSeenMs: first.firstSeenMs,
      sentAtMs: first.sentAtMs,
      nowMs,
    }),
    moreLine: count === 1 ? null : `${count - 1} more`,
  };
}
