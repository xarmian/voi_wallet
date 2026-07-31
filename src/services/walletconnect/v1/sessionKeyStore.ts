/**
 * WalletConnect v1 session-key store (PLAN-260, TASK-261)
 *
 * The v1 symmetric session key encrypts the bridge channel: anyone who reads it
 * can decrypt and forge traffic on that session, including the `algo_signTxn`
 * requests presented to the user for approval. `CLAUDE.md` is unambiguous that
 * key material belongs in `expo-secure-store`, never `AsyncStorage`, so the key
 * lives here while the session's ROUTING metadata (bridge, topic, accounts,
 * chainId, peer info) stays in AsyncStorage under `WC_V1_SESSION_STORAGE_KEY`.
 *
 * DR-2 — why the split rather than moving the whole session blob: the platform
 * `SecureStorageAdapter` (`src/platform/types.ts`) exposes only setItem/getItem/
 * deleteItem, with NO enumeration and NO multi-delete, while boot restore is
 * built on `AsyncStorage.getAllKeys()` + prefix filter + freshest-wins. Moving
 * the blob would require inventing a separate index — strictly more state to
 * desync.
 *
 * DR-3 — why ONE constant slot with the topic bound INTO the value, rather than
 * a per-topic slot name: the v1 topic is ATTACKER-CONTROLLED and unvalidated
 * (`parseWalletConnectV1Uri` takes whatever sits between `wc:` and `@` in a
 * scanned QR / deeplink URI), while SecureStore restricts key names to
 * alphanumerics, '.', '-' and '_'. A topic-derived slot name would therefore be
 * both a crash vector (`Invalid key`) and a collision vector (a topic embedding
 * the delimiter). A constant name removes attacker input from the key namespace
 * entirely, makes cleanup a single deleteItem against a store that cannot be
 * enumerated, and makes a stale key self-overwriting instead of accumulating.
 * Binding the topic into the VALUE is what keeps a stale slot detectable.
 *
 * The v1 client is a singleton that already enforces exactly one live session
 * (`connect` replaces an active session; `removeStaleSessions` keeps only the
 * active metadata row), so one slot is sufficient for the real model.
 *
 * SECURITY: every log site in this module emits a FIXED message. No key, no
 * topic, and no raw error value is ever logged (DR-13) — a raw error message is
 * not provably key-free, so none are passed through.
 */

import { secureStorage } from '@/platform';
import { WC_V1_SESSION_KEY_SLOT } from './config';

/**
 * The shape persisted into the single secure slot. `topic` binds the key to the
 * session it belongs to so a stale slot is detectable (DR-3) — and so a crash
 * between the secure write and the metadata write cannot silently hand the
 * wrong key to a different session (DR-5).
 */
interface StoredSessionKeyRecord {
  topic: string;
  key: string;
}

/**
 * A WalletConnect v1 session key is a 32-byte AES key transported as hex.
 *
 * Worth validating rather than trusting: `hexToUint8Array` in `crypto.ts`
 * converts without checking, so a non-hex character silently becomes a 0 byte
 * and a short string silently yields a short key — both of which would "work"
 * right up until traffic failed to decrypt for reasons nothing explains. URI
 * parsing only requires the key to be truthy (DR-10).
 *
 * This is NOT the topic-format validation declined in DR-6: a non-hex key could
 * never have worked for AES, so rejecting it cannot break real interop.
 */
export function isValidV1SessionKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Parse and validate the persisted envelope. Anything malformed — not JSON, not
 * an object, missing/blank topic, invalid key — resolves to `null` and is
 * treated by callers as "no key", which fails closed into the ordinary
 * drop-the-session-and-reconnect path (DR-10).
 */
function parseRecord(raw: string | null): StoredSessionKeyRecord | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const { topic, key } = parsed as Partial<StoredSessionKeyRecord>;
    if (typeof topic !== 'string' || topic.length === 0) {
      return null;
    }
    if (!isValidV1SessionKey(key)) {
      return null;
    }

    return { topic, key };
  } catch {
    // Fixed message only — the parse error can quote the malformed payload,
    // which is exactly the value we must never log.
    console.warn('WC v1 SessionKeyStore: discarding malformed stored record');
    return null;
  }
}

