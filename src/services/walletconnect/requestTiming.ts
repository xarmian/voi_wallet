export const WALLET_MAX_WAIT_MS = 5 * 60 * 1000;
export type DeadlineSource = 'dapp' | 'wallet';

export function normalizeExpiryMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value < 1e12 ? value * 1000 : value;
}

export function resolveDeadline(input: {
  expiryTimestamp?: unknown;
  firstSeenMs: number;
}): { deadlineMs: number; source: DeadlineSource } {
  const expiry = normalizeExpiryMs(input.expiryTimestamp);
  return expiry === null
    ? { deadlineMs: input.firstSeenMs + WALLET_MAX_WAIT_MS, source: 'wallet' }
    : { deadlineMs: expiry, source: 'dapp' };
}

export function isPastDeadline(deadlineMs: number, nowMs: number): boolean {
  return nowMs >= deadlineMs;
}

export function describeAge(input: {
  firstSeenMs: number;
  sentAtMs?: number | null;
  nowMs: number;
}): string {
  const sent =
    typeof input.sentAtMs === 'number' && Number.isFinite(input.sentAtMs);
  const start = sent ? (input.sentAtMs as number) : input.firstSeenMs;
  const age = Math.max(0, input.nowMs - start);
  const prefix = sent ? 'Sent' : 'Received';
  if (age < 60_000) return `${prefix} just now`;
  const [count, unit] =
    age < 3_600_000
      ? [Math.floor(age / 60_000), 'minute']
      : age < 86_400_000
        ? [Math.floor(age / 3_600_000), 'hour']
        : [Math.floor(age / 86_400_000), 'day'];
  return `${prefix} ${count} ${unit}${count === 1 ? '' : 's'} ago`;
}
