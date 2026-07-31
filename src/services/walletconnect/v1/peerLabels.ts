/**
 * Safe log labels for peer-controlled WalletConnect v1 values (TASK-263).
 *
 * WHY THIS EXISTS, and why the shared redactor is not enough:
 *
 * `redactSensitiveForLog` is a SECRET-PATTERN redactor. It finds known shapes
 * (`wc:` URIs, `symKey=`, `key=<hex>`, URLs, addresses) and removes them. It
 * deliberately does NOT redact a bare 64-hex run, because genesis hashes and
 * transaction IDs share that shape and blanket-redacting them would gut
 * diagnosability across the app.
 *
 * That makes it the wrong tool for ARBITRARY peer text. A connected dApp shares
 * the v1 session key, so it can place that key — bare, with no `key=` prefix —
 * into any free-text field it controls (a JSON-RPC `method`, a socket topic) and
 * have the wallet log it verbatim. Truncation does not fix this either: a
 * truncated key is still leaked key material.
 *
 * So peer free-text is DESCRIBED, never reproduced.
 *
 * Lives in its own module rather than inside `client.ts` so it can be unit
 * tested without pulling in AsyncStorage and the whole client.
 */

/**
 * JSON-RPC method names this client recognises. Used ONLY to decide whether a
 * peer-supplied method name is safe to echo into a log — never for dispatch.
 *
 * Includes methods the wallet does NOT implement (personal_sign, eth_*) on
 * purpose: those are real names a confused dApp might send, and seeing the
 * actual name is exactly the diagnostic an operator wants. They are safe to
 * echo precisely because they are a fixed, known set.
 */
const KNOWN_V1_METHODS = new Set([
  'wc_sessionRequest',
  'wc_sessionUpdate',
  'algo_signTxn',
  'algo_signBytes',
  'personal_sign',
  'eth_sendTransaction',
  'eth_sign',
]);

/**
 * Describe a peer-supplied JSON-RPC method for logging without echoing
 * arbitrary peer bytes.
 *
 * A known name is returned verbatim — that is the useful case and it carries no
 * peer-chosen content. Anything else is reported by LENGTH ONLY, so a peer that
 * sets `method` to the session key leaks nothing, while an operator still learns
 * that something non-standard arrived and roughly how big it was.
 */
export function describePeerMethod(method: unknown): string {
  if (typeof method !== 'string') {
    return `[non-string method: ${typeof method}]`;
  }
  if (KNOWN_V1_METHODS.has(method)) {
    return method;
  }
  return `[unrecognized method, ${method.length} chars]`;
}
