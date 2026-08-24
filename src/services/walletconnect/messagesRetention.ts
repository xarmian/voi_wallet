/**
 * WalletConnect v2 relay message-store retention (PLAN-324, TASK-326).
 *
 * `@walletconnect/core@2.22.4`'s `MessageTracker` persists every relay
 * ciphertext it has ever seen under two AsyncStorage keys and never prunes
 * them: there is no TTL, no cap and no sweep in the library. Topic-level
 * deletion has exactly one path (`subscriber.onUnsubscribe -> messages.del`),
 * which normally requires a successful ONLINE `irn_unsubscribe` — so a session
 * that dies offline, or any failed unsubscribe, leaks its messages forever.
 * Observed on device: 1.25MB, 81% of the app's AsyncStorage (TASK-317).
 *
 * This module is the app-side backstop. It runs ONCE per process, BEFORE the
 * SDK's Core is constructed (see `WalletConnectService.initialize()`), directly
 * against AsyncStorage — the only window in which a raw write is not clobbered
 * by the in-memory tracker's next whole-blob persist.
 *
 * What it does (DR-3/DR-4):
 *   - `wc@2:core:0.3//messages` (MAIN) is hard-bounded: dead topics dropped,
 *     each live topic capped at {@link MAX_MESSAGES_PER_TOPIC}, then a global
 *     {@link MAX_MESSAGE_STORE_BYTES} budget applied largest-topic-first.
 *   - `wc@2:core:0.3//messages_withoutClientAck` (SIBLING) only has dead topics
 *     dropped. Its live entries are the at-least-once replay queue that
 *     `sign-client`'s engine replays at startup — trimming them could drop an
 *     undelivered request, so they are preserved verbatim. Its steady state is
 *     ~empty anyway (the normal path acks right after routing).
 *
 * Cost of evicting a LIVE hash from the main key: the store's only consumer is
 * relay de-duplication (`relayer.shouldIgnoreMessageEvent`), and after a cold
 * start it is the ONLY filter there is — sign-client's own duplicate set is
 * in-memory and starts empty. So a miss means the relay can re-deliver an
 * already-handled request within its TTL (minutes to 6h typically, <=7 days for
 * custom-expiry session requests) and the user sees the signing prompt a second
 * time. That is the worst outcome, and it is the cost DR-4 accepted in exchange
 * for a hard bound. Nothing is ever signed silently: a duplicate goes through
 * the same approval screen as the original.
 *
 * SAFETY ENVELOPE (DR-6). This module handles relay CIPHERTEXTS only.
 *   - READ allowlist: the 3 metadata keys + the 2 message keys. Nothing else.
 *   - WRITE allowlist: the 2 message keys. Nothing else.
 *   - `wc@2:core:0.3//keychain` (the key-bearing store) is excluded from ALL
 *     access: never read, never enumerated, never written. There is no
 *     `getAllKeys` call anywhere in this module.
 *   - It imports nothing from `services/secure|security|wallet|transactions|
 *     auth` and touches no key, mnemonic or signature material.
 *
 * The sweep never throws: any failure degrades to the previous on-disk state
 * and is retried at the next cold start (DR-2 — no in-process retry). The one
 * destructive path — dropping the main key when its row cannot be read back —
 * is gated on RECOGNISING the failure as unrecoverable (Android CursorWindow)
 * and confirmed by a second read; every other rejection leaves the key alone.
 *
 * Cost profile. One pass reads five keys, parses the two message records and
 * re-serializes at most two, so peak memory is a small multiple of the store
 * (1.25MB observed, hard-capped at {@link MAX_MESSAGE_STORE_BYTES} afterwards).
 * Eviction measures every entry ONCE and then works from that model, so the
 * loop never re-serializes the record. A key is written only when its content
 * actually changed, so a store that is already bounded costs reads alone. WC
 * init is one of several service inits started in parallel at boot
 * (`navigation/serviceBootstrap.ts`), so this delays WalletConnect readiness,
 * not the first frame.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CORE_STORAGE_PREFIX,
  MESSAGES_CONTEXT,
  MESSAGES_STORAGE_VERSION,
  PAIRING_CONTEXT,
  STORE_STORAGE_VERSION,
  SUBSCRIBER_CONTEXT,
  SUBSCRIBER_STORAGE_VERSION,
} from '@walletconnect/core';
import { safeJsonParse, safeJsonStringify } from '@walletconnect/safe-json';
import {
  SESSION_CONTEXT,
  SIGN_CLIENT_STORAGE_PREFIX,
} from '@walletconnect/sign-client';

import { redactError } from '@/utils/logRedaction';

// ---------------------------------------------------------------------------
// Storage keys — DERIVED from the packages' exported constants (DR-6), never
// mirrored, so an SDK storage-version bump can never leave us sweeping a stale
// key while the SDK writes a new one.
//
// `MessageTracker.storageKey` is `storagePrefix + version + core
// .customStoragePrefix + "//" + name` (core/src/controllers/messages.ts:63-77).
// `customStoragePrefix` is "" unless `Core` is constructed with one
// (core/src/core.ts:99) — this app passes no storage options
// (`client.ts` -> `UniversalProvider.init`), so it is empty here.
//
// `Store` (sessions, pairings) uses STORE_STORAGE_VERSION, not the controller's
// own `PAIRING_STORAGE_VERSION` — both are "0.3" today, but the Store's version
// is the one that actually lands in the key
// (core/src/controllers/store.ts:77-78).
// ---------------------------------------------------------------------------

/** `wc@2:core:0.3//messages` — the hard-bounded main relay message store. */
export const WC_MESSAGES_STORAGE_KEY = `${CORE_STORAGE_PREFIX}${MESSAGES_STORAGE_VERSION}//${MESSAGES_CONTEXT}`;

