/**
 * Software-key auth-failure detection (PR6.1).
 *
 * A software (local-key) signing attempt can fail because the user secret needed
 * to unwrap the key is unavailable — "PIN required to access private key",
 * "Invalid PIN", or a PIN-gated read failure. These are NOT Ledger errors and are
 * NOT retryable by reconnecting hardware, yet the shared signing-recovery wrapper
 * and the transaction auth controller both classify errors through Ledger-centric
 * logic (`toLedgerFriendlyError`, `lower.includes('pin')`). Left unguarded, a
 * software wallet with no Ledger surfaces "Please unlock your Ledger device" and
 * retries pointlessly.
 *
 * This is the single, shared predicate both paths use to recognize a software
 * auth failure and route it straight to PIN entry.
 *
 * Detection is by TYPE first (`AuthenticationRequiredError`), which
 * `SecureKeyManager.getPrivateKey` now preserves, and by the stable
 * software-auth MESSAGE strings as a fallback for the layers that still wrap the
 * error into a plain `Error`.
 */
import { AuthenticationRequiredError } from '@/types/wallet';

const SOFTWARE_AUTH_MESSAGE_MARKERS = [
  'pin required to access private key',
  'invalid pin',
  'failed to access private key with pin',
];

export function isSoftwareAuthError(error: unknown): boolean {
  if (error instanceof AuthenticationRequiredError) {
    return true;
  }
  const message = (
    error instanceof Error ? error.message : String(error ?? '')
  ).toLowerCase();
  return SOFTWARE_AUTH_MESSAGE_MARKERS.some((marker) =>
    message.includes(marker)
  );
}