/**
 * Read the RAW slot contents, for rollback capture only (DR-5a).
 *
 * NOTE: this deliberately does NOT catch. On Android the secure-storage adapter
 * THROWS when its presence sentinel says an item exists but the native read
 * returns null (keystore desync), and that distinction is the whole point of
 * the fail-closed guard — callers decide what a read failure means. For v1 the
 * answer is "drop the session and force a reconnect" (DR-4), but that is the
 * caller's call to make, not this module's.
 */
export async function readSessionKeySlotRaw(): Promise<string | null> {
  return await secureStorage.getItem(WC_V1_SESSION_KEY_SLOT);
}

/**
 * Read the session key bound to `topic`.
 *
 * Returns `null` when the slot is empty, malformed, or bound to a DIFFERENT
 * topic. A topic mismatch is not an error condition — it is the expected state
 * after a crash between the two writes, or when a newer pairing has taken the
 * slot — and it must fail closed rather than hand back a key for the wrong
 * session.
 *
 * May THROW on an Android keystore desync; see `readSessionKeySlotRaw`.
 */
export async function readSessionKey(topic: string): Promise<string | null> {
  const record = parseRecord(await readSessionKeySlotRaw());
  if (!record || record.topic !== topic) {
    return null;
  }
  return record.key;
}

/**
 * Bind `key` to `topic` and write it to the slot.
 *
 * Rejects an invalid key rather than persisting garbage that would only fail
 * later at decrypt time, where the cause would be unrecoverable from the logs.
 */
export async function writeSessionKey(
  topic: string,
  key: string
): Promise<void> {
  if (!topic) {
    throw new Error('WC v1 session key: refusing to store without a topic');
  }
  if (!isValidV1SessionKey(key)) {
    throw new Error('WC v1 session key: refusing to store a malformed key');
  }

  const record: StoredSessionKeyRecord = { topic, key };
  await secureStorage.setItem(WC_V1_SESSION_KEY_SLOT, JSON.stringify(record));
}

/**
 * Restore a previously captured raw slot value, or clear the slot when there
 * was nothing there before (DR-5a).
 *
 * Used to roll back a successful secure write whose paired AsyncStorage
 * metadata write then failed. Without this, storing session B while session A
 * is persisted would leave the slot holding B and A's metadata orphaned — and
 * A's topic check would then make A permanently unrestorable, which is STRICTLY
 * WORSE than today, where A survives that failure with its inline key.
 */
export async function restoreSessionKeySlot(
  priorRaw: string | null
): Promise<void> {
  if (priorRaw === null) {
    await secureStorage.deleteItem(WC_V1_SESSION_KEY_SLOT);
    return;
  }
  await secureStorage.setItem(WC_V1_SESSION_KEY_SLOT, priorRaw);
}

/**
 * Delete the slot ONLY if it is bound to `topic` (DR-3a).
 *
 * A blind delete here is a live data-loss bug, not a theoretical one: `connect`
 * deliberately RETAINS the previous session's persisted storage when replacing
 * an active connection, but by that point `this.config` already points at the
 * NEW topic. So pairing session B while session A is stored and then rejecting
 * B (rejectSession -> disconnect -> clearSession) would delete the single slot
 * and destroy A's key while A's metadata survives.
 *
 * An unreadable slot (Android keystore desync) is deleted unconditionally: it
 * cannot be compared, and it cannot be used by anyone either, so clearing the
 * desynced entry is both safe and desirable.
 */
export async function deleteSessionKeyForTopic(topic: string): Promise<void> {
  let raw: string | null;
  try {
    raw = await readSessionKeySlotRaw();
  } catch {
    await deleteSessionKeySlot();
    return;
  }

  const record = parseRecord(raw);
  if (record && record.topic !== topic) {
    // Belongs to a different session — leave it alone.
    return;
  }

  // Bound to this topic, or unparseable and therefore useless: clear it.
  await deleteSessionKeySlot();
}

/**
 * Unconditionally clear the slot. For wipes that intentionally drop EVERY v1
 * session (e.g. the extension-mode startup purge), where there is no surviving
 * session whose key could be destroyed.
 */
export async function deleteSessionKeySlot(): Promise<void> {
  await secureStorage.deleteItem(WC_V1_SESSION_KEY_SLOT);
}