/**
 * `wc@2:core:0.3//messages_withoutClientAck` — the replay queue.
 *
 * The `_withoutClientAck` suffix is a string literal in the library
 * (`get storageKeyWithoutClientAck`), not an exported constant, so it is the
 * one fragment that cannot be derived.
 */
export const WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY = `${WC_MESSAGES_STORAGE_KEY}_withoutClientAck`;

/** `wc@2:client:0.3//session` — sign-client session store (read-only here). */
export const WC_SESSION_STORAGE_KEY = `${SIGN_CLIENT_STORAGE_PREFIX}${STORE_STORAGE_VERSION}//${SESSION_CONTEXT}`;

/** `wc@2:core:0.3//pairing` — core pairing store (read-only here). */
export const WC_PAIRING_STORAGE_KEY = `${CORE_STORAGE_PREFIX}${STORE_STORAGE_VERSION}//${PAIRING_CONTEXT}`;

/** `wc@2:core:0.3//subscription` — core subscriber store (read-only here). */
export const WC_SUBSCRIPTION_STORAGE_KEY = `${CORE_STORAGE_PREFIX}${SUBSCRIBER_STORAGE_VERSION}//${SUBSCRIBER_CONTEXT}`;

/** Every key this module is allowed to READ. Enforced at the adapter. */
const READ_ALLOWLIST: ReadonlySet<string> = new Set([
  WC_SESSION_STORAGE_KEY,
  WC_PAIRING_STORAGE_KEY,
  WC_SUBSCRIPTION_STORAGE_KEY,
  WC_MESSAGES_STORAGE_KEY,
  WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
]);

/** Every key this module is allowed to WRITE or DELETE. Enforced at the adapter. */
const WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
  WC_MESSAGES_STORAGE_KEY,
  WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
]);

/** Per-live-topic message cap for the MAIN key (DR-4). */
export const MAX_MESSAGES_PER_TOPIC = 50;

/**
 * Global budget for the MAIN key, measured as the exact UTF-8 byte length of
 * the safe-json-serialized record (topic/hash/JSON overhead included) — the
 * number that actually lands in AsyncStorage.
 */
export const MAX_MESSAGE_STORE_BYTES = 256 * 1024;

/**
 * Names that must never be reconstructed into an object (DR-10). Topic text is
 * remote-influenced (a pairing URI carries it uncanonicalized) and
 * `safeJsonParse` is `JSON.parse` underneath with zero prototype protection.
 * These are dropped INDIVIDUALLY — failing the whole record over one crafted
 * key would let a single hostile message turn every future sweep into a no-op.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** hash -> relay ciphertext, for one topic. */
export type MessageBucket = Map<string, string>;

/**
 * topic -> bucket. `Map` is the working representation on purpose: it cannot be
 * prototype-polluted by a crafted key, and it preserves insertion order (which
 * for these records is arrival order).
 */
export type MessageRecord = Map<string, MessageBucket>;

