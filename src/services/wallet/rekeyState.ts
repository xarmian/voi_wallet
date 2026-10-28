import { AccountMetadata, AccountType } from '@/types/wallet';
import type { RekeyInfo } from '@/services/network';
import { ledgerTransportService } from '@/services/ledger/transport';

export type RekeyState =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'loaded';
      isRekeyed: boolean;
      authAddress?: string;
      canSign: boolean;
    };

/**
 * Mirrors rekeyManager.checkSigningAuthority (used by updateAccountWithRekeyInfo):
 * STANDARD membership suffices; LEDGER requires a connected/available device;
 * REMOTE_SIGNER signs via QR. No persisted authAddress/canSign is consulted.
 */
export function deriveRekeyState(
  address: string,
  info: RekeyInfo,
  accounts: AccountMetadata[]
): Exclude<RekeyState, { status: 'loading' }> {
  if (info.unavailable) return { status: 'error' };
  const authAddress = info.isRekeyed ? info.authAddress : undefined;
  const signingAddress = info.isRekeyed ? authAddress : address;
  const matches = accounts.filter((a) => a.address === signingAddress);
  let canSign = matches.some((a) => a.type === AccountType.STANDARD);
  if (!canSign) {
    const ledger = matches.find((a) => a.type === AccountType.LEDGER);
    if (ledger?.type === AccountType.LEDGER) {
      const connected = ledgerTransportService.getConnectedDevice();
      canSign =
        connected?.id === ledger.deviceId ||
        ledgerTransportService
          .getDevices()
          .some((d) => d.id === ledger.deviceId);
    } else {
      canSign = matches.some((a) => a.type === AccountType.REMOTE_SIGNER);
    }
  }
  return { status: 'loaded', isRekeyed: info.isRekeyed, authAddress, canSign };
}

/** Device availability can change independently of wallet metadata/balances. */
export function subscribeRekeySigner(listener: () => void): () => void {
  const unsubscribe = [
    ledgerTransportService.on('deviceDiscovered', listener),
    ledgerTransportService.on('deviceUpdated', listener),
    ledgerTransportService.on('deviceRemoved', listener),
    ledgerTransportService.on('connected', listener),
    ledgerTransportService.on('disconnected', listener),
  ];
  return () => unsubscribe.forEach((off) => off());
}
