/**
 * Verify-result → wallet-import mapping (pure, no key/storage access).
 *
 * Bridges the trusted output of {@link verifyPairing} (a {@link VerifiedPairing})
 * to the wallet's {@link ImportRemoteSignerAccountRequest}s. It exists as a
 * separate pure function so the security-critical field wiring is unit-testable
 * in isolation from the import screen:
 *
 *   - `publicKey` is the pubkey DERIVED FROM THE ADDRESS by `verifyPairing`
 *     (hex), NEVER the transmitted `pk` — the wire `pk` is never carried into a
 *     wallet record (DR-2/DR-3).
 *   - `authLevel` is the verified pairing level ('v2-signed' | 'v1-unsigned'),
 *     so an unauthenticated (v1) pairing is persisted as such and a verified
 *     (v2) pairing records that it proved control.
 *   - `label`/`name` are copied through verbatim but are cosmetic and UNVERIFIED
 *     (they live outside the signed message); the UI marks them as such.
 */

import { AccountType, ImportRemoteSignerAccountRequest } from '@/types/wallet';
import type { VerifiedPairing } from './pairing';

/**
 * Map a verified pairing plus a chosen subset of addresses to import requests.
 *
 * Only accounts whose `addr` is in `selectedAddresses` are included, preserving
 * the canonical order of `verified.accounts`. Addresses not present in the
 * verified pairing are ignored (they can never be imported).
 */
export function mapVerifiedPairingToImportRequests(
  verified: VerifiedPairing,
  selectedAddresses: Iterable<string>
): ImportRemoteSignerAccountRequest[] {
  const selected = new Set(selectedAddresses);
  return verified.accounts
    .filter((account) => selected.has(account.addr))
    .map((account) => ({
      type: AccountType.REMOTE_SIGNER,
      address: account.addr,
      // DERIVED from `addr` by verifyPairing — never the wire `pk`.
      publicKey: account.publicKey,
      signerDeviceId: verified.dev,
      signerDeviceName: verified.name,
      label: account.label,
      authLevel: verified.authLevel,
    }));
}