/** A metadata row reduced to the only two fields liveness depends on. */
export interface TopicLifetime {
  topic: string;
  /** Seconds since epoch, or `null` when the record carries no expiry. */
  expiry: number | null;
}

/** What the sweep decided to do with one message key. */
export type KeyOutcome =
  /** Nothing stored under the key. */
  | 'absent'
  /** Already bounded and clean — no write issued. */
  | 'unchanged'
  | 'rewritten'
  /** The main key's read rejected and it was dropped as unrecoverable. */
  | 'removed'
  /** Stored value is not an object of objects — left untouched. */
  | 'malformed-skipped'
  /** The read rejected and there is no safe repair — left untouched. */
  | 'unreadable'
  /** A decision was made but AsyncStorage rejected the write. */
  | 'write-failed'
  /** The sweep never got as far as deciding (global no-op). */
  | 'skipped';

export interface SweepSummary {
  /**
   * True only when reads and validation succeeded AND every decided write
   * landed. A rejected write flips this to false (with the affected key marked
   * `write-failed`), so the caller is never told the store is bounded when it
   * is not — a key left unwritten still holds its previous, unbounded content.
   */
  completed: boolean;
  /** Why the sweep was a global no-op, when it was one. */
  skippedReason?: 'metadata-unreadable' | 'unexpected-error';
  main: KeyOutcome;
  withoutAck: KeyOutcome;
  /** Serialized byte length written to the main key, when it was rewritten. */
  mainBytesAfter?: number;
}

// ---------------------------------------------------------------------------
// Pure helpers — parsing and validation
//
// The decision logic below is exported deliberately (TASK-326): it is pure —
// parsed records in, retained records out — so the policy can be tested at
// Layer 1 with no storage at all, leaving the adapter at the bottom of the file
// as the only part that touches AsyncStorage. `sweepWalletConnectMessageStore`
// is the only entry point production calls.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key is retainable when it is non-empty and not a prototype-reserved name. */
function isRetainableKey(key: string): boolean {
  return key.length > 0 && !RESERVED_KEYS.has(key);
}

/**
 * A message value is retained only when it really is a string (DR-10).
 *
 * The one interesting near-miss is `safeJsonParse`'s BigInt revival: a stored
 * `"42n"`, and an UNQUOTED 17+-digit number, both come back as a `bigint`.
 * Those are dropped rather than reconstructed, because reconstruction cannot be
 * faithful — `"000n"` and `"0n"` both revive to `0n`, and a bare number and a
 * quoted string are indistinguishable afterwards, so any "repair" would invent
 * bytes the store never held. Dropping is unreachable for real data anyway: a
 * relay ciphertext is base64 and never all digits.
 */
