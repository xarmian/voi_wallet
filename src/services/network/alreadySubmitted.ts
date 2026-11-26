/**
 * Detects algod responses that indicate the exact same signed transaction has
 * already been accepted (committed to a block or sitting in the pool). When we
 * see one of these on a retry it means a PRIOR attempt already landed the tx —
 * possibly a first submit that committed but whose HTTP response was lost — so
 * we must treat it as success and MUST NOT resubmit (double-send / fund-loss
 * risk).
 */
export function isAlreadySubmittedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  return (
    lower.includes('already in ledger') ||
    lower.includes('already in the pool') ||
    lower.includes('already present') ||
    lower.includes('transaction already') ||
    lower.includes('txn already')
  );
}
