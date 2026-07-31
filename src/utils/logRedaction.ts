/**
 * Shared log redaction (PLAN-260, TASK-263).
 *
 * Hoisted from two byte-similar copies that had drifted — one in
 * `src/services/walletconnect/index.ts`, one in `src/services/deeplink/index.ts`
 * — so that WalletConnect v1, v2 and the deep-link handler all redact the same
 * way, and so a new sensitive pattern only has to be added once.
 *
 * Used ONLY for logged output. Thrown and user-surfaced errors keep their full
 * value so user-facing messages are unchanged (TASK-33).
 */

/**
 * Redact an Algorand address for logs: keep a short recognisable prefix, drop
 * the rest.
 *
 * Deliberately NOT `truncateAddress` from `services/walletconnect/utils`, which
 * renders first-4 AND last-4 for DISPLAY. Emitting the tail into a log leaks
 * more than a log needs, and a prefix alone is enough to correlate entries. The
 * two copies of this redactor had disagreed on exactly this point; the
 * conservative form wins.
 */
const redactAddress = (address?: string): string =>
  address && address.length > 6
    ? `${address.slice(0, 6)}…[redacted]`
    : '[redacted]';

/**
 * Strip sensitive values from an arbitrary log string — a caught error message
 * OR untrusted deep-link input (scheme/host/path/query/params). Redacts, in
 * order:
 *  - raw and percent-encoded WalletConnect URIs (`wc:` / `wc%3A`), whose query
 *    string carries the v2 session symKey or the v1 session key;
 *  - any stray `symKey=` / `symKey%3D` token (raw or encoded);
 *  - any stray `key=` / `key%3D` token followed by a long hex run — the
 *    WalletConnect **v1** symmetric session key, which appears in a v1 pairing
 *    URI and is the subject of PLAN-260. Bounded to >=16 hex chars so ordinary
 *    `key=` query params (`api_key=`, `sort_key=`) are not blanket-redacted;
 *  - any scheme://… URL — whole URI including the query string;
 *  - full 58-char Algorand addresses, run LAST on the whole string so an address
 *    used as a pseudo-scheme (ADDR://…) is still redacted.
 *
 * DELIBERATELY NOT redacted: a bare 64-hex run with no `key=` prefix. Genesis
 * hashes and transaction IDs are also 64 hex characters, so a blanket rule would
 * gut diagnosability across the whole app. The control for a bare key is that v1
 * key-handling paths log FIXED MESSAGES and never error text at all — redaction
 * here is defense in depth, not the primary defense.
 */
export const redactSensitiveForLog = (message: string): string =>
  message
    .replace(/wc:\S+/gi, 'wc:[redacted]')
    .replace(/wc%3[Aa]\S*/g, 'wc:[redacted]')
    .replace(/symKey(=|%3[Dd])[^&\s"']+/gi, 'symKey=[redacted]')
    .replace(/\bkey(=|%3[Dd])[0-9a-f]{16,}/gi, 'key=[redacted]')
    .replace(/([a-z][a-z0-9+.-]*):\/\/\S*/gi, '$1://[redacted]')
    .replace(/[A-Z2-7]{58}/g, (addr) => redactAddress(addr));

/**
 * Convenience wrapper for the common `catch (error) { console.error(msg, error) }`
 * pattern: derive the message string and redact it before logging.
 *
 * Note this returns a STRING, not the error object — passing the raw error to a
 * console call would defeat the redaction, since the console would format the
 * original `message` and `stack` itself.
 */
export const redactError = (error: unknown): string =>
  redactSensitiveForLog(error instanceof Error ? error.message : String(error));