function retainableMessage(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Parse and strictly validate one message record.
 *
 * Returns `null` for a MALFORMED record (the outer value is not an object of
 * objects) — the caller must then leave that key alone. Individual topics and
 * hashes that fail validation, or carry a reserved name, are dropped without
 * failing the record (DR-10).
 *
 * Reconstruction goes through `Object.entries` into `Map`s: no `for...in`, no
 * `Object.assign`, no spread into `{}`, so a `__proto__` key is inert data.
 */
export function parseMessageRecord(raw: string): MessageRecord | null {
  // safeJsonParse returns the RAW STRING when parsing fails, so a non-object
  // result covers both "not JSON" and "JSON of the wrong shape".
  const parsed = safeJsonParse(raw);
  if (!isPlainObject(parsed)) return null;

  const record: MessageRecord = new Map();
  for (const [topic, bucket] of Object.entries(parsed)) {
    if (!isRetainableKey(topic) || !isPlainObject(bucket)) continue;

    const entries: MessageBucket = new Map();
    for (const [hash, message] of Object.entries(bucket)) {
      if (!isRetainableKey(hash) || !retainableMessage(message)) continue;
      entries.set(hash, message);
    }
    // An empty bucket carries no state; the SDK drops them too (messages.ts
    // `ack` deletes a topic once its last hash is acked).
    if (entries.size > 0) record.set(topic, entries);
  }
  return record;
}

/**
 * Parse a `Store`-shaped metadata blob (an ARRAY of records) down to
 * `{ topic, expiry }`.
 *
 * Returns `null` — fail the WHOLE sweep closed — when the blob is not a
 * `Store` array at all (unparseable, or some other JSON value). Metadata is the
 * liveness oracle, and a record we cannot read at all is never treated as an
 * empty set: that would purge every live topic (DR-6, failure table row 1).
 *
 * An individual ROW that carries no usable topic is SKIPPED instead. It names
 * no topic, so skipping it cannot shrink the live set for any topic we could
 * have identified — while failing the whole blob over one junk row would be
 * remotely weaponisable: pairing topics come straight out of a peer-supplied
 * URI, so `wc:@2?…` (empty) or `wc:42n@2?…` (revived by the codec as a BigInt)
 * would otherwise switch retention off permanently, at the attacker's choice.
 */
export function parseTopicLifetimes(raw: string): TopicLifetime[] | null {
  // Read with plain JSON.parse, NOT safeJsonParse — the one place in this
  // module that does not use the codec, and deliberately so:
  //
  //   * Nothing here is ever written back, so DR-9's fidelity requirement (the
  //     bytes we persist must match what the SDK's adapter would persist) has
  //     nothing to bind: these three keys are read-only for the sweep.
  //   * safe-json rewrites any 17+-digit run followed by `,`/`}`/`]` ANYWHERE
  //     in the document, including inside a string, which corrupts the JSON and
  //     makes the parse fail. Pairing topics come out of a peer-supplied URI,
  //     so a topic like `12345678901234567}` would otherwise let an attacker
  //     switch retention off on every boot for as long as that pairing lives.
  //   * safe-json also revives a `"42n"`-shaped topic as a BigInt, which would
  //     no longer match the STRING key the same topic has in the message
  //     record — so its live messages would be purged. JSON.parse sees the
  //     topic text exactly as the message record spells it.
  //
  // Being more permissive here can only ever ADD topics to the live union,
  // which is the conservative direction: the union decides what to KEEP.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const rows: TopicLifetime[] = [];
  for (const row of parsed) {
    if (!isPlainObject(row)) continue;
    const topic = row.topic;
    if (typeof topic !== 'string' || topic.length === 0) continue;
    const expiry = row.expiry;
    rows.push({
      topic,
      expiry:
        typeof expiry === 'number' && Number.isFinite(expiry) ? expiry : null,
    });
  }
  return rows;
}

/**
 * Union of live topics (DR-3).
 *
 * A session or pairing is dead when it is absent, or its `expiry` (SECONDS) has
 * passed. The boundary matches the SDK's own predicate
 * (`@walletconnect/utils` `isExpired`: `Date.now() >= expiry * 1000`), so a
 * record expiring exactly now is dead.
 *
 * A persisted SUBSCRIPTION record has no expiry field at all
 * (`types/core/subscriber.d.ts`), so its topics are live by PRESENCE — a
 * missing expiry is never read as "expired".
 *
 * The union is deliberately conservative: dead-topic deletion is safe because
 * every consumer of the store is per-topic, and link-mode/outbound paths that
 * bypass the SDK's unknown-topic guard can only lose de-duplication, never
 * state.
 */
export function collectLiveTopics(input: {
  sessions: readonly TopicLifetime[];
  pairings: readonly TopicLifetime[];
  subscriptions: readonly TopicLifetime[];
  nowMs: number;
}): Set<string> {
  const live = new Set<string>();
  for (const rows of [input.sessions, input.pairings]) {
    for (const { topic, expiry } of rows) {
      if (expiry !== null && input.nowMs >= expiry * 1000) continue;
      live.add(topic);
    }
  }
  for (const { topic } of input.subscriptions) live.add(topic);
  return live;
}

// ---------------------------------------------------------------------------
// Pure helpers — bounding
// ---------------------------------------------------------------------------

/** UTF-8 byte length of a JS string, without allocating a buffer. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        // Lone surrogate. Defensive only: JSON.stringify escapes these to
        // ASCII `\uXXXX` before they can reach a measured string.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Bytes a string occupies once JSON-encoded (quotes and escapes included). */
function jsonStringBytes(value: string): number {
  return utf8ByteLength(JSON.stringify(value));
}

/** Drop every topic that is not in the live union (DR-3). Applied to BOTH keys. */
export function dropDeadTopics(
  record: MessageRecord,
  liveTopics: ReadonlySet<string>
): MessageRecord {
  const kept: MessageRecord = new Map();
  for (const [topic, bucket] of record) {
    if (liveTopics.has(topic)) kept.set(topic, bucket);
  }
  return kept;
}

/**
 * Cap each topic at `cap` entries (DR-4).
 *
 * Records carry no timestamps, so the plan calls this eviction arbitrary. We
 * keep the LAST `cap` entries: object key order survives the JSON round-trip
 * for these (64-char hex) hashes, so the tail is the most recently arrived —
 * the entries most likely to still be re-delivered by the relay, which is the
 * only thing de-duplication cares about.
 */
export function applyPerTopicCap(
  record: MessageRecord,
  cap: number
): MessageRecord {
  const kept: MessageRecord = new Map();
  for (const [topic, bucket] of record) {
    if (bucket.size <= cap) {
      kept.set(topic, bucket);
      continue;
    }
    // Skip the head in place rather than materialising the whole bucket: a
    // hostile topic can hold thousands of entries and only `cap` survive.
    const skip = bucket.size - cap;
    const trimmed: MessageBucket = new Map();
    let index = 0;
    for (const [hash, message] of bucket) {
      if (index++ < skip) continue;
      trimmed.set(hash, message);
    }
    kept.set(topic, trimmed);
  }
  return kept;
}

interface TopicBudget {
  topic: string;
  /** `"topic":` — the key text plus its colon. */
  keyBytes: number;
  /** Largest entry first; the eviction order within this topic. */
  entries: { hash: string; bytes: number }[];
  entryBytes: number;
}

function topicCost(model: TopicBudget): number {
  const commas = model.entries.length > 1 ? model.entries.length - 1 : 0;
  return model.keyBytes + 2 + model.entryBytes + commas;
}

function modelledTotal(models: readonly TopicBudget[]): number {
  let total = 2; // "{}"
  for (const model of models) total += topicCost(model);
  if (models.length > 1) total += models.length - 1; // commas
  return total;
}

/**
 * Force the record under `budget` bytes (DR-4).
 *
 * Evicts from the LARGEST live topic first, so one hostile topic inflating the
 * store loses its state before any well-behaved topic loses any — and within
 * that topic the largest entry goes first, which also makes progress monotonic
 * (a single oversized message is evicted like any other; the budget wins).
 *
 * A topic emptied by eviction is REMOVED entirely: its key text alone can be a
 * meaningful share of the budget, and an empty bucket carries no state.
 *
 * Termination is structural — every iteration removes exactly one entry from a
 * finite set, and a fully-emptied record serializes to `{}` (2 bytes).
 *
 * Cost: every entry is measured ONCE up front, then each eviction is a scan of
 * the per-topic models — arithmetic on numbers, never a re-serialization of the
 * record. Topic count is bounded by the live union (sessions + pairings +
 * subscriptions), and this only runs at all when the record is over budget.
 */
export function applyByteBudget(
  record: MessageRecord,
  budget: number
): MessageRecord {
  // Size model: measuring each entry ONCE keeps the eviction loop O(topics) per
  // step instead of re-serializing the whole (up to megabyte) record each time.
  const models: TopicBudget[] = [];
  const evicted = new Map<string, Set<string>>();
  for (const [topic, bucket] of record) {
    if (bucket.size === 0) {
      // An empty bucket carries no state but its key text still costs bytes, so
      // it is removed outright (marking it evicted-with-nothing-surviving makes
      // the rebuild below drop it). The production parser never produces one;
      // this keeps the helper's budget contract true for any caller.
      evicted.set(topic, new Set<string>());
      continue;
    }
    const entries = [...bucket].map(([hash, message]) => ({
      hash,
      bytes: jsonStringBytes(hash) + 1 + jsonStringBytes(message),
    }));
    // Largest first; hash as a deterministic tie-break.
    entries.sort((a, b) => b.bytes - a.bytes || (a.hash < b.hash ? -1 : 1));
    models.push({
      topic,
      keyBytes: jsonStringBytes(topic) + 1,
      entries,
      entryBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    });
  }

  // The running total is maintained by exact deltas rather than re-summed, so
  // an eviction costs one scan for the largest topic and nothing else.
  let total = modelledTotal(models);
  while (models.length > 0 && total > budget) {
    let victimIndex = 0;
    let victimCost = -1;
    for (let i = 0; i < models.length; i++) {
      const cost = topicCost(models[i]);
      if (cost > victimCost) {
        victimCost = cost;
        victimIndex = i;
      }
    }
    const model = models[victimIndex];
    // Non-null by construction: empty buckets never become models, and a model
    // is spliced out the moment its last entry goes.
    const entry = model.entries.shift()!;
    model.entryBytes -= entry.bytes;
    let dropped = evicted.get(model.topic);
    if (!dropped) {
      dropped = new Set<string>();
      evicted.set(model.topic, dropped);
    }
    dropped.add(entry.hash);
    if (model.entries.length === 0) {
      // The topic goes with its last entry: `"topic":{…}` and, unless it was
      // the only topic left, the comma that separated it from its neighbour.
      total -= model.keyBytes + 2 + entry.bytes;
      if (models.length > 1) total -= 1;
      models.splice(victimIndex, 1);
    } else {
      // One `"hash":"message"` pair and the comma before it.
      total -= entry.bytes + 1;
    }
  }

  if (evicted.size === 0) return record;

  // Rebuild from the ORIGINAL record so survivors keep their arrival order.
  const kept: MessageRecord = new Map();
  for (const [topic, bucket] of record) {
    const dropped = evicted.get(topic);
    if (!dropped) {
      kept.set(topic, bucket);
      continue;
    }
    const survivors: MessageBucket = new Map();
    for (const [hash, message] of bucket) {
      if (!dropped.has(hash)) survivors.set(hash, message);
    }
    if (survivors.size > 0) kept.set(topic, survivors);
  }
  return kept;
}

/**
 * The full MAIN-key policy: dead-topic drop -> per-topic cap -> byte budget.
 */
export function boundMainRecord(
  record: MessageRecord,
  liveTopics: ReadonlySet<string>
): MessageRecord {
  return applyByteBudget(
    applyPerTopicCap(
      dropDeadTopics(record, liveTopics),
      MAX_MESSAGES_PER_TOPIC
    ),
    MAX_MESSAGE_STORE_BYTES
  );
}

/**
 * Convert the working `Map` form back to the plain record the SDK expects.
 *
 * `Object.fromEntries` defines own data properties (`CreateDataPropertyOrThrow`
 * — it never invokes a setter), so this cannot pollute a prototype even if a
 * reserved name reached it. Reserved names are already dropped at parse time.
 */
export function toPlainRecord(
  record: MessageRecord
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    [...record].map(([topic, bucket]) => [topic, Object.fromEntries(bucket)])
  );
}

