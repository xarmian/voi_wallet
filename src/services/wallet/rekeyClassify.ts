import type { RekeyInfo } from '@/services/network';

// Pure, import-free (type-only) so the network layer can classify without a
// cycle through networkRekeyStatus → NetworkService (TASK-458).
export type NetworkRekeyStatus =
  | { status: 'unknown' }
  | { status: 'self' }
  | { status: 'delegated'; authAddress: string };
export const UNKNOWN: NetworkRekeyStatus = Object.freeze({ status: 'unknown' });
export const SELF: NetworkRekeyStatus = Object.freeze({ status: 'self' });

export function classifyNetworkRekey(
  address: string,
  info: RekeyInfo
): NetworkRekeyStatus {
  if (info.unavailable || (info.isRekeyed && !info.authAddress)) return UNKNOWN;
  return info.isRekeyed && info.authAddress !== address
    ? { status: 'delegated', authAddress: info.authAddress! }
    : SELF;
}