// ---------------------------------------------------------------------------
// Storage adapter
// ---------------------------------------------------------------------------

type ReadResult =
  | { status: 'ok'; raw: string }
  | { status: 'absent' }
  | { status: 'error'; error: unknown };

/**
 * One allowlisted `getItem`.
 *
 * Individual reads, never `multiGet` (DR / Codex R4): an oversized value can
 * blow Android's ~2MB CursorWindow, and a batched read would then take the
 * healthy keys down with it — the main key is exactly the one at risk.
 */
async function readAllowlistedKey(key: string): Promise<ReadResult> {
  if (!READ_ALLOWLIST.has(key)) {
    // Unreachable: every call site passes a module constant. Structural guard
    // so no future edit can widen the read surface by accident.
    return { status: 'error', error: new Error('key not in read allowlist') };
  }
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null || raw === undefined) return { status: 'absent' };
    return { status: 'ok', raw };
  } catch (error) {
    return { status: 'error', error };
  }
}

/**
 * Errors that mean the ROW ITSELF is larger than the transport can carry, so no
 * number of retries will ever return it: Android's SQLite blob/CursorWindow
 * size refusal, the exact condition the main key's recovery delete exists for.
 *
 * Deliberately NARROW. Symptoms that merely CO-OCCUR with an oversized row —
 * "Couldn't read row 0, col 0 from CursorWindow", a failed cursor window
 * allocation — also occur under plain memory pressure, so they are excluded:
 * matching them would let a transient blip destroy real de-duplication state.
 * Everything unmatched leaves the key untouched and is retried at the next cold
 * start, which costs an unbounded store for one more boot and nothing else.
 *
 * There is no typed error to match on here — `AsyncStorage` surfaces the native
 * message as a plain `Error` — so text is the only available signal.
 */
const UNRECOVERABLE_READ_ERROR = /row too big|blobtoobig/i;

function isUnrecoverableReadError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error ?? '');
  return UNRECOVERABLE_READ_ERROR.test(text);
}

/**
 * Read the MAIN key, confirming a would-be-fatal rejection before believing it.
 *
 * Only a classified-unrecoverable failure leads anywhere destructive, so that
 * is the only case worth a second look — and a row that really does overflow
 * the CursorWindow fails the second read too. This is not a sweep retry (DR-2 —
 * a failed sweep is not re-run in-process); it is one extra read guarding one
 * delete.
 */
async function readMainKeyConfirmed(): Promise<ReadResult> {
  const first = await readAllowlistedKey(WC_MESSAGES_STORAGE_KEY);
  if (first.status !== 'error' || !isUnrecoverableReadError(first.error)) {
    return first;
  }
  return readAllowlistedKey(WC_MESSAGES_STORAGE_KEY);
}

type StoreAction =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

/** Read + validate a metadata key. `null` means "fail the whole sweep closed". */
function resolveMetadata(read: ReadResult): TopicLifetime[] | null {
  if (read.status === 'error') return null;
  // Absent is NOT malformed: a fresh install simply has no store yet, and an
  // empty live set is the correct answer there.
  if (read.status === 'absent') return [];
  return parseTopicLifetimes(read.raw);
}

/**
 * Run the retention sweep. Never throws; never retries within a process.
 *
 * MUST be called before the SDK's `Core` is constructed — after that the
 * in-memory `MessageTracker` rewrites both keys wholesale on the next inbound
 * message and would clobber anything written here (DR-2).
 */
export async function sweepWalletConnectMessageStore(options?: {
  /** Injectable clock for tests; defaults to `Date.now()`. */
  nowMs?: number;
}): Promise<SweepSummary> {
  const nowMs = options?.nowMs ?? Date.now();

  try {
    // -- Phase 1: read everything. All five reads and all validation complete
    // before ANY write or delete, so no partial failure can delete data that a
    // later read would have proved live.
    const [sessionRead, pairingRead, subscriptionRead, mainRead, ackRead] =
      await Promise.all([
        readAllowlistedKey(WC_SESSION_STORAGE_KEY),
        readAllowlistedKey(WC_PAIRING_STORAGE_KEY),
        readAllowlistedKey(WC_SUBSCRIPTION_STORAGE_KEY),
        readMainKeyConfirmed(),
        readAllowlistedKey(WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY),
      ]);

    // -- Phase 2: validate and decide.
    const sessions = resolveMetadata(sessionRead);
    const pairings = resolveMetadata(pairingRead);
    const subscriptions = resolveMetadata(subscriptionRead);
    if (!sessions || !pairings || !subscriptions) {
      // Unreadable or malformed metadata is never treated as an empty live set
      // — that would purge live topics. GLOBAL no-op, including the main-key
      // recovery delete. The next cold start tries again.
      console.warn(
        'WalletConnect retention: metadata unreadable, skipping sweep'
      );
      return {
        completed: false,
        skippedReason: 'metadata-unreadable',
        main: 'skipped',
        withoutAck: 'skipped',
      };
    }

    const liveTopics = collectLiveTopics({
      sessions,
      pairings,
      subscriptions,
      nowMs,
    });

    const actions: StoreAction[] = [];
    let main: KeyOutcome = 'absent';
    let mainBytesAfter: number | undefined;

    if (mainRead.status === 'error') {
      if (isUnrecoverableReadError(mainRead.error)) {
        // A row no read can ever return (Android CursorWindow), confirmed by a
        // second attempt. Dropping it is the only repair: we lose relay
        // de-duplication for its topics until they re-populate, which costs at
        // most a duplicate re-prompt inside the relay TTL.
        actions.push({ kind: 'remove', key: WC_MESSAGES_STORAGE_KEY });
        main = 'removed';
      } else {
        // Anything else might be transient. Leave the record alone and sweep
        // again at the next cold start.
        main = 'unreadable';
      }
    } else if (mainRead.status === 'ok') {
      const parsed = parseMessageRecord(mainRead.raw);
      if (!parsed) {
        // Malformed: leave it alone (DR-6 failure table). We cannot tell what
        // it held, so any rewrite would be a guess.
        //
        // Skipping cannot let the record grow: growth needs `messages.set`,
        // which calls `persist()`, which rewrites BOTH keys wholesale from the
        // tracker's in-memory maps. So either the SDK writes — and since
        // `MessageTracker.init` fed the mis-read value through `objToMap` (a
        // string yields an index->char map) the result is a flat object of
        // string values that the parser above collapses to `{}` on the next
        // boot — or nothing writes at all and the record stays frozen at its
        // current size. Either way it is bounded and self-correcting.
        //
        // Reachable via safe-json's 17+-digit rewrite when a stored message
        // itself contains such a run followed by `,`/`}`/`]`. Base64 relay
        // ciphertext cannot produce one (the closing quote always intervenes),
        // so this needs a peer that publishes a non-base64 message.
        main = 'malformed-skipped';
      } else {
        const bounded = boundMainRecord(parsed, liveTopics);
        const value = safeJsonStringify(toPlainRecord(bounded));
        if (value === mainRead.raw) {
          // Already bounded and clean — skip a pointless megabyte-scale write.
          main = 'unchanged';
        } else {
          mainBytesAfter = utf8ByteLength(value);
          actions.push({
            kind: 'set',
            key: WC_MESSAGES_STORAGE_KEY,
            value,
          });
          main = 'rewritten';
        }
      }
    }

    let withoutAck: KeyOutcome = 'absent';
    if (ackRead.status === 'ok') {
      const parsed = parseMessageRecord(ackRead.raw);
      if (!parsed) {
        withoutAck = 'malformed-skipped';
      } else {
        // Dead-topic drop ONLY. Live entries are the replay queue: never
        // capped, never budgeted (DR-4 — bounding them risks dropping an
        // undelivered request, and the normal path acks right after routing so
        // the steady state is ~empty). ACCEPTED RESIDUAL: a message the engine
        // cannot decode is never acked, so a hostile peer can grow this key for
        // a live topic. DR-4 chose that over dropping a real request; the main
        // key stays hard-bounded either way.
        const value = safeJsonStringify(
          toPlainRecord(dropDeadTopics(parsed, liveTopics))
        );
        if (value === ackRead.raw) {
          withoutAck = 'unchanged';
        } else {
          actions.push({
            kind: 'set',
            key: WC_MESSAGES_WITHOUT_ACK_STORAGE_KEY,
            value,
          });
          withoutAck = 'rewritten';
        }
      }
    } else if (ackRead.status === 'error') {
      // A rejected sibling read gets NO recovery delete (DR-6 failure table):
      // its entries are the replay queue and may be undelivered requests.
      //
      // Leaving an unreadable sibling behind is not a permanent leak. The SDK
      // self-heals: `MessageTracker.init` swallows a failed restore, keeps an
      // EMPTY map and still marks itself initialized, and its `persist()`
      // rewrites BOTH keys wholesale on the very next message
      // (core/src/controllers/messages.ts init/persist). So the oversized row
      // is overwritten by the SDK itself, without us risking a live request.
      withoutAck = 'unreadable';
    }

    // -- Phase 3: apply. Each action is independent — there is no cross-key
    // invariant, and a crash between the two writes leaves two independently
    // valid records that the next boot re-sweeps.
    //
    // There is no atomic multi-key write in AsyncStorage; a single `setItem`
    // per key is exactly what the SDK itself does on every inbound message, so
    // this adds no durability risk the store does not already carry. Each key
    // is written ONLY when its content actually changed, which keeps the
    // crash-exposure window as small as the work requires.
    for (const action of actions) {
      if (!WRITE_ALLOWLIST.has(action.key)) {
        // Unreachable: actions are only ever built with the two message-key
        // constants above. Topics are nested DATA and must never become keys.
        continue;
      }
      try {
        if (action.kind === 'remove') {
          await AsyncStorage.removeItem(action.key);
        } else {
          await AsyncStorage.setItem(action.key, action.value);
        }
      } catch (error) {
        console.warn(
          'WalletConnect retention: write failed for a message key:',
          redactError(error)
        );
        if (action.key === WC_MESSAGES_STORAGE_KEY) {
          main = 'write-failed';
          mainBytesAfter = undefined;
        } else {
          withoutAck = 'write-failed';
        }
      }
    }

    const summary: SweepSummary = {
      completed: main !== 'write-failed' && withoutAck !== 'write-failed',
      main,
      withoutAck,
      mainBytesAfter,
    };
    // Counts and outcomes only — never a topic, hash or ciphertext.
    console.log('WalletConnect retention sweep:', JSON.stringify(summary));
    return summary;
  } catch (error) {
    // Belt and braces: the sweep must never throw into WalletConnect init.
    console.warn('WalletConnect retention: sweep failed:', redactError(error));
    return {
      completed: false,
      skippedReason: 'unexpected-error',
      main: 'skipped',
      withoutAck: 'skipped',
    };
  }
}
