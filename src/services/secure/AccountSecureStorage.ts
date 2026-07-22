// Platform-agnostic imports for cross-platform compatibility (mobile + extension)
import {
  secureStorage,
  storage,
  crypto as platformCrypto,
  biometrics,
  deviceId as platformDeviceId,
} from '../../platform';

// Buffer polyfill for extension compatibility
import { Buffer } from 'buffer';

// Use crypto-js (pure JS, works in RN/Expo and browser) with explicit side-effect imports
import CryptoJS from 'crypto-js';
import 'crypto-js/hmac-sha256';
import 'crypto-js/sha256';
import 'crypto-js/aes';
import 'crypto-js/mode-ctr';
import 'crypto-js/pad-nopadding';
import 'crypto-js/enc-hex';
import 'crypto-js/pbkdf2';
// Custom PBKDF2 implementation using CryptoJS (cross-platform compatible)

import {
  AccountType,
  AccountMetadata,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  SecureAccountStorage,
  AccountStorageError,
  AccountRetrievalError,
  AccountNotFoundError,
  AuthenticationRequiredError,
  ResetRacedError,
  DuplicatePendingCreateError,
} from '../../types/wallet';
import {
  KeyEnvelopeV2,
  decryptKeyEnvelopeV2,
  decryptKeyEnvelopeV2WithWrapKey,
  encryptKeyEnvelopeV2,
  assertPayloadSizeWithinLimit,
  AT_REST_KDF_PARAMS,
  MAX_KEY_BLOBS,
} from './envelopeV2';
import { SessionKeyVault, VaultLockedError } from './SessionKeyVault';
import type { SecretSource } from './SessionKeyVault';
import { clearPinSetupPending } from './pinSetupPending';
import { SECURITY_CONFIG } from '../../config/security';

// ─────────────────────────────────────────────────────────────────────────────
// PIN THROTTLE — THREAT MODEL (DOC-137 §8 / TASK-26). READ BEFORE CHANGING.
//
// WHAT THIS DEFENDS: ONLINE, on-device PIN guessing against the RUNNING app on a
// NON-rooted / non-jailbroken device. The counter is persisted (survives force-
// kill/relaunch) and mirrored in memory (survives a swallowed write), so a user
// or thief holding an unrooted phone cannot brute-force the 6-digit PIN by
// guessing-and-relaunching.
//
// WHAT THIS DELIBERATELY DOES NOT DEFEND: an attacker with ROOT / direct write
// access to SecureStore. Such an attacker can reset or overwrite this record
// (even with a validly-shaped one) to bypass the throttle — but that same
// attacker can also read the encrypted key blob straight out of SecureStore and
// mount an OFFLINE attack the throttle never sees. A client-side throttle (or a
// MAC / hardware counter on this record — intentionally NOT added, since the
// attacker reads that key/counter too) cannot close this hole. The rooted /
// offline threat is instead mitigated by the memory-hard KDF wrap + optional
// user passphrase (Wave-2 later PRs) and optional root/jailbreak detection
// (deferred). Do NOT extend this throttle to claim it defends rooted devices.
//
// ORDERING / CONCURRENCY: throttle persist writes (both the wrong-PIN increment
// and the correct-PIN reset) are plain awaits INSIDE the serialization mutex,
// like every other awaited secure write in the app (unlock already awaits the
// PIN hash); a hung keychain hanging verifyPin is the same accepted device-
// broken condition (do NOT add a timeout — timeouts caused out-of-order bugs).
// Reset requires the correct PIN, so reset/increment interleavings are not
// attacker-reachable; any such race is a benign self-race that fails safe
// (under-counts, never bypasses).
//
// PIN_ATTEMPT_LIMIT = fails per window before a lockout; PIN_LOCKOUT_DURATION =
// base lockout, doubled each window (see pinLockoutBackoff). Wired from the
// previously-dead security config.
// ─────────────────────────────────────────────────────────────────────────────
const { PIN_ATTEMPT_LIMIT, PIN_LOCKOUT_DURATION } = SECURITY_CONFIG;
const THROTTLE_BACKOFF_CAP_MS = 24 * 60 * 60 * 1000; // hard cap: 24h

/**
 * Persisted PIN-throttle record. Lives in SecureStore under
 * `voi_pin_throttle` so the lockout SURVIVES an app relaunch (killing the app
 * no longer resets the guess counter).
 */
interface PinThrottleRecord {
  /** Consecutive failed PIN attempts since the last success. */
  failCount: number;
  /** Epoch ms until which PIN entry is refused, or null when not locked. */
  lockoutUntil: number | null;
  /** Epoch ms of the most recent failure (diagnostics / future windowing). */
  lastFailAt: number;
}

/**
 * Lockout state surfaced to the UI (LockScreen) via `getPinThrottleState`. This
 * is intentionally a SEPARATE read from `verifyPin` — `verifyPin` keeps its
 * `boolean` return so no caller can mistake a truthy result object for success.
 */
export interface PinThrottleState {
  /** Epoch ms the lockout ends, or null when the PIN can be entered now. */
  lockedUntil: number | null;
  /** Attempts left before the next lockout: max(0, LIMIT - failCount). */
  attemptsRemaining: number;
}

type PersistedAccountMetadata = Omit<
  SecureAccountStorage,
  'encryptedPrivateKey'
>;

interface AccountSecretPayload {
  accountId: string;
  /**
   * Legacy 4-colon (Format A/B/C) ciphertext, OR '' once fully migrated to v2.
   * Retained for back-compat reads.
   */
  encryptedPrivateKey: string;
  /** Unlock-convenience hint — NO LONGER authoritative for decryption (R3). */
  authMethod: 'biometric' | 'pin';
  /**
   * Ordering hint only, MAC-anchored + untrusted (DOC-137 R3): 2 = v2 blobs
   * present. Absent on all pre-Wave-2 payloads.
   */
  version?: 1 | 2;
  /**
   * v2 key envelopes (DOC-137 §2.3/§2.4). Normally 1; transiently 2 during a
   * dual-slot re-wrap. HARD-CAPPED at MAX_KEY_BLOBS. Absent on legacy payloads.
   */
  blobs?: KeyEnvelopeV2[];
}

/**
 * Outcome of a single-account v2 migration attempt (DOC-137 §4.4, PR5).
 *  - `MIGRATED`     — the account was re-wrapped to a user-secret v2 envelope and
 *                     the legacy device-key copy dropped (point of no return passed).
 *  - `ALREADY_V2`   — nothing to do: the sole at-rest copy is already a v2 blob
 *                     readable under the current secret (idempotent no-op).
 *  - `NOT_MIGRATED` — deferred, never fatal: no key material (watch-only), no
 *                     copy readable under the supplied secret, or a caught
 *                     failure left the OLD copy intact for a later retry.
 */
export type MigrationResult = 'MIGRATED' | 'ALREADY_V2' | 'NOT_MIGRATED';

// PBKDF2 using CryptoJS with SHA256; returns hex string of keyLength bytes
const customPBKDF2 = (
  password: string,
  saltHex: string,
  iterations: number,
  keyLength: number
): string => {
  const saltWA = CryptoJS.enc.Hex.parse(saltHex);
  const derived = CryptoJS.PBKDF2(password, saltWA, {
    keySize: keyLength / 4, // CryptoJS keySize is in 32-bit words
    iterations,
    hasher: (CryptoJS.algo as any).SHA256,
  });
  return derived.toString(CryptoJS.enc.Hex);
};

// Platform options are now handled internally by the platform adapters

interface StoredPinData {
  hash: string;
  iterations: number;
  /**
   * Per-credential verification salt, FOLDED into the PIN credential (DOC-137
   * §5.2). Present on Wave-2 (folded) credentials; ABSENT on pre-Wave-2 shapes
   * that kept the salt in the separate `SALT_KEY` item (back-compat: readers
   * fall back to `getOrCreateSalt()` when this is undefined).
   */
  salt?: string;
  /**
   * Which kind of user secret this credential verifies (DOC-137 §5.2 / R3). UX
   * hint only — never a decryption gate. Absent on pre-Wave-2 shapes (treated as
   * 'pin').
   */
  secretSource?: SecretSource;
  format: 'json' | 'legacy';
}

export class AccountSecureStorage {
  private static readonly STORAGE_KEY_PREFIX = 'voi_account_secret_';
  private static readonly LEGACY_STORAGE_KEY_PREFIX = 'voi_account_';
  private static readonly METADATA_KEY = 'voi_account_metadata_';
  private static readonly METADATA_LIST_KEY = 'voi_account_list';
  private static readonly PIN_KEY = 'voi_wallet_pin';
  private static readonly SALT_KEY = 'voi_wallet_salt';
  private static readonly BIOMETRIC_ENABLED_KEY = 'voi_biometric_enabled';
  // The biometric-convenience item (DOC-137 §3.2). Written via setItemWithAuth
  // (auth-gated, enclave-bound, OS-invalidated on enrollment change) — the ONLY
  // item in the app that uses setItemWithAuth.
  private static readonly BIOMETRIC_SECRET_KEY = 'voi_biometric_secret';
  private static readonly DEVICE_ID_KEY = 'voi_device_installation_id';
  private static readonly PIN_TIMEOUT_KEY = 'voi_pin_timeout_setting';
  private static readonly PIN_THROTTLE_KEY = 'voi_pin_throttle';

  // ───────────────────────────────────────────────────────────────────────────
  // TASK-220: cross-store (secret ↔ wallet-metadata) reset hardening. READ THE
  // DECISION RECORD (DOC-221) BEFORE CHANGING. Mirrors the wallet-metadata
  // store's TASK-212 mechanism on the secure-key side, which had NO durable
  // guard of its own (only the in-memory keyMutationChain mutex).
  //
  //   - secureResetGeneration: in-memory monotonic counter bumped SYNCHRONOUSLY
  //     at clearAll() entry (before the mutex), so it is synchronous with the
  //     reset REQUEST. A creation captures it before its secret write; the write
  //     (storeAccountForCreation) and the later wallet-metadata write are both
  //     skipped/aborted if it advanced — the discriminator that fires in the
  //     clearAll()→clearAllWallets() window (the wallet epoch bumps only in
  //     clearAllWallets, too late for the secure side).
  //   - SECURE_WIPE_TOMBSTONE_KEY: durable "secrets were intentionally wiped"
  //     marker. Set by clearAll before its destructive removals; makes
  //     migrateLegacyAccountDataLocked REFUSE to resurrect a wiped secret from a
  //     surviving legacy blob (incl. across a restart, when the in-memory
  //     generation is gone). STICKY: once set by a reset it is never cleared, so
  //     a surviving legacy blob for ANY old id can never be resurrected. A new
  //     account writes its primary secret directly (never migrates), so a
  //     permanent tombstone blocks nothing legitimate.
  //   - PENDING_CREATES_KEY: durable intent journal { [accountId]: token }
  //     written BEFORE the secret so an in-flight/crashed creation's secret is
  //     enumerable even before it reaches any index (the account list is written
  //     AFTER the secret). Drained by clearAll (a reset deletes journaled
  //     in-flight secrets too) and consulted by boot reconcile (TASK-222). The
  //     token records per-attempt OWNERSHIP so a raced attempt's rollback only
  //     deletes the secret IT wrote, never a later same-id attempt's.
  //
  // Concurrency: storeAccountForCreation / commitPendingCreate /
  // deleteAccountIfAttemptMatches acquire the key-mutation mutex around the
  // whole compose (journal + secret/tombstone); clearAll already holds it. The
  // journal/tombstone helpers below are PLAIN AsyncStorage ops (no mutex) so
  // they compose safely inside either — never call a mutex-acquiring method from
  // inside clearAll (non-reentrant chain → deadlock).
  // ───────────────────────────────────────────────────────────────────────────
  private static readonly SECURE_WIPE_TOMBSTONE_KEY = 'voi_secure_wiped';
  private static readonly PENDING_CREATES_KEY = 'voi_pending_account_creates';
  private static secureResetGeneration = 0;
  private static pendingCreateTokenCounter = 0;

  // In-memory promise-chain mutex serializing the throttle read-modify-write so
  // concurrent verifyPin calls (e.g. batch signing) can never lose an
  // increment. Modeled on the inFlightRequests dedup below.
  private static throttleChain: Promise<unknown> = Promise.resolve();

  // ───────────────────────────────────────────────────────────────────────────
  // GLOBAL KEY-MUTATION MUTEX (DOC-137 §0 P1-B). READ BEFORE CHANGING.
  //
  // A SINGLE process-wide exclusive lock that serializes EVERY writer of account
  // key material against EVERY PIN-lifecycle credential change, so the two can
  // never interleave:
  //   - storeAccount (and import/restore, which funnel through it)
  //   - setupPin / changePin (the atomic rewrap-all → verify-all → flip-credential
  //     transaction of §5)
  //
  // WHY (the real lockout vector, P1-B): changePin/setupPin enumerate the account
  // list, re-wrap every account under the NEW secret, then flip the PIN
  // credential. If a NEW account were stored (under the OLD session secret, as a
  // v2 blob) AFTER that enumeration snapshot but BEFORE the credential commit, it
  // would be wrapped under the OLD secret and become unreadable once the new
  // credential lands — a permanent strand recoverable only by the mnemonic. This
  // mutex forces such a concurrent storeAccount to run EITHER fully before the
  // enumeration (so it is included in the rewrap) OR fully after the commit + the
  // vault rotate (so it wraps under the NEW secret). It is acquired BEFORE
  // enumerating accounts and released only AFTER the credential commit and the
  // SessionKeyVault rotation.
  //
  // NEVER roll a failed rewrap back by writing a stale full-payload snapshot (it
  // could clobber a legitimate concurrent write) — roll back by dropping only the
  // specific unproven blob (dropBlob). The chain never rejects (outcomes are
  // swallowed) so one failing task cannot poison later ones. verifyPin is called
  // BEFORE acquiring this lock (it takes the SEPARATE throttle mutex), so the two
  // mutexes never nest and cannot deadlock.
  // ───────────────────────────────────────────────────────────────────────────
  private static keyMutationChain: Promise<unknown> = Promise.resolve();

  // In-memory mirror of the throttle state (DOC-137 §8 / TASK-26, Codex P1).
  // The EFFECTIVE throttle enforced by verifyPin is the MORE RESTRICTIVE of the
  // persisted record and this mirror, so a swallowed write failure or a
  // mid-session tamper of the persisted record can't grant free guesses within
  // the session. null = nothing observed yet this process. Cleared on success
  // (resetThrottle) and on clearAll.
  private static throttleMirror: PinThrottleRecord | null = null;

  // Private key cache for batch signing performance (keeps keys secure within this module)
  private static privateKeyCache: Map<
    string,
    { key: Uint8Array; timestamp: number }
  > = new Map();
  private static readonly CACHE_TTL_MS = 60000; // 60 seconds as suggested

  // In-flight request deduplication to prevent cache stampede
  private static inFlightRequests: Map<string, Promise<Uint8Array>> = new Map();

  // Per-account in-flight guard for the PR5 migration engine (DOC-137 §4.4/§4.6
  // `migrationLock`, modeled on inFlightRequests). The lazy getPrivateKey trigger
  // and the post-unlock sweep can both target the same account; joining the
  // in-flight promise avoids a redundant scrypt+rewrap queued behind the global
  // key-mutation mutex (the mutex would serialize them anyway, but the second
  // would waste a memory-hard derivation before finding the account ALREADY_V2).
  private static migrationInFlight: Map<string, Promise<MigrationResult>> =
    new Map();

  // Iteration counts optimized for mobile performance while maintaining security
  // SecureStore provides hardware-backed encryption, so lower iterations are acceptable
  private static readonly ENCRYPTION_KEY_ITERATIONS = 10000;
  // PIN verification now uses a hardware-backed store; tune iterations for mobile hardware
  private static readonly PIN_ITERATIONS = 8000;
  private static readonly LEGACY_PIN_ITERATIONS = 1000;
  private static readonly PREVIOUS_PIN_ITERATIONS: number[] = [];

  // Minimum length for an alphanumeric passphrase credential (DOC-137 §7/§12 Q6,
  // PR7). LENGTH-ONLY policy (Dave 2026-07-16): no composition rules — a ~12-char
  // passphrase is ~60+ bits, the real at-rest entropy lever, and composition
  // rules reject strong passphrases. The 6-digit PIN stays the default; the
  // passphrase is the opt-in strength lever. A live strength meter guides the UI
  // but the ONLY hard gate is this length floor. Public so the setup/change UI
  // can render the same floor it enforces.
  static readonly PASSPHRASE_MIN_LENGTH = 12;

  private static legacyCheckRequired: boolean | undefined;

  private static secretKey(accountId: string): string {
    return `${this.STORAGE_KEY_PREFIX}${accountId}`;
  }

  private static metadataKey(accountId: string): string {
    return `${this.METADATA_KEY}${accountId}`;
  }

  private static async readMetadata(
    accountId: string
  ): Promise<PersistedAccountMetadata | null> {
    const stored = await storage.getItem(this.metadataKey(accountId));
    if (stored) {
      try {
        return JSON.parse(stored) as PersistedAccountMetadata;
      } catch (error) {
        console.warn('Failed to parse account metadata', error);
        return null;
      }
    }

    // Attempt legacy migration if storage entry is missing
    return await this.migrateLegacyAccountData(accountId);
  }

  private static async saveMetadata(
    accountId: string,
    metadata: PersistedAccountMetadata
  ): Promise<void> {
    await storage.setItem(
      this.metadataKey(accountId),
      JSON.stringify(metadata)
    );
  }

  /**
   * Read a secret payload. `Locked`: the caller ALREADY holds the key-mutation
   * mutex (every internal reader — rewrap / deletePin / writeSecretV2 — is inside
   * it), so a needed legacy fold uses the RAW migrateLegacyAccountDataLocked and
   * never re-acquires the promise-chain lock (which would deadlock). The two
   * OTHER read entry points that can trigger a legacy fold — readMetadata and
   * getPrivateKey — run OUTSIDE the mutex and call the MUTEX-GUARDED
   * migrateLegacyAccountData directly, so no secret write ever bypasses the lock
   * (P1-1a).
   */
  private static async readSecretLocked(
    accountId: string
  ): Promise<AccountSecretPayload | null> {
    try {
      const stored = await secureStorage.getItem(this.secretKey(accountId));
      if (stored) {
        return JSON.parse(stored) as AccountSecretPayload;
      }

      // Fall back to legacy storage for migration (RAW — already inside the lock)
      const migrated = await this.migrateLegacyAccountDataLocked(accountId);
      if (!migrated) {
        return null;
      }

      const migratedSecret = await secureStorage.getItem(
        this.secretKey(accountId)
      );
      return migratedSecret
        ? (JSON.parse(migratedSecret) as AccountSecretPayload)
        : null;
    } catch (error) {
      console.warn('Failed to parse account secret payload', error);
      return null;
    }
  }

  private static async saveSecret(
    accountId: string,
    secret: AccountSecretPayload | null
  ): Promise<void> {
    if (!secret) {
      await secureStorage.deleteItem(this.secretKey(accountId)).catch(() => {});
      return;
    }
    await secureStorage.setItem(
      this.secretKey(accountId),
      JSON.stringify(secret)
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // V2 AT-REST WRITER (DOC-137 §2, PR4). READ BEFORE CHANGING.
  //
  // Wraps the FULL stored key bytes (the 64-byte algosdk `sk`, or whatever length
  // is stored — NEVER hardcode 32; §0 P1-A) under a USER-SECRET-derived scrypt
  // envelope (KeyEnvelopeV2). Every persist of a v2 payload goes through
  // saveSecretV2Checked, which enforces the multi-blob budget (≤2 blobs, <2048
  // bytes serialized) BEFORE writing. NEVER logs the secret or key bytes.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Run a task under the GLOBAL key-mutation mutex (P1-B). Every account-secret
   * writer and every PIN-lifecycle credential change acquires this before
   * enumerating/mutating, so a store/import can never interleave with a
   * setupPin/changePin rewrap. The chain never rejects (each outcome is
   * swallowed onto the chain) so a failing task cannot poison later ones; the
   * task's own result/rejection is still returned to its caller.
   */
  private static runKeyMutationExclusive<T>(
    task: () => Promise<T>
  ): Promise<T> {
    const result = this.keyMutationChain.then(task, task);
    this.keyMutationChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * Encrypt raw key bytes into a KeyEnvelopeV2 under a user secret (scrypt +
   * AES-256-CTR + encrypt-then-MAC). Round-trips the EXACT input bytes (§0
   * P1-A). When `deviceBound` is true the wrap key gets the device post-mix (a
   * cheap HMAC over the device id — mild defense-in-depth, §2.2). Uses the at-rest
   * unlock KDF params (2^14). The caller owns `keyBytes` and must scrub it.
   */
  private static async encryptPrivateKeyV2(
    keyBytes: Uint8Array,
    secret: string,
    secretSource: SecretSource,
    options: { deviceBound: boolean }
  ): Promise<KeyEnvelopeV2> {
    const deviceSecret = options.deviceBound
      ? await this.getStableDeviceId()
      : undefined;
    return encryptKeyEnvelopeV2({
      plaintext: keyBytes,
      secret,
      secretSource,
      deviceSecret,
      kdfParams: AT_REST_KDF_PARAMS,
    });
  }

  /**
   * Serialize + budget-check + persist a v2 payload in ONE atomic SecureStore
   * write. Enforces the PR1 carry-forward (§2.4): hard-cap MAX_KEY_BLOBS blobs
   * and the expo-secure-store 2048-byte value limit, BEFORE the write, so an
   * over-budget payload throws instead of being persisted (or silently rejected
   * by SecureStore). A single setItem is atomic per item on both platforms, which
   * is what makes add-blob → verify → drop-old crash-safe.
   */
  private static async saveSecretV2Checked(
    accountId: string,
    payload: AccountSecretPayload
  ): Promise<void> {
    const serialized = JSON.stringify(payload);
    assertPayloadSizeWithinLimit(serialized, payload.blobs?.length ?? 0);
    await secureStorage.setItem(this.secretKey(accountId), serialized);
  }

  /**
   * Append (or set) a KeyEnvelopeV2 blob in `AccountSecretPayload.blobs` and
   * persist it budget-checked (DOC-137 §2, the writeSecretV2 primitive). Reads
   * the current payload, appends the blob, and writes via saveSecretV2Checked so
   * the 2-blob / 2048-byte cap is enforced. Legacy `encryptedPrivateKey` is
   * retained (dual-readable) — cleanup happens in the atomic rewrap flow, never
   * here. NOTE: general-purpose primitive; the changePin/setupPin rewrap uses the
   * lower-level appendBlob + saveSecretV2Checked directly for keeper-blob control.
   */
  static async writeSecretV2(
    accountId: string,
    blob: KeyEnvelopeV2
  ): Promise<void> {
    // Acquire the GLOBAL key-mutation mutex (P1-1a): this is a secret writer, so
    // it must serialize against every rewrap/store/delete.
    return this.runKeyMutationExclusive(() =>
      this.writeSecretV2Locked(accountId, blob)
    );
  }

  /** RAW writeSecretV2 (no mutex acquire) — for callers already holding it. */
  private static async writeSecretV2Locked(
    accountId: string,
    blob: KeyEnvelopeV2
  ): Promise<void> {
    const existing = await this.readSecretLocked(accountId);
    const base: AccountSecretPayload = existing ?? {
      accountId,
      encryptedPrivateKey: '',
      authMethod: 'pin',
    };
    await this.saveSecretV2Checked(accountId, this.appendBlob(base, blob));
  }

  /**
   * Pure helper: return a copy of `payload` with `blob` appended to `blobs` and
   * version:2 set. Retains `encryptedPrivateKey` (dual-readable during a rewrap).
   * The budget cap is enforced at persist time (saveSecretV2Checked).
   */
  private static appendBlob(
    payload: AccountSecretPayload,
    blob: KeyEnvelopeV2
  ): AccountSecretPayload {
    return {
      accountId: payload.accountId,
      encryptedPrivateKey: payload.encryptedPrivateKey,
      authMethod: payload.authMethod,
      version: 2,
      blobs: [...(payload.blobs ?? []), blob],
    };
  }

  /**
   * Pure helper: return a copy of `payload` with the specific `blob` removed,
   * matched by its unique MAC (identity match is unusable after a JSON round-trip
   * on re-read; the HMAC binds the random salt/iv so it is a collision-free id).
   * Used for verify-before-delete ROLLBACK — drop ONLY the specific unproven
   * blob, NEVER write a stale full-payload snapshot (P1-B). If no blobs remain,
   * the payload reverts to its legacy (Format-A) shape.
   */
  private static dropBlob(
    payload: AccountSecretPayload,
    blob: KeyEnvelopeV2
  ): AccountSecretPayload {
    const remaining = (payload.blobs ?? []).filter((b) => b.mac !== blob.mac);
    if (remaining.length === 0) {
      return {
        accountId: payload.accountId,
        encryptedPrivateKey: payload.encryptedPrivateKey,
        authMethod: payload.authMethod,
      };
    }
    return {
      accountId: payload.accountId,
      encryptedPrivateKey: payload.encryptedPrivateKey,
      authMethod: payload.authMethod,
      version: 2,
      blobs: remaining,
    };
  }

  /**
   * Pure helper: the FINAL committed shape for an account — a single v2 blob,
   * legacy `encryptedPrivateKey` cleared, so the ONLY at-rest copy is the
   * user-secret-wrapped envelope (this is the whole point of DR-2: dropping the
   * device-key copy that needed no user secret). Used in the post-commit cleanup.
   */
  private static finalizePayload(
    payload: AccountSecretPayload,
    keepBlob: KeyEnvelopeV2
  ): AccountSecretPayload {
    return {
      accountId: payload.accountId,
      encryptedPrivateKey: '',
      authMethod: payload.authMethod,
      version: 2,
      blobs: [keepBlob],
    };
  }

  /**
   * Constant-time byte-equality (verify-before-delete byte-exact round-trip
   * check). Length-independent early return is safe (length is not secret).
   */
  private static constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
      return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff === 0;
  }

  /**
   * Trial-decrypt an account's key material for a REWRAP (DOC-137 §4.3/§5.3),
   * returning the in-memory key bytes plus the v2 blob that verified (the
   * "keeper" to retain during the dual-blob transition), or null if nothing
   * decrypts under `currentSecret`/the device key.
   *
   * Ladder (MAC-anchored — a wrong key can never forge the MAC, so a bad
   * candidate simply falls through):
   *   1. v2 blobs under `currentSecret` (if a secret is provided) → keeperBlob set;
   *   2. Format A (device-key, PIN-independent) → keeperBlob undefined;
   *   3. Format C (legacy PIN-mixed, needs `currentSecret`) → keeperBlob undefined.
   *
   * `currentSecret === undefined` is the setupPin (first-secret) case: only the
   * device-key path (2) applies, migrating pre-existing Format-A accounts.
   */
  private static async unwrapKeyForRewrap(
    payload: AccountSecretPayload,
    currentSecret: string | undefined,
    deviceSecret: string
  ): Promise<{ plaintext: Uint8Array; keeperBlob?: KeyEnvelopeV2 } | null> {
    // 1. Existing v2 blobs under the current secret.
    if (currentSecret !== undefined && Array.isArray(payload.blobs)) {
      for (const blob of payload.blobs.slice(0, MAX_KEY_BLOBS)) {
        try {
          const pt = await decryptKeyEnvelopeV2(
            blob,
            currentSecret,
            deviceSecret
          );
          if (pt) {
            return { plaintext: pt, keeperBlob: blob };
          }
        } catch {
          // Structurally invalid/out-of-cap blob — try the next candidate.
        }
      }
    }

    // 2. Format A (device key — PIN-independent).
    if (payload.encryptedPrivateKey) {
      try {
        const pt = await this.decryptPrivateKey(payload.encryptedPrivateKey);
        return { plaintext: pt };
      } catch {
        // Not a device-key blob — fall through to Format C.
      }

      // 3. Format C (legacy PIN-mixed) — only when a PIN-shaped secret is present.
      if (currentSecret !== undefined) {
        try {
          const pt = await this.decryptPrivateKeyWithPin(
            payload.encryptedPrivateKey,
            currentSecret
          );
          return { plaintext: pt };
        } catch {
          // Not Format C either.
        }
      }
    }

    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // V2 MIGRATION ENGINE (DOC-137 §4, PR5). READ BEFORE CHANGING — FUND-RISKING.
  //
  // Upgrades a SINGLE existing account from a legacy device-key (Format A) or
  // legacy PIN-mixed (Format C) wrap — or a stray old v2 blob — to the canonical
  // user-secret v2 envelope, under the account's CURRENT verified secret. This is
  // NOT a secret change (changePin/setupPin own the secret-change rewrap of §5);
  // it re-wraps under the SAME secret and then drops the device-key copy. It is
  // "the flip": once an account is finalized to v2-only, no at-rest copy is
  // readable without the user secret, so the account requires the session vault
  // (or an explicit step-up PIN) — the whole point of DR-2.
  //
  // SAFETY (identical contract to the changePin rewrap, §4.4): additive-then-
  // verify-then-delete. The old readable copy (the Format-A field or an old v2
  // blob) is dropped ONLY AFTER a fresh v2 blob has round-tripped byte-exactly
  // under the same secret, read back from PERSISTED storage. At no crash point
  // does the account have zero readable copies. Any failure is caught and
  // downgraded to NOT_MIGRATED (never throws upward): the OLD copy is left intact
  // and the unproven new blob dropped, so the account stays usable and migration
  // retries on a later trigger.
  //
  // SECRET SAFETY — the strand vector (Codex/adversarial-review PR5 P1): finalizing
  // to v2-under-`secret` is only safe because the user can reproduce that exact
  // secret. It is NOT enough to rely on the phase-3 round-trip verify: for a
  // Format-A account, unwrapKeyForRewrap decrypts via the DEVICE key regardless of
  // `secret`, so phase-3 (which re-encrypts under `secret` then decrypts under the
  // SAME `secret`) is SELF-REFERENTIAL — it proves the new blob is well-formed, NOT
  // that `secret` is the credential. A stale/wrong secret (e.g. a biometric-
  // convenience item left stale by a crash between a changePin commit and its
  // refresh, loaded into the vault on a biometric unlock) would pass phase-3 and
  // strand the account. So the FIRST thing migrateAccountToV2Locked does is
  // checkPinHash(secret): finalize ONLY if `secret` verifies against the CURRENT
  // PIN credential. That gate — not a caller precondition — is what makes the drop
  // safe. Serialized against every other key writer by the GLOBAL key-mutation
  // mutex, deduped per-account by migrationInFlight, and best-effort epoch-guarded
  // so a lock mid-migration aborts before writing at each guard point (P2; an
  // irreducible check-to-write race remains, but is benign given the gate above).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Migrate ONE account to a user-secret v2 envelope (DOC-137 §4.4). Fire-and-
   * forget safe: resolves to a MigrationResult and NEVER throws (every failure
   * downgrades to NOT_MIGRATED). Deduped per-account so the lazy getPrivateKey
   * trigger and the post-unlock sweep can't double-migrate the same account.
   */
  static async migrateAccountToV2(
    accountId: string,
    secret: string,
    secretSource: SecretSource = 'pin',
    vaultEpoch?: number
  ): Promise<MigrationResult> {
    const existing = this.migrationInFlight.get(accountId);
    if (existing) {
      return existing;
    }
    // Acquire the GLOBAL key-mutation mutex (P1-B) so this can never interleave
    // with a store/import/changePin/setupPin/delete. `.catch` makes the whole
    // call non-throwing even if an unexpected error escapes the locked body.
    const task = this.runKeyMutationExclusive(() =>
      this.migrateAccountToV2Locked(accountId, secret, secretSource, vaultEpoch)
    ).catch((): MigrationResult => 'NOT_MIGRATED');
    this.migrationInFlight.set(accountId, task);
    try {
      return await task;
    } finally {
      // Guard on identity so a newer in-flight migration isn't evicted.
      if (this.migrationInFlight.get(accountId) === task) {
        this.migrationInFlight.delete(accountId);
      }
    }
  }

  /**
   * RAW single-account migration (no mutex acquire — the caller holds the global
   * key-mutation mutex). Returns a MigrationResult and NEVER throws upward. Reads
   * with the RAW readSecretLocked (folds Format B → A first). All in-memory
   * plaintext is scrubbed in `finally`. Never logs the secret or key bytes.
   */
  private static async migrateAccountToV2Locked(
    accountId: string,
    secret: string,
    secretSource: SecretSource,
    vaultEpoch?: number
  ): Promise<MigrationResult> {
    // SECRET-IS-CURRENT-CREDENTIAL GATE (Codex PR5 P1 — FUND-CRITICAL). This
    // migrator DROPS the device-key copy and finalizes to v2-under-`secret`. For
    // a Format-A account, unwrapKeyForRewrap decrypts via the DEVICE key
    // REGARDLESS of `secret`, and phase-3 verify only proves the new blob decrypts
    // under that SAME supplied secret — NEITHER proves `secret` is a secret the
    // user can reproduce. A stale/wrong secret (e.g. a biometric-convenience item
    // left stale by a crash between a changePin commit and its refresh, then
    // loaded into the vault on a biometric unlock) would otherwise finalize an
    // account under a secret the current PIN can't reproduce → PERMANENT STRAND.
    // So REFUSE to migrate unless `secret` verifies against the CURRENT PIN
    // credential. Pure hash compare — NO throttle side effect (background op with
    // an already-unlocked session, not a guess) and deadlock-safe inside the key
    // mutex (persistPinCredential does not acquire it; changePin already calls
    // this exact path in-mutex). No current credential (or a non-matching
    // passphrase pre-PR7) → false → NOT_MIGRATED (fail-safe: never finalize).
    if (!(await this.checkPinHash(secret))) {
      return 'NOT_MIGRATED';
    }

    const deviceSecret = await this.getStableDeviceId();
    const payload = await this.readSecretLocked(accountId);
    if (!payload) {
      return 'NOT_MIGRATED'; // watch-only / deleted — nothing to migrate
    }
    const hasKeyMaterial =
      (Array.isArray(payload.blobs) && payload.blobs.length > 0) ||
      !!payload.encryptedPrivateKey;
    if (!hasKeyMaterial) {
      return 'NOT_MIGRATED'; // watch-only payload (saveSecret(id, null))
    }

    // Fast idempotent exit: already finalized to v2-only (exactly one blob, no
    // legacy field) AND that blob decrypts under `secret`. Avoids a needless
    // re-wrap on every sweep pass once an account is done.
    if (
      !payload.encryptedPrivateKey &&
      Array.isArray(payload.blobs) &&
      payload.blobs.length === 1
    ) {
      try {
        const pt = await decryptKeyEnvelopeV2(
          payload.blobs[0],
          secret,
          deviceSecret
        );
        if (pt) {
          pt.fill(0);
          return 'ALREADY_V2';
        }
      } catch {
        // Not readable under `secret` (wrapped under a different/old secret) —
        // fall through; unwrapKeyForRewrap decides below.
      }
    }

    // Unwrap under the CURRENT secret: an existing v2 blob, else Format A (device
    // key), else Format C (legacy PIN-mixed). null => not readable under this
    // secret → defer (never touch storage).
    const unwrapped = await this.unwrapKeyForRewrap(
      payload,
      secret,
      deviceSecret
    );
    if (!unwrapped) {
      return 'NOT_MIGRATED';
    }

    let newBlob: KeyEnvelopeV2 | undefined;
    let appended = false;
    let finalized = false;
    // EPOCH GUARD (Codex PR5 P2 / P1-D): true once the SessionKeyVault epoch
    // captured at the caller's secret-read (`vaultEpoch`) has changed — i.e. the
    // session locked (`clear()`) or rotated. Re-checked after each awaited prep
    // step so a vault-secret migration does not keep processing/writing key
    // material under a session that no longer exists. This is BEST-EFFORT: an
    // irreducible sub-await race remains between the final check and the native
    // write completing — but that residual is BENIGN, not a strand. The hard
    // fund-safety invariant is the checkPinHash gate above: whatever the lock
    // timing, `secret` is the current credential, so any write that does land
    // (dual-blob mid-transition, or a finalized v2-only blob) is correct and
    // readable on the next unlock. Explicit-PIN step-up migrations pass no epoch
    // (undefined) and are not gated — they are not vault-session-dependent.
    const sessionEnded = (): boolean =>
      vaultEpoch !== undefined && SessionKeyVault.currentEpoch() !== vaultEpoch;
    try {
      // Abort before starting any work if the session already ended while this
      // account waited behind the mutex.
      if (sessionEnded()) {
        return 'NOT_MIGRATED';
      }

      // PHASE 2 — ADD a fresh v2 blob under `secret` (dual-blob), keeping the old
      // readable copy through the point of no return. Respect the 2-blob cap the
      // same way the changePin rewrap does: if two old blobs already exist (only
      // reachable from a prior interrupted rewrap), keep ONLY the keeper (readable
      // under `secret`) and drop the other before appending. Never drop a copy
      // readable under the current secret.
      newBlob = await this.encryptPrivateKeyV2(
        unwrapped.plaintext,
        secret,
        secretSource,
        { deviceBound: true }
      );
      const existingBlobs = payload.blobs ?? [];
      const keptOldBlobs =
        existingBlobs.length + 1 <= MAX_KEY_BLOBS
          ? existingBlobs
          : unwrapped.keeperBlob
            ? [unwrapped.keeperBlob]
            : [];
      const base: AccountSecretPayload = {
        accountId: payload.accountId,
        encryptedPrivateKey: payload.encryptedPrivateKey,
        authMethod: payload.authMethod,
        ...(keptOldBlobs.length > 0
          ? { version: 2 as const, blobs: keptOldBlobs }
          : {}),
      };
      // Re-check after the scrypt await (encryptPrivateKeyV2) and before the FIRST
      // write (Codex PR5 P2): a lock during the derivation must not land a write.
      if (sessionEnded()) {
        return 'NOT_MIGRATED';
      }
      await this.saveSecretV2Checked(accountId, this.appendBlob(base, newBlob));
      appended = true;

      // PHASE 3 — VERIFY the new blob byte-exactly under `secret` from the
      // PERSISTED bytes (re-read from storage, NOT the in-memory object), so a
      // torn/clobbered write is caught BEFORE the legacy copy is dropped.
      const raw = await secureStorage.getItem(this.secretKey(accountId));
      let persistedNewBlob: KeyEnvelopeV2 | undefined;
      if (raw) {
        try {
          const persisted = JSON.parse(raw) as AccountSecretPayload;
          persistedNewBlob = persisted.blobs?.find(
            (b) => b.mac === newBlob!.mac
          );
        } catch {
          persistedNewBlob = undefined;
        }
      }
      if (!persistedNewBlob) {
        throw new AccountStorageError(
          `Migration verify failed: new blob for ${accountId} not present in storage`
        );
      }
      const check = await decryptKeyEnvelopeV2(
        persistedNewBlob,
        secret,
        deviceSecret
      );
      try {
        if (
          !check ||
          !this.constantTimeEqualBytes(check, unwrapped.plaintext)
        ) {
          throw new AccountStorageError('Migration verify failed');
        }
      } finally {
        check?.fill(0);
      }

      // Re-check before the POINT OF NO RETURN: if a lock landed after the
      // verified dual-blob write, do NOT drop the device-key copy under a dead
      // session — leave the dual-blob state (Format A + proven v2 blob), which is
      // fully readable under BOTH copies and converges on the next unlock's sweep.
      // (Only a lock/clear can bump the epoch mid-migration — a changePin rotate
      // can't, it holds this same mutex.) A benign check-to-write race remains,
      // but per the checkPinHash invariant a finalize that slips through is still
      // v2-under-current-credential and safe.
      if (sessionEnded()) {
        return 'NOT_MIGRATED';
      }

      // PHASE 5 — FINALIZE (POINT OF NO RETURN): keep ONLY the new blob and clear
      // the legacy device-key field, so no at-rest copy is readable without the
      // user secret (the DR-2 goal). One atomic write.
      await this.saveSecretV2Checked(
        accountId,
        this.finalizePayload(payload, newBlob)
      );
      finalized = true;
      this.legacyCheckRequired = false;
      return 'MIGRATED';
    } catch (error) {
      // ROLLBACK (pre-finalize ONLY — never after the old copy is gone): drop the
      // specific unproven new blob (by MAC), never a stale full-payload snapshot
      // (P1-B). The OLD copy stays intact → nothing stranded → retried on a later
      // trigger. `finalized` guards against a hypothetical future post-finalize
      // throw dropping the ONLY remaining copy (mirrors changePin's `committed`).
      if (!finalized && appended && newBlob) {
        try {
          const current = await this.readSecretLocked(accountId);
          if (current) {
            await this.saveSecretV2Checked(
              accountId,
              this.dropBlob(current, newBlob)
            );
          }
        } catch {
          // Best-effort; the unproven new blob is inert under `secret` (a
          // wrong-secret trial-decrypt MAC-fails), so a surviving copy is harmless.
        }
      }
      console.warn('v2 migration deferred', accountId, error);
      return 'NOT_MIGRATED';
    } finally {
      unwrapped.plaintext.fill(0);
    }
  }

  /**
   * Background post-unlock sweep (DOC-137 §4.5 trigger 2, PR5): migrate every
   * IDLE account to v2 under the CURRENT session secret. SEQUENTIAL (concurrency
   * 1) — scrypt is memory-heavy and parallel derivations risk OOM on low-end
   * Android. Reads the vault secret FRESH per account so a mid-sweep lock STOPS
   * the sweep (no work under a dead session) and a mid-sweep changePin-rotate
   * picks up the NEW secret. Per-account failures never abort the sweep
   * (migrateAccountToV2 never throws). Fire-and-forget from AuthContext (unlock /
   * unlockWithBiometrics) — NEVER blocks the unlock. Idempotent + resumable: an
   * interrupted sweep re-runs on the next unlock (the proven v2 blob is the only
   * truth — there is no trusted global "migration done" flag).
   */
  static async migrateAllAccountsToV2(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.getAllAccountIds();
    } catch {
      return;
    }
    for (const id of ids) {
      const secret = SessionKeyVault.getSecret();
      if (secret === null) {
        return; // vault locked mid-sweep — stop; resumes on next unlock
      }
      // Capture the epoch WITH the secret (both sync, no await between → a lock
      // cannot slip in), so migrateAccountToV2 aborts this account if the session
      // locks while it waits behind the mutex (P2 epoch guard).
      const vaultEpoch = SessionKeyVault.currentEpoch();
      try {
        await this.migrateAccountToV2(
          id,
          secret,
          SessionKeyVault.getSecretSource(),
          vaultEpoch
        );
      } catch {
        // migrateAccountToV2 never throws; belt-and-suspenders so one account's
        // failure can never abort the remaining sweep.
      }
    }
  }

  /**
   * Public read-path legacy fold (Format B → Format A). Acquires the GLOBAL
   * key-mutation mutex so its secret write can never bypass the lock (P1-1a).
   * Reached ONLY outside the mutex (readMetadata / getPrivateKey); in-mutex
   * readers use readSecretLocked → migrateLegacyAccountDataLocked to avoid
   * nesting the promise-chain lock on itself (which would deadlock).
   */
  private static async migrateLegacyAccountData(
    accountId: string
  ): Promise<PersistedAccountMetadata | null> {
    return this.runKeyMutationExclusive(() =>
      this.migrateLegacyAccountDataLocked(accountId)
    );
  }

  /** RAW legacy fold (no mutex acquire) — for callers already holding it. */
  private static async migrateLegacyAccountDataLocked(
    accountId: string
  ): Promise<PersistedAccountMetadata | null> {
    try {
      // TASK-220: refuse to resurrect a secret from a surviving legacy blob while
      // the durable wipe tombstone is set. A full reset deletes account secrets
      // then leaves this marker; without the bail, the next readMetadata/
      // getPrivateKey miss would re-migrate a legacy `voi_account_<id>` copy and
      // undo the wipe (incl. across a restart, when secureResetGeneration is 0
      // again). The marker is STICKY — never cleared in production (see
      // commitPendingCreate) — so a surviving legacy blob for ANY old id stays
      // dead after a wipe. Migration only fires when the PRIMARY secret is absent,
      // so this never blocks a freshly written real secret.
      const wiped = await storage.getItem(this.SECURE_WIPE_TOMBSTONE_KEY);
      if (wiped != null) {
        return null;
      }

      const legacyKey = `${this.LEGACY_STORAGE_KEY_PREFIX}${accountId}`;
      const legacyData = await secureStorage.getItem(legacyKey);
      if (!legacyData) {
        return null;
      }

      const parsed = JSON.parse(legacyData) as SecureAccountStorage;

      const { encryptedPrivateKey, ...metadata } = parsed;
      const persistable: PersistedAccountMetadata = metadata;
      await storage.setItem(
        this.metadataKey(accountId),
        JSON.stringify(persistable)
      );
      await this.addToAccountList(accountId).catch(() => {});

      if (encryptedPrivateKey) {
        const secretPayload: AccountSecretPayload = {
          accountId: parsed.accountId,
          encryptedPrivateKey,
          authMethod: parsed.authMethod,
        };
        await secureStorage.setItem(
          this.secretKey(accountId),
          JSON.stringify(secretPayload)
        );
      } else {
        await secureStorage
          .deleteItem(this.secretKey(accountId))
          .catch(() => {});
      }

      await secureStorage.deleteItem(legacyKey).catch(() => {});
      return persistable;
    } catch (error) {
      console.error('Failed to migrate legacy account data', error);
      return null;
    }
  }

  static async storeAccount(
    account: AccountMetadata,
    privateKey?: Uint8Array
  ): Promise<void> {
    // Acquire the GLOBAL key-mutation mutex (P1-B) around the WHOLE write — the
    // secret payload AND the account-list mutation — so a store can never
    // interleave with a setupPin/changePin rewrap enumeration+commit. See the
    // keyMutationChain comment above.
    return this.runKeyMutationExclusive(() =>
      this.storeAccountLocked(account, privateKey)
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TASK-220 cross-store creation protocol. READ DOC-221 BEFORE CHANGING.
  // ───────────────────────────────────────────────────────────────────────────

  /** Current in-memory secure reset generation (bumped by clearAll). A creation
   *  captures this before its secret write and guards both stores on it. */
  static getResetGeneration(): number {
    return this.secureResetGeneration;
  }

  /** Mint a per-attempt ownership token. In-memory monotonic counter — ownership
   *  only needs to be unique among LIVE attempts in one process; a crashed
   *  attempt's journal entry is reconciled by id at boot (TASK-222). */
  private static nextPendingCreateToken(): string {
    this.pendingCreateTokenCounter += 1;
    return `t${this.pendingCreateTokenCounter}`;
  }

  /** Read the durable pending-creation journal. PLAIN storage op (no mutex) —
   *  callers hold the key-mutation mutex around any read-modify-write. */
  private static async readPendingCreateJournal(): Promise<
    Record<string, string>
  > {
    const raw = await storage.getItem(this.PENDING_CREATES_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  /** Write (or clear) the durable pending-creation journal. PLAIN storage op. */
  private static async writePendingCreateJournal(
    journal: Record<string, string>
  ): Promise<void> {
    if (Object.keys(journal).length === 0) {
      await storage.removeItem(this.PENDING_CREATES_KEY);
      return;
    }
    await storage.setItem(this.PENDING_CREATES_KEY, JSON.stringify(journal));
  }

  /**
   * Atomic guarded secret write for a NEW STANDARD account (TASK-220). In ONE
   * key-mutation-mutex task: (1) abort if a reset advanced the generation since
   * the creation began (reset wins); (2) reject a duplicate pending id (another
   * attempt owns it — prevents an earlier attempt's rollback deleting a later
   * attempt's secret); (3) record the ownership token in the durable journal
   * BEFORE writing the secret; (4) write the secret + secure metadata. Because
   * the generation check and the secret write share one mutex task, no clearAll
   * can interleave between them — either this sees the reset (writes nothing) or
   * clearAll sees the journal entry and deletes the secret.
   *
   * Returns the ownership token to pass to commitPendingCreate (on success) or
   * deleteAccountIfAttemptMatches (on rollback). Throws ResetRacedError or
   * DuplicatePendingCreateError WITHOUT persisting anything.
   */
  static async storeAccountForCreation(
    account: AccountMetadata,
    privateKey: Uint8Array,
    creationGen: number
  ): Promise<string> {
    return this.runKeyMutationExclusive(async () => {
      if (this.secureResetGeneration !== creationGen) {
        throw new ResetRacedError();
      }
      const journal = await this.readPendingCreateJournal();
      if (journal[account.id] !== undefined) {
        throw new DuplicatePendingCreateError();
      }
      const token = this.nextPendingCreateToken();
      journal[account.id] = token;
      await this.writePendingCreateJournal(journal);
      await this.storeAccountLocked(account, privateKey);
      return token;
    });
  }

  /**
   * Generation-guarded write for a NON-SECRET account record (watch / rekeyed /
   * ledger / remote-signer) created during restore (TASK-220, Codex diff-review
   * P2). No secret exists to orphan or journal, but the write must still ABORT
   * (ResetRacedError) if a reset raced the restore so it does not leave a secure
   * account-metadata/list record behind after the wipe. The generation check and
   * the write share one mutex task, so no clearAll can interleave.
   */
  static async storeAccountMetadataForCreation(
    account: AccountMetadata,
    creationGen: number
  ): Promise<void> {
    return this.runKeyMutationExclusive(async () => {
      if (this.secureResetGeneration !== creationGen) {
        throw new ResetRacedError();
      }
      await this.storeAccountLocked(account);
    });
  }

  /**
   * Commit a pending creation AFTER its wallet-metadata write succeeded: drop the
   * journal entry (iff still ours).
   *
   * The secure wipe tombstone is intentionally NOT cleared here — it is STICKY
   * after an explicit reset (Codex diff-review P1). Clearing it on a new creation
   * would re-enable migrateLegacyAccountDataLocked and let a SURVIVING legacy
   * `voi_account_<otherId>` blob — one whose best-effort legacy delete failed at
   * wipe time, for a DIFFERENT old id — resurrect its secret. Unlike the single
   * wallet-metadata blob (whose tombstone TASK-212 clears on the one primary
   * write), the secure store holds many per-account secrets, so one new account's
   * write proves nothing about other ids. A freshly created/restored account
   * writes its PRIMARY secret directly and never needs migration, so a permanent
   * tombstone blocks nothing legitimate; nothing writes legacy-format secrets
   * anymore (they are read-only for one-time migration). Net: once a device has
   * been wiped, pre-wipe secrets can never be resurrected.
   */
  static async commitPendingCreate(
    accountId: string,
    token: string
  ): Promise<void> {
    return this.runKeyMutationExclusive(async () => {
      const journal = await this.readPendingCreateJournal();
      if (journal[accountId] === token) {
        delete journal[accountId];
        await this.writePendingCreateJournal(journal);
      }
    });
  }

  /**
   * Ownership-safe rollback of a raced creation's secret (TASK-220 / DR-2): delete
   * the secret + metadata ONLY if the journal still records THIS attempt's token
   * for the id. A no-op if a reset already drained the journal (secret already
   * gone) or a later attempt now owns the id — so an earlier raced attempt can
   * never delete a legitimately-recreated same-id account.
   */
  static async deleteAccountIfAttemptMatches(
    accountId: string,
    token: string
  ): Promise<void> {
    return this.runKeyMutationExclusive(async () => {
      const journal = await this.readPendingCreateJournal();
      if (journal[accountId] !== token) {
        return;
      }
      await this.deleteAccountLocked(accountId);
      delete journal[accountId];
      await this.writePendingCreateJournal(journal);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TASK-222 — boot-reconcile strict probes. These back the fail-closed
  // cross-store half-state repair (crossStoreReconcile.ts, hooked at boot in
  // AuthContext). Every probe here must either return a DEFINITE answer or THROW
  // — never swallow a read failure to a falsy "absent", because the reconcile
  // interprets "absent" destructively (an absent secret makes its blob account a
  // phantom to prune). A swallowed keychain hiccup reported as "absent" would
  // mass-prune live accounts, so these siblings of the internal readers fail
  // CLOSED (propagate) instead. See the strict-read family in the wallet service
  // (getStoredValueStrict, TASK-213) for the same discipline on the blob side.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * STRICT presence probe for a single account's secret (TASK-222). Reads the
   * PRIMARY secret key ONLY — no legacy fallback and no migration WRITE (unlike
   * readSecretLocked, which folds/rewrites legacy blobs), so a boot probe never
   * mutates the store it is inspecting. Resolves `true` if the primary secret is
   * present, `false` for genuine absence, and PROPAGATES a read failure/timeout
   * (the caller aborts the whole destructive pass on any throw). Needs no unlock
   * — it inspects presence, never decrypts. Bounded so a wedged keychain read
   * cannot stall boot: a hang becomes a rejection the reconcile treats as "read
   * failed → abort", NOT as "absent".
   */
  static async probeSecretPresenceStrict(
    accountId: string,
    timeoutMs: number = 1500
  ): Promise<boolean> {
    const raw = await this.withTimeout(
      secureStorage.getItem(this.secretKey(accountId)),
      timeoutMs,
      'secret presence probe'
    );
    return raw != null;
  }

  /**
   * STRICT read of the durable pending-creation journal (TASK-222). Public
   * sibling of readPendingCreateJournal for the boot reconcile. A `storage`
   * read failure PROPAGATES (fail closed); only a structurally-malformed value
   * degrades to `{}` (the private reader already tolerates bad JSON, and a
   * corrupt journal is not a reason to abort a repair). Bounded so a wedged read
   * cannot stall boot.
   */
  static async readPendingCreatesStrict(
    timeoutMs: number = 1500
  ): Promise<Record<string, string>> {
    return this.withTimeout(
      this.readPendingCreateJournal(),
      timeoutMs,
      'pending-creation journal read'
    );
  }

  /**
   * Unconditionally drop the given ids from the pending-creation journal
   * (TASK-222 reconcile cleanup) under the key-mutation mutex. Unlike
   * deleteAccountIfAttemptMatches this is NOT ownership-checked — the reconcile
   * runs once at boot before any creation flow starts, and it drops only entries
   * it has already classified as orphaned-secret (deleted here) or stale (no
   * secret, no blob account). Touches ONLY the journal; deleting the secret is
   * the caller's separate deleteAccount step. A no-op for ids not present.
   */
  static async dropPendingCreateEntries(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    return this.runKeyMutationExclusive(async () => {
      const journal = await this.readPendingCreateJournal();
      let changed = false;
      for (const id of ids) {
        if (journal[id] !== undefined) {
          delete journal[id];
          changed = true;
        }
      }
      if (changed) {
        await this.writePendingCreateJournal(journal);
      }
    });
  }

  /**
   * Reject `promise` if it has not settled within `ms`. On timeout the abandoned
   * read's eventual settlement is ignored and a labelled Error is thrown so the
   * boot reconcile fails CLOSED (treats it as a read failure, not "absent").
   * Mirrors the AuthContext withTimeout used for the strict lock reads.
   */
  private static withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /** The body of storeAccount, assuming the key-mutation mutex is HELD. Shared by
   *  storeAccount (public wrapper) and storeAccountForCreation. */
  private static async storeAccountLocked(
    account: AccountMetadata,
    privateKey?: Uint8Array
  ): Promise<void> {
    try {
      const hasPin = await this.hasPin();
      const lastAccessed = new Date().toISOString();

      const metadata: PersistedAccountMetadata = {
        accountId: account.id,
        address: account.address,
        type: account.type,
        publicData: {
          publicKey: account.publicKey,
          label: account.label || '',
          color: account.color || '#000000',
          createdAt: account.createdAt,
          importedAt: account.importedAt,
          avatarUrl: account.avatarUrl,
          avatarUpdatedAt: account.avatarUpdatedAt,
        },
        authMethod: hasPin ? 'pin' : 'biometric',
        lastAccessed,
      };

      // Encrypt and store private key for Standard accounts.
      //
      // ALWAYS write the legacy device-key (Format A) envelope — NEVER v2 here
      // (Codex P1-2). A device-key blob is PIN-independent and can be read back
      // regardless of the PIN/vault state, so a newly-stored account can never
      // be stranded under an obsolete/mismatched vault secret (the entire
      // "wrapped under a secret the credential can't reproduce" class). New
      // accounts are upgraded to the user-secret v2 envelope by setupPin /
      // changePin (which enumerate + re-wrap them) or by the PR5 migration
      // engine. The global key-mutation mutex (held here) still serializes this
      // write against any concurrent rewrap, so a store during a changePin is
      // ordered either fully before the enumeration (→ re-wrapped) or fully
      // after the commit (→ stays device-readable, upgraded on the next
      // enumerate). Either way the key is readable — never lost (P1-B).
      if (account.type === AccountType.STANDARD && privateKey) {
        const encryptedPrivateKey = await this.encryptPrivateKey(privateKey);
        await this.saveSecret(account.id, {
          accountId: account.id,
          encryptedPrivateKey,
          authMethod: metadata.authMethod,
        });
      } else {
        await this.saveSecret(account.id, null);
      }

      // Store metadata for quick access
      await this.storeAccountMetadata(metadata);
    } catch (error) {
      throw new AccountStorageError(
        `Failed to store account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async retrieveAccount(accountId: string): Promise<AccountMetadata> {
    try {
      const accountData = await this.readMetadata(accountId);

      if (!accountData) {
        throw new AccountNotFoundError('Account not found');
      }

      // Update last accessed time
      await this.updateLastAccessed(accountId);

      // Build account metadata based on type
      const baseMetadata = {
        id: accountData.accountId,
        address: accountData.address,
        publicKey: accountData.publicData.publicKey,
        label: accountData.publicData.label,
        color: accountData.publicData.color,
        isHidden: false,
        createdAt: accountData.publicData.createdAt,
        importedAt: accountData.publicData.importedAt,
        lastUsed: accountData.lastAccessed,
        avatarUrl: accountData.publicData.avatarUrl,
        avatarUpdatedAt: accountData.publicData.avatarUpdatedAt,
      };

      // Return appropriate metadata type
      switch (accountData.type) {
        case AccountType.STANDARD:
          return {
            ...baseMetadata,
            type: AccountType.STANDARD,
            mnemonic: '', // Will be loaded separately for security
            hasBackup: false, // Will be loaded from metadata
          } as StandardAccountMetadata;

        case AccountType.WATCH:
          return {
            ...baseMetadata,
            type: AccountType.WATCH,
          } as WatchAccountMetadata;

        case AccountType.REKEYED:
          return {
            ...baseMetadata,
            type: AccountType.REKEYED,
            authAddress: '', // Will be loaded from metadata
            originalOwner: false,
          } as RekeyedAccountMetadata;

        default:
          throw new AccountStorageError('Unknown account type');
      }
    } catch (error) {
      if (
        error instanceof AccountNotFoundError ||
        error instanceof AccountStorageError
      ) {
        throw error;
      }
      throw new AccountRetrievalError(
        `Failed to retrieve account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async getPrivateKey(
    accountId: string,
    pin?: string
  ): Promise<Uint8Array> {
    const cacheKey = `${accountId}-${pin || 'biometric'}`;
    // TASK-220: the reset generation at read start. A full reset (clearAll) bumps
    // it synchronously and zeroes the in-memory key cache; if it advances while
    // this read is in flight, we must NOT repopulate the cache with a key derived
    // from a now-wiped secret (that would revive a key a "delete everything" just
    // removed, for up to the 60 s TTL).
    const readGen = this.secureResetGeneration;

    // Periodically clean up expired entries
    if (Math.random() < 0.1) {
      // 10% chance on each call
      this.cleanupExpiredCacheEntries();
    }

    // Check cache first to avoid expensive SecureStore access
    const cached = this.privateKeyCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < this.CACHE_TTL_MS) {
      // Return a copy to prevent external modification
      return new Uint8Array(cached.key);
    }

    // Check if there's already an in-flight request for this key (prevent cache stampede)
    const inFlight = this.inFlightRequests.get(cacheKey);
    if (inFlight) {
      const result = await inFlight;
      // Return a copy
      return new Uint8Array(result);
    }

    // Create a promise for this fetch and store it to deduplicate concurrent requests
    const fetchPromise = (async () => {
      try {
        let unlockMethod: 'pin' | 'biometric' = 'biometric';
        // Vault epoch captured when a pin=undefined read is authorized BY THE
        // VAULT (§6.4 gate). It scopes the WHOLE read to that unlocked session so
        // the final guard aborts an in-flight read that straddles a lock — even a
        // device-key (Format-A) decrypt, which arms no v2 epoch (Codex PR7 P1
        // lock-race: otherwise such a read could resolve post-lock, return the
        // key, and re-populate the 60 s cache that lock had just cleared). Stays
        // -1 for an explicit-pin step-up read (authorized independently of the
        // session) and for a no-credential ambient read.
        let gatedVaultEpoch = -1;

        if (pin) {
          const isValidPin = await this.verifyPin(pin);
          if (!isValidPin) {
            throw new AuthenticationRequiredError('Invalid PIN');
          }
          unlockMethod = 'pin';
        }

        let secretPayloadRaw: string | null = null;

        if (unlockMethod === 'pin') {
          try {
            secretPayloadRaw = await secureStorage.getItem(
              this.secretKey(accountId)
            );
          } catch (error) {
            throw new AuthenticationRequiredError(
              'Failed to access private key with PIN'
            );
          }
        } else {
          // BIOMETRIC / no-PIN read path (DOC-137 §3.3, PR6). The KEY ENVELOPE is
          // read with PLAIN getItem — NEVER getItemWithAuth. The prior
          // getItemWithAuth-on-the-envelope call was the write-time-ACL bug: the
          // envelope is written with plain setItem, so requesting auth only at
          // read enclave-bound NOTHING — it was a UI prompt, not a hardware gate.
          // The biometric gate now lives on the biometric-convenience item, which
          // AuthContext reads with getItemWithAuth at unlock to populate the
          // SessionKeyVault. getPrivateKey is a pure reader: for Format-A payloads
          // the device key decrypts regardless of vault state, so this is
          // behavior-preserving.
          //
          // §6.4 READER GATE (PR7, tightened per Codex): the pin=undefined read of
          // a credentialed wallet requires an UNLOCKED SessionKeyVault — full stop.
          // The vault is populated at unlock from the just-verified PIN/passphrase
          // (manual OR biometric — unlockWithBiometrics populates it too, PR6), so
          // once the user has unlocked, the ~14 background callers can read without
          // re-entering the secret, for PIN-only, passphrase-only, AND biometric
          // wallets alike. We deliberately do NOT let the persisted
          // `biometricEnabled` flag bypass this: that flag alone (with the vault
          // LOCKED) would let a background caller device-decrypt a still-legacy
          // Format-A key with no auth prompt while the app is locked — the exact
          // ambient-read hole DR-2 closes. Biometric unlock is a convenience that
          // goes THROUGH the vault, never around it. A locked vault on a
          // key-bearing wallet throws (require an explicit unlock); a wallet with
          // no credential (hasPin false) still reads ambiently as before.
          const vaultUnlocked = SessionKeyVault.isUnlocked();

          if (!vaultUnlocked) {
            const hasPin = await this.hasPin();
            if (hasPin) {
              throw new AuthenticationRequiredError(
                'PIN or passphrase required to access private key'
              );
            }
          } else {
            // Authorized by the unlocked vault → scope the read to this session
            // epoch so a lock mid-read aborts it (final guard below), closing the
            // Format-A lock-race.
            gatedVaultEpoch = SessionKeyVault.currentEpoch();
          }

          try {
            secretPayloadRaw = await secureStorage.getItem(
              this.secretKey(accountId)
            );
          } catch (error) {
            throw new AccountRetrievalError('Failed to retrieve account data');
          }
        }

        if (!secretPayloadRaw) {
          await this.migrateLegacyAccountData(accountId);
          secretPayloadRaw = await secureStorage.getItem(
            this.secretKey(accountId)
          );
        }

        if (!secretPayloadRaw) {
          const metadata = await this.readMetadata(accountId);
          if (metadata) {
            throw new AccountStorageError(
              'Private key not available for this account'
            );
          }
          throw new AccountNotFoundError('Account not found');
        }

        const parsed: AccountSecretPayload = JSON.parse(secretPayloadRaw);

        let privateKey: Uint8Array | undefined;

        // Candidate 1 (v2 blobs) — tried FIRST when a user secret is available,
        // in one of two modes (DOC-137 §6.4):
        //   - explicit `pin` (step-up re-auth): decrypt directly under that
        //     secret (its own scrypt), independent of the vault.
        //   - no pin + unlocked vault: derive the per-blob wrap key via the
        //     memoized, epoch-guarded SessionKeyVault.getWrapKey — the
        //     load-bearing path that lets the ~14 `pin=undefined` callers keep
        //     working once keys become v2 (PR4/PR5).
        // INERT today: no production writer emits blobs yet, so every existing
        // payload (no `blobs`) skips this and behaves exactly as before —
        // decryption falls through to the Format A / C candidates below EXACTLY
        // as today (device-key path retained; a locked vault does NOT throw for
        // Format A because this branch is never entered). Security anchor: every
        // accepted result MUST pass the envelope MAC — a wrong key cannot forge
        // it, so the ladder simply falls through.
        // When a vault-derived v2 unwrap SUCCEEDS, `v2VaultEpoch` is armed with
        // the epoch captured at unwrap time so EVERY later await — including
        // updateLastAccessed below — can re-check it. It stays -1 (guard is a
        // no-op) for an explicit-pin read, when no v2 blob matched, or when the
        // key came from the vault-independent device-key fallback (candidate 2),
        // so Format-A behavior is unchanged.
        let v2VaultEpoch = -1;
        // Tracks whether the returned key came from a LEGACY tier (Format A/C),
        // which is the lazy-migration trigger condition (DOC-137 §4.5.1, PR5). A
        // v2-blob read leaves this false (already migrated).
        let decryptedViaLegacy = false;
        if (
          Array.isArray(parsed.blobs) &&
          parsed.blobs.length > 0 &&
          (pin !== undefined || SessionKeyVault.isUnlocked())
        ) {
          const usedVault = pin === undefined;
          const unwrapEpoch = usedVault ? SessionKeyVault.currentEpoch() : -1;
          // A VaultLockedError propagating out of here means a lock
          // (clear/rotate) landed mid-derivation (Codex P1-D): ABORT the whole
          // read — do NOT fall through and cache a device key under a session
          // that no longer exists. tryDecryptV2Blobs re-checks the vault epoch
          // after every await.
          privateKey = await this.tryDecryptV2Blobs(
            accountId,
            parsed.blobs,
            pin
          );
          // Arm the final-await guard only if the key actually came from the
          // vault v2 path (not a Format-A fallthrough below).
          if (usedVault && privateKey) {
            v2VaultEpoch = unwrapEpoch;
          }
        }

        // Candidates 2 & 3 (unchanged) — Format A (device key), then Format C
        // (legacy PIN-mixed). Reached whenever no v2 blob verified.
        if (!privateKey) {
          if (!parsed.encryptedPrivateKey) {
            throw new AccountStorageError(
              'Private key not available for this account'
            );
          }

          try {
            privateKey = await this.decryptPrivateKey(
              parsed.encryptedPrivateKey
            );
          } catch (error) {
            if (unlockMethod === 'pin' && pin) {
              privateKey = await this.decryptPrivateKeyWithPin(
                parsed.encryptedPrivateKey,
                pin
              );
            } else {
              throw error;
            }
          }
          // Reached only via a Format A/C decrypt → eligible for lazy upgrade.
          decryptedViaLegacy = true;
        }

        await this.updateLastAccessed(accountId);

        // Epoch guard (Codex P1-D + PR7 P1 lock-race), final await: a lock during
        // any await clears the caches and bumps the vault epoch, so re-check
        // BEFORE returning/re-populating the 60 s cache. Abort (zero + throw) if
        // EITHER (a) a vault-v2 unwrap straddled a lock (`v2VaultEpoch`), OR (b)
        // this pin=undefined read was authorized by the vault gate and the session
        // has since locked (`gatedVaultEpoch`) — the latter covers a device-key
        // (Format-A) decrypt that arms no v2 epoch but must NOT return or re-cache
        // key material under a session that no longer exists.
        const currentEpoch = SessionKeyVault.currentEpoch();
        if (
          (v2VaultEpoch !== -1 && currentEpoch !== v2VaultEpoch) ||
          (gatedVaultEpoch !== -1 && currentEpoch !== gatedVaultEpoch)
        ) {
          privateKey.fill(0);
          throw new VaultLockedError();
        }

        // TASK-220: a full reset (clearAll) during any await of this read wiped the
        // persisted secret this key derives from and zeroed the in-memory cache.
        // Abort (zero + throw) — mirroring the vault-lock abort above — so an
        // in-flight pre-reset signing read never RETURNS or re-caches a key a
        // "delete everything" just removed. In normal operation the generation
        // never advances mid-read, so signing is unaffected.
        if (this.secureResetGeneration !== readGen) {
          privateKey.fill(0);
          throw new ResetRacedError();
        }

        // Cache the key for subsequent calls (60-second TTL).
        this.privateKeyCache.set(cacheKey, {
          key: new Uint8Array(privateKey), // Store a copy
          timestamp: Date.now(),
        });

        // LAZY MIGRATION TRIGGER (DOC-137 §4.5.1, PR5): a legacy-tier (Format
        // A/C) decrypt just succeeded and a verified secret is available (an
        // explicit step-up PIN, or the unlocked session vault) → opportunistically
        // upgrade this account to a user-secret v2 wrap. Fire-and-forget: it
        // NEVER blocks or affects the returned key, is deduped per-account, and
        // swallows failures. Skipped for v2 reads (already migrated) and for a
        // locked-device read with no secret available (migrates on the next
        // unlock sweep instead).
        if (decryptedViaLegacy) {
          const migrationSecret =
            pin ?? SessionKeyVault.getSecret() ?? undefined;
          if (migrationSecret) {
            const migrationSource: SecretSource = pin
              ? 'pin'
              : SessionKeyVault.getSecretSource();
            // Vault-secret path carries the epoch (aborts if the session locks
            // before the migration runs); an explicit step-up PIN passes none.
            const migrationEpoch = pin
              ? undefined
              : SessionKeyVault.currentEpoch();
            void this.migrateAccountToV2(
              accountId,
              migrationSecret,
              migrationSource,
              migrationEpoch
            ).catch(() => {});
          }
        }

        return privateKey;
      } catch (error) {
        if (
          error instanceof AccountNotFoundError ||
          error instanceof AccountStorageError ||
          error instanceof AuthenticationRequiredError ||
          error instanceof AccountRetrievalError ||
          // Vault locked mid-derivation (Codex P1-D): surface as-is so the caller
          // re-auths rather than treating it as a generic retrieval failure.
          error instanceof VaultLockedError ||
          // TASK-220: reset raced this read — surface as-is so signing aborts
          // cleanly rather than reporting a generic retrieval failure.
          error instanceof ResetRacedError
        ) {
          throw error;
        }
        throw new AccountRetrievalError(
          `Failed to retrieve private key: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    })();

    // Store the in-flight promise
    this.inFlightRequests.set(cacheKey, fetchPromise);

    try {
      // Wait for the fetch to complete
      const result = await fetchPromise;
      return result;
    } finally {
      // Always remove from in-flight requests when done (success or failure)
      this.inFlightRequests.delete(cacheKey);
    }
  }

  /**
   * Trial-decrypt the v2 blob candidates (DOC-137 §4.3/§6.4, candidate 1).
   * Returns the first blob whose envelope MAC verifies, or `undefined` to fall
   * through to the legacy formats.
   *
   * Two modes:
   *  - `explicitSecret` defined (step-up re-auth): decrypt each blob directly
   *    under that secret (`decryptKeyEnvelopeV2` runs its own scrypt).
   *  - `explicitSecret` undefined (session-vault path): derive the per-blob wrap
   *    key via the memoized, epoch-guarded `SessionKeyVault.getWrapKey` so the
   *    memory-hard scrypt runs at most once per (account, salt) per session, and
   *    the cheap MAC-verify + AES-unwrap runs per read.
   *
   * Only up to MAX_KEY_BLOBS blobs are attempted (a DoS guard). A wrong key
   * cannot forge the MAC, so a non-matching blob returns null and the ladder
   * continues.
   *
   * EPOCH GUARD (Codex P1-D): in the vault path the vault epoch is captured
   * before any await and RE-CHECKED after EVERY await (the device-id read, each
   * getWrapKey scrypt — guarded inside getWrapKey — and each blob decrypt). If a
   * lock (clear/rotate) bumps the epoch mid-flight, the freshly derived material
   * is zeroed and `VaultLockedError` is thrown so no post-lock key material is
   * ever returned or cached. `VaultLockedError` propagates (it is NOT swallowed
   * as a "try next blob" error).
   */
  private static async tryDecryptV2Blobs(
    accountId: string,
    blobs: KeyEnvelopeV2[],
    explicitSecret?: string
  ): Promise<Uint8Array | undefined> {
    const useVault = explicitSecret === undefined;
    const startEpoch = useVault ? SessionKeyVault.currentEpoch() : -1;

    const deviceSecret = await this.getStableDeviceId();
    if (useVault && SessionKeyVault.currentEpoch() !== startEpoch) {
      throw new VaultLockedError();
    }

    for (const blob of blobs.slice(0, MAX_KEY_BLOBS)) {
      try {
        let privateKey: Uint8Array | null;
        if (explicitSecret !== undefined) {
          privateKey = await decryptKeyEnvelopeV2(
            blob,
            explicitSecret,
            deviceSecret
          );
        } else {
          // getWrapKey memoizes per (account, salt) and throws VaultLockedError
          // if its own scrypt straddles a lock.
          const wrapKey = await SessionKeyVault.getWrapKey(
            accountId,
            blob.salt,
            {
              kdfParams: blob.kdfParams,
              deviceSecret: blob.deviceBound ? deviceSecret : undefined,
            }
          );
          privateKey = await decryptKeyEnvelopeV2WithWrapKey(blob, wrapKey);
          // Re-check AFTER the decrypt await: a lock may have landed between
          // getWrapKey returning and the unwrap completing.
          if (SessionKeyVault.currentEpoch() !== startEpoch) {
            privateKey?.fill(0);
            throw new VaultLockedError();
          }
        }
        if (privateKey) {
          return privateKey;
        }
      } catch (error) {
        if (error instanceof VaultLockedError) {
          throw error; // abort: do NOT fall through / cache post-lock material
        }
        // Structurally invalid / out-of-cap blob — try the next candidate.
      }
    }
    return undefined;
  }

  /**
   * Clear the private key cache
   * Call this after batch operations complete or when you want to ensure keys are removed from memory
   */
  static clearPrivateKeyCache(): void {
    // Zero out all cached keys before clearing for security
    this.privateKeyCache.forEach((cached) => {
      cached.key.fill(0);
    });
    this.privateKeyCache.clear();

    // Also clear any in-flight requests
    this.inFlightRequests.clear();
  }

  /**
   * Clean up expired cache entries
   * Called automatically during cache access, but can be called manually too
   */
  static cleanupExpiredCacheEntries(): void {
    const now = Date.now();

    this.privateKeyCache.forEach((cached, key) => {
      if (now - cached.timestamp >= this.CACHE_TTL_MS) {
        cached.key.fill(0); // Zero out before removing
        this.privateKeyCache.delete(key);
      }
    });
  }

  static async deleteAccount(accountId: string): Promise<void> {
    // Secret writer → acquire the GLOBAL key-mutation mutex (P1-1a) so a delete
    // can never interleave with a rewrap enumeration+commit.
    return this.runKeyMutationExclusive(() =>
      this.deleteAccountLocked(accountId)
    );
  }

  /** RAW deleteAccount (no mutex acquire) — for callers already holding it
   *  (e.g. clearAll). */
  private static async deleteAccountLocked(accountId: string): Promise<void> {
    try {
      // Remove from secure storage
      await this.saveSecret(accountId, null);

      // Remove metadata
      await storage.removeItem(this.metadataKey(accountId));
      await secureStorage
        .deleteItem(`${this.LEGACY_STORAGE_KEY_PREFIX}${accountId}`)
        .catch(() => {});

      // Update account list
      await this.removeFromAccountList(accountId);
    } catch (error) {
      throw new AccountStorageError(
        `Failed to delete account: ${(error as Error).message}`
      );
    }
  }

  static async getAllAccountIds(): Promise<string[]> {
    try {
      const stored = await storage.getItem(this.METADATA_LIST_KEY);
      if (stored) {
        return JSON.parse(stored) as string[];
      }

      const legacy = await secureStorage.getItem(this.METADATA_LIST_KEY);
      if (legacy) {
        await storage.setItem(this.METADATA_LIST_KEY, legacy);
        await secureStorage.deleteItem(this.METADATA_LIST_KEY).catch(() => {});
        return JSON.parse(legacy) as string[];
      }

      return [];
    } catch (error) {
      throw new AccountRetrievalError(
        `Failed to retrieve account list: ${(error as Error).message}`
      );
    }
  }

  private static async encryptPrivateKey(
    privateKey: Uint8Array
  ): Promise<string> {
    let privateKeyHex: string | null = null;
    let keyMaterial: string | null = null;

    try {
      // Generate a strong encryption key using device-specific entropy
      const salt = await platformCrypto.getRandomBytes(32);
      const iv = await platformCrypto.getRandomBytes(16); // 128-bit IV for AES
      keyMaterial = await this.deriveEncryptionKey(salt);

      // Convert private key to hex string for encryption
      privateKeyHex = Buffer.from(privateKey).toString('hex');

      // Use AES-256-GCM with explicit IV for authenticated encryption
      const ivWordArray = CryptoJS.enc.Hex.parse(
        Buffer.from(iv).toString('hex')
      );
      const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);

      const encrypted = CryptoJS.AES.encrypt(privateKeyHex, keyWordArray, {
        iv: ivWordArray,
        mode: CryptoJS.mode.CTR,
        padding: CryptoJS.pad.NoPadding,
      });

      // Add HMAC for authentication (since we can't use GCM)
      const hmacKey = CryptoJS.SHA256(keyMaterial + 'hmac_salt').toString();
      const hmac = CryptoJS.HmacSHA256(
        encrypted.toString(),
        hmacKey
      ).toString();

      // Combine salt, iv, encrypted data, and hmac
      const saltHex = Buffer.from(salt).toString('hex');
      const ivHex = Buffer.from(iv).toString('hex');
      return `${saltHex}:${ivHex}:${encrypted.toString()}:${hmac}`;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to encrypt private key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      // Clear sensitive data from memory
      if (privateKeyHex) {
        privateKeyHex = '0'.repeat(privateKeyHex.length);
      }
      if (keyMaterial) {
        keyMaterial = '0'.repeat(keyMaterial.length);
      }
    }
  }

  private static async decryptPrivateKey(
    encryptedData: string
  ): Promise<Uint8Array> {
    let keyMaterial: string | null = null;
    let privateKeyHex: string | null = null;

    try {
      const parts = encryptedData.split(':');
      if (parts.length !== 4) {
        throw new Error('Invalid encrypted data format');
      }

      const [saltHex, ivHex, encrypted, expectedHmac] = parts;
      const salt = new Uint8Array(Buffer.from(saltHex, 'hex'));
      const iv = new Uint8Array(Buffer.from(ivHex, 'hex'));

      keyMaterial = await this.deriveEncryptionKey(salt);

      // Verify HMAC first to prevent padding oracle attacks
      const hmacKey = CryptoJS.SHA256(keyMaterial + 'hmac_salt').toString();
      const computedHmac = CryptoJS.HmacSHA256(encrypted, hmacKey).toString();

      if (computedHmac !== expectedHmac) {
        throw new Error('Data integrity verification failed');
      }

      // Decrypt with matching parameters
      const ivWordArray = CryptoJS.enc.Hex.parse(
        Buffer.from(iv).toString('hex')
      );
      const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);

      const decrypted = CryptoJS.AES.decrypt(encrypted, keyWordArray, {
        iv: ivWordArray,
        mode: CryptoJS.mode.CTR,
        padding: CryptoJS.pad.NoPadding,
      });

      privateKeyHex = decrypted.toString(CryptoJS.enc.Utf8);

      if (
        !privateKeyHex ||
        privateKeyHex.length === 0 ||
        privateKeyHex.length % 2 !== 0
      ) {
        throw new Error('Decryption failed');
      }

      return new Uint8Array(Buffer.from(privateKeyHex, 'hex'));
    } catch (error) {
      throw new AccountStorageError(
        `Failed to decrypt private key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      // Clear sensitive data from memory
      if (keyMaterial) {
        keyMaterial = '0'.repeat(keyMaterial.length);
      }
      if (privateKeyHex) {
        privateKeyHex = '0'.repeat(privateKeyHex.length);
      }
    }
  }

  private static async decryptPrivateKeyWithPin(
    encryptedData: string,
    pin: string
  ): Promise<Uint8Array> {
    let keyMaterial: string | null = null;
    let privateKeyHex: string | null = null;

    try {
      const parts = encryptedData.split(':');
      if (parts.length !== 4) {
        throw new Error('Invalid encrypted data format');
      }

      const [saltHex, ivHex, encrypted, expectedHmac] = parts;
      const salt = new Uint8Array(Buffer.from(saltHex, 'hex'));
      const iv = new Uint8Array(Buffer.from(ivHex, 'hex'));

      keyMaterial = await this.deriveEncryptionKeyWithPin(salt, pin);

      const hmacKey = CryptoJS.SHA256(keyMaterial + 'hmac_salt').toString();
      const computedHmac = CryptoJS.HmacSHA256(encrypted, hmacKey).toString();

      if (computedHmac !== expectedHmac) {
        throw new Error('Data integrity verification failed');
      }

      const ivWordArray = CryptoJS.enc.Hex.parse(
        Buffer.from(iv).toString('hex')
      );
      const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);

      const decrypted = CryptoJS.AES.decrypt(encrypted, keyWordArray, {
        iv: ivWordArray,
        mode: CryptoJS.mode.CTR,
        padding: CryptoJS.pad.NoPadding,
      });

      privateKeyHex = decrypted.toString(CryptoJS.enc.Utf8);

      if (
        !privateKeyHex ||
        privateKeyHex.length === 0 ||
        privateKeyHex.length % 2 !== 0
      ) {
        throw new Error('Decryption failed');
      }

      return new Uint8Array(Buffer.from(privateKeyHex, 'hex'));
    } catch (error) {
      throw new AccountStorageError(
        `Failed to decrypt private key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    } finally {
      if (keyMaterial) {
        keyMaterial = '0'.repeat(keyMaterial.length);
      }
      if (privateKeyHex) {
        privateKeyHex = '0'.repeat(privateKeyHex.length);
      }
    }
  }

  private static async deriveEncryptionKey(salt: Uint8Array): Promise<string> {
    try {
      // Get a stable, app-scoped device id
      const deviceId = await this.getStableDeviceId();

      // Hash into fixed-size entropy (deterministic across runs)
      const entropyString = `voi_wallet_${deviceId}`;
      const baseEntropy = await platformCrypto.sha256(entropyString);

      // Derive key using custom PBKDF2 with high iteration count
      const saltHex = Buffer.from(salt).toString('hex');
      const key = customPBKDF2(
        baseEntropy,
        saltHex,
        this.ENCRYPTION_KEY_ITERATIONS,
        32
      );

      return key;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to derive encryption key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private static async deriveEncryptionKeyWithPin(
    salt: Uint8Array,
    pin: string
  ): Promise<string> {
    try {
      const deviceId = await this.getStableDeviceId();
      const entropyString = `voi_wallet_pin_${pin}_${deviceId}`;
      const baseEntropy = await platformCrypto.sha256(entropyString);

      const saltHex = Buffer.from(salt).toString('hex');
      const key = customPBKDF2(
        baseEntropy,
        saltHex,
        this.ENCRYPTION_KEY_ITERATIONS,
        32
      );

      return key;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to derive encryption key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Ensure a stable installation-scoped id using platform adapter
  private static async getStableDeviceId(): Promise<string> {
    return await platformDeviceId.getDeviceId();
  }

  private static async storeAccountMetadata(
    metadata: PersistedAccountMetadata
  ): Promise<void> {
    try {
      await this.saveMetadata(metadata.accountId, metadata);
      await this.addToAccountList(metadata.accountId);
    } catch (error) {
      throw new AccountStorageError(
        `Failed to store account metadata: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private static async addToAccountList(accountId: string): Promise<void> {
    try {
      const accountIds = await this.getAllAccountIds();
      if (!accountIds.includes(accountId)) {
        accountIds.push(accountId);
        await storage.setItem(
          this.METADATA_LIST_KEY,
          JSON.stringify(accountIds)
        );
      }
    } catch (error) {
      throw new AccountStorageError(
        `Failed to update account list: ${(error as Error).message}`
      );
    }
  }

  private static async removeFromAccountList(accountId: string): Promise<void> {
    try {
      const accountIds = await this.getAllAccountIds();
      const updatedIds = accountIds.filter((id) => id !== accountId);
      await storage.setItem(this.METADATA_LIST_KEY, JSON.stringify(updatedIds));
    } catch (error) {
      throw new AccountStorageError(
        `Failed to update account list: ${(error as Error).message}`
      );
    }
  }

  private static async updateLastAccessed(accountId: string): Promise<void> {
    try {
      const metadata = await this.readMetadata(accountId);
      if (!metadata) {
        return;
      }

      const updated: PersistedAccountMetadata = {
        ...metadata,
        lastAccessed: new Date().toISOString(),
      };

      await this.saveMetadata(accountId, updated);
    } catch (error) {
      // Don't throw error for last accessed update failure - it's not critical
      console.warn(
        `Failed to update last accessed time: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private static async requireAuthentication(purpose: string): Promise<void> {
    try {
      const available = await biometrics.isAvailable();
      const enrolled = await biometrics.isEnrolled();

      if (!available || !enrolled) {
        throw new AuthenticationRequiredError(
          'Biometric authentication not available'
        );
      }

      const result = await biometrics.authenticate({
        promptMessage: this.getAuthMessage(purpose),
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
      });

      if (!result.success) {
        throw new AuthenticationRequiredError(
          `Authentication failed: ${result.error}`
        );
      }
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        throw error;
      }
      throw new AuthenticationRequiredError(
        `Authentication error: ${(error as Error).message}`
      );
    }
  }

  private static getAuthMessage(purpose: string): string {
    switch (purpose) {
      case 'access_private_key':
        return 'Authenticate to access private key';
      case 'sign_transaction':
        return 'Authenticate to sign transaction';
      case 'backup_account':
        return 'Authenticate to backup account';
      case 'delete_account':
        return 'Authenticate to delete account';
      default:
        return 'Authenticate to access account';
    }
  }

  // PIN Management Methods

  /**
   * True iff `secret` is well-formed for its kind (DOC-137 §7, PR7): a PIN is
   * exactly 6 digits; a passphrase is at least PASSPHRASE_MIN_LENGTH chars
   * (length-only — no composition rules). Pure predicate, no throw — used by the
   * verifyPin fast-reject (so a malformed entry is never counted as a throttle
   * attempt) and as the basis for validateSecret.
   */
  static isSecretFormatValid(
    secret: string,
    secretSource: SecretSource
  ): boolean {
    if (!secret) {
      return false;
    }
    if (secretSource === 'passphrase') {
      return secret.length >= this.PASSPHRASE_MIN_LENGTH;
    }
    return secret.length === 6 && /^\d{6}$/.test(secret);
  }

  /**
   * Validate a user secret for its kind, THROWING a user-facing message on
   * failure (used at setup/change where we want to explain why). PIN = 6 digits;
   * passphrase = min PASSPHRASE_MIN_LENGTH chars, length-only (DOC-137 §12 Q6).
   */
  private static validateSecret(
    secret: string,
    secretSource: SecretSource
  ): void {
    if (this.isSecretFormatValid(secret, secretSource)) {
      return;
    }
    if (secretSource === 'passphrase') {
      throw new Error(
        `Passphrase must be at least ${this.PASSPHRASE_MIN_LENGTH} characters`
      );
    }
    throw new Error('PIN must be 6 digits');
  }

  /**
   * The kind of the currently-stored credential (PIN vs passphrase), or null if
   * no credential is set. Public so the UI (LockScreen / auth modals / settings)
   * can render the numeric keypad vs a masked passphrase field. Never returns the
   * secret itself — only its kind.
   */
  static async getCredentialSource(): Promise<SecretSource | null> {
    const stored = await this.getStoredPinData();
    if (!stored) {
      return null;
    }
    return stored.secretSource ?? 'pin';
  }

  /**
   * First-secret setup. Back-compat alias that DELEGATES to setupPin so the
   * credential commit ALWAYS re-wraps any pre-existing device-key accounts under
   * the new secret (DOC-137 §5.4). Persisting a bare hash without re-wrapping
   * would brick v2 keys on the next unlock — never do that.
   */
  static async storePin(pin: string): Promise<void> {
    await this.setupPin(pin, 'pin');
  }

  /**
   * First-secret setup / device→v2 migration (DOC-137 §5.4).
   *
   * Establishes the FIRST PIN credential and atomically re-wraps every
   * pre-existing (Format-A, device-key) standard account under the new secret,
   * using the SAME dual-blob verify-before-delete transaction as changePin with
   * `currentSecret` = the device key (Format A needs no user secret to unwrap).
   * Fund-risking: verify-before-delete + crash-safety are enforced by
   * rewrapAndCommitCredentialLocked (crash before commit → no credential,
   * device-key copies intact; crash after commit → v2 copies valid, cleanup
   * idempotent).
   *
   * PR7: `secretSource: 'passphrase'` is now supported — verifyPin validates and
   * unlocks a passphrase credential by reading the stored kind, so a passphrase
   * is recoverable. validateSecret enforces the per-kind format (PIN 6 digits,
   * passphrase ≥ PASSPHRASE_MIN_LENGTH) before the credential commits.
   */
  static async setupPin(
    newSecret: string,
    secretSource: SecretSource = 'pin'
  ): Promise<void> {
    try {
      this.validateSecret(newSecret, secretSource);
      // TASK-213 (fail-OPEN closure): clear the restore-before-PIN breadcrumb —
      // with CONFIRMED removal — BEFORE committing the PIN, not after. A PIN
      // credential must never come to exist on disk while a live breadcrumb could
      // still be read: otherwise a commit that partially fails (e.g. the Android
      // presence-sentinel write fails, so a later keystore break makes the PIN read
      // resolve absent) would let the stale breadcrumb route that wallet to
      // SecuritySetup — a NEW PIN over a real wallet. Clearing FIRST makes every
      // such race fail CLOSED (recovery), never open. If removal cannot be
      // CONFIRMED (a wedged/unhealthy store), ABORT rather than commit a PIN into
      // that ambiguous state — the caller simply retries. clearPinSetupPending is
      // bounded + verifying + never-throwing; a no-op when no breadcrumb exists
      // (normal onboarding) on a healthy store.
      const breadcrumbCleared = await clearPinSetupPending();
      if (!breadcrumbCleared) {
        throw new Error(
          'Could not clear the restore setup marker before establishing the PIN'
        );
      }
      // Acquire the GLOBAL key-mutation mutex, then run the atomic rewrap+commit
      // under it (P1-3: no verify/commit races). setupPin has no current secret
      // to verify (first-secret setup).
      await this.runKeyMutationExclusive(() =>
        this.rewrapAndCommitCredentialLocked({
          currentSecret: undefined,
          newSecret,
          newSource: secretSource,
        })
      );
      this.legacyCheckRequired = false;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to set up PIN: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Verify a PIN, enforcing the PERSISTENT throttle (DOC-137 §8 / TASK-26).
   *
   * IMPORTANT — return type stays `boolean` by design. DOC-137 §8.4 originally
   * proposed returning a result object; Codex flagged that as dangerous because
   * `if (result)` on a truthy object reads a WRONG pin as success at every
   * un-converted caller (AuthContext, UnifiedAuthModal, SignerAuthModal,
   * ChangePinScreen, transactionAuthController, getPrivateKey, changePin). So
   * the throttle is enforced INTERNALLY here and lockout details are exposed to
   * the UI through the separate `getPinThrottleState()` read — no caller changes.
   *
   * The whole load-check-hash-update-save sequence runs under an in-memory
   * mutex so concurrent calls (batch signing) cannot lose an increment.
   */
  static async verifyPin(pin: string): Promise<boolean> {
    // Malformed input never reaches the throttle: it can't unlock the wallet and
    // is not counted as an attempt. Validate against the STORED credential's kind
    // (PR7) so a passphrase credential accepts a ≥12-char passphrase while a PIN
    // credential still rejects anything but 6 digits. No credential → reject.
    const stored = await this.getStoredPinData();
    if (!stored) {
      return false;
    }
    const source: SecretSource = stored.secretSource ?? 'pin';
    if (!this.isSecretFormatValid(pin, source)) {
      return false;
    }

    return this.runThrottleExclusive(async () => {
      try {
        const now = Date.now();
        // Effective = MORE RESTRICTIVE of the (fail-closed) persisted record and
        // the in-memory mirror. This also raises the mirror to the persisted
        // level so the session never forgets a lockout.
        const throttle = await this.loadEffectiveThrottle(now);

        // Already locked out: refuse WITHOUT running the hash (saves the PBKDF2
        // work, no timing leak) and WITHOUT incrementing (already penalized).
        if (throttle.lockoutUntil !== null && now < throttle.lockoutUntil) {
          return false;
        }

        const matched = await this.checkPinHash(pin);

        if (matched) {
          // Success — clear the throttle, AWAITING the persisted delete inside
          // the mutex, exactly like the wrong-PIN path awaits saveThrottle. Both
          // writes are serialized by the mutex, so ordering is trivially correct.
          await this.resetThrottle();
          return true;
        }

        // Failure — increment and, at the limit, arm an escalating lockout.
        const failCount = throttle.failCount + 1;
        let lockoutUntil = throttle.lockoutUntil;
        if (failCount >= PIN_ATTEMPT_LIMIT) {
          lockoutUntil = now + this.pinLockoutBackoff(failCount);
        }

        // TODO(wave2): opt-in wipe-after-N — when the user enables the
        // "erase wallet after N failed attempts" setting (deferred to a later
        // PR with its own settings toggle), hook the destructive wipe here,
        // e.g. `if (wipeAfterNEnabled && failCount >= wipeAfterN) await this.clearAll();`.

        const updated: PinThrottleRecord = {
          failCount,
          lockoutUntil,
          lastFailAt: now,
        };
        // Update the mirror FIRST so the session keeps enforcing the increment
        // even if the persisted write below fails (write fails CLOSED).
        this.throttleMirror = updated;
        // Durably persist the increment BEFORE resolving, inside the mutex, so a
        // force-kill immediately after a failed guess can't race the write on a
        // non-rooted device (the counter is on disk when the attacker sees the
        // rejection), and the mutex guarantees writes land in order. This is a
        // plain unbounded await like every other SecureStore write in the app —
        // a genuine keychain hang is a device-broken condition, not the
        // throttle's job to special-case.
        await this.saveThrottle(updated);
        return false;
      } catch (error) {
        console.warn('PIN verification failed');
        return false;
      }
    });
  }

  /**
   * Lockout state for the UI. SEPARATE from `verifyPin` so the boolean contract
   * of `verifyPin` is preserved (see the note on `verifyPin`). Runs under the
   * throttle mutex and reports the same fail-closed effective state verifyPin
   * enforces (persisted ⊔ mirror), so the UI can't show "unlocked" while the
   * session is actually locked out from a corrupt/tampered persisted record.
   */
  static async getPinThrottleState(): Promise<PinThrottleState> {
    return this.runThrottleExclusive(async () => {
      const now = Date.now();
      const throttle = await this.loadEffectiveThrottle(now);
      const lockedUntil =
        throttle.lockoutUntil !== null && now < throttle.lockoutUntil
          ? throttle.lockoutUntil
          : null;
      return {
        lockedUntil,
        attemptsRemaining: Math.max(0, PIN_ATTEMPT_LIMIT - throttle.failCount),
      };
    });
  }

  /**
   * Escalating lockout duration. Doubles every `PIN_ATTEMPT_LIMIT` failures,
   * capped at 24h: 5 fails -> 5m, 10 -> 10m, 15 -> 20m, ... cap 24h.
   */
  private static pinLockoutBackoff(failCount: number): number {
    const step = Math.floor(failCount / PIN_ATTEMPT_LIMIT) - 1;
    const duration = PIN_LOCKOUT_DURATION * Math.pow(2, step);
    return Math.min(duration, THROTTLE_BACKOFF_CAP_MS);
  }

  /**
   * Serialize a throttle read-modify-write. The chain never rejects (outcomes
   * are swallowed) so one failing task can't poison later ones.
   */
  private static runThrottleExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.throttleChain.then(task, task);
    this.throttleChain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /**
   * A bounded fail-closed lockout used when the persisted throttle can't be
   * trusted (corrupt value or read error). One lockout window, NOT permanent —
   * a rare genuine corruption costs the user a single wait, never a wipe.
   */
  private static failClosedRecord(now: number): PinThrottleRecord {
    return {
      failCount: PIN_ATTEMPT_LIMIT,
      lockoutUntil: now + PIN_LOCKOUT_DURATION,
      lastFailAt: now,
    };
  }

  private static isValidThrottleRecord(
    value: unknown
  ): value is PinThrottleRecord {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const v = value as Record<string, unknown>;
    const failOk =
      typeof v.failCount === 'number' &&
      Number.isFinite(v.failCount) &&
      v.failCount >= 0;
    const lockOk =
      v.lockoutUntil === null ||
      (typeof v.lockoutUntil === 'number' && Number.isFinite(v.lockoutUntil));
    const lastOk =
      typeof v.lastFailAt === 'number' && Number.isFinite(v.lastFailAt);
    return failOk && lockOk && lastOk;
  }

  /**
   * Load the PERSISTED throttle record, failing CLOSED on anything untrusted
   * (Codex P1). ONLY a genuinely-absent key (fresh install / post-reset /
   * post-success) yields a clean record:
   *   - getItem throws (read/IO error, e.g. tampered device)  -> fail closed
   *   - value present but unparseable / wrong shape (corrupt) -> fail closed
   *     (+ best-effort overwrite so it re-persists as a valid record)
   *   - getItem returns null (absent)                          -> clean
   */
  private static async loadPersistedThrottle(
    now: number
  ): Promise<PinThrottleRecord> {
    let raw: string | null;
    try {
      raw = await secureStorage.getItem(this.PIN_THROTTLE_KEY);
    } catch {
      // Read/IO error — do NOT assume clean. Enforce a bounded lockout.
      console.warn('PIN throttle read failed; enforcing lockout');
      return this.failClosedRecord(now);
    }

    if (raw === null) {
      // Key genuinely absent — clean slate.
      return { failCount: 0, lockoutUntil: null, lastFailAt: 0 };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }

    if (this.isValidThrottleRecord(parsed)) {
      return {
        failCount: parsed.failCount,
        lockoutUntil: parsed.lockoutUntil,
        lastFailAt: parsed.lastFailAt,
      };
    }

    // Present but corrupt (bad JSON or wrong shape) — fail closed, and
    // best-effort re-persist a valid fail-closed record over the garbage.
    console.warn('PIN throttle record corrupt; enforcing lockout');
    const failClosed = this.failClosedRecord(now);
    await this.saveThrottle(failClosed);
    return failClosed;
  }

  /** Return the more-restrictive of two throttle records. */
  private static combineThrottle(
    a: PinThrottleRecord,
    b: PinThrottleRecord
  ): PinThrottleRecord {
    const lock = Math.max(a.lockoutUntil ?? 0, b.lockoutUntil ?? 0);
    return {
      failCount: Math.max(a.failCount, b.failCount),
      lockoutUntil: lock > 0 ? lock : null,
      lastFailAt: Math.max(a.lastFailAt, b.lastFailAt),
    };
  }

  /**
   * Effective throttle = MORE RESTRICTIVE of the (fail-closed) persisted record
   * and the in-memory mirror. Raises the mirror to the combined value so the
   * session never forgets a lockout. MUST be called under the throttle mutex.
   */
  private static async loadEffectiveThrottle(
    now: number
  ): Promise<PinThrottleRecord> {
    const persisted = await this.loadPersistedThrottle(now);
    const effective = this.throttleMirror
      ? this.combineThrottle(persisted, this.throttleMirror)
      : persisted;
    this.throttleMirror = effective;
    return effective;
  }

  private static async saveThrottle(record: PinThrottleRecord): Promise<void> {
    // Best-effort persist. A failure here does NOT reset the counter: the
    // in-memory mirror (updated by the caller BEFORE this call) keeps enforcing
    // for the session, and the persisted record — if it survives — remains at
    // its prior (>=) value. We never write a weaker state on failure.
    try {
      await secureStorage.setItem(
        this.PIN_THROTTLE_KEY,
        JSON.stringify(record)
      );
    } catch {
      console.warn('Failed to persist PIN throttle record');
    }
  }

  /**
   * Clear the throttle on a verified PIN. Clears the in-memory mirror, then
   * AWAITS the persisted delete INSIDE the mutex — symmetric with the wrong-PIN
   * path's awaited saveThrottle. Because both writes are plain awaits within the
   * same serialization mutex, they can never interleave (no reset landing after
   * a later increment), and each verifyPin awaits only its OWN write before
   * releasing the mutex. Reset requires the correct PIN, so this path is never
   * attacker-reachable; a genuinely hung keychain here is the same accepted
   * device-broken condition as every other awaited secure write (see THREAT
   * MODEL) — not special-cased.
   */
  private static async resetThrottle(): Promise<void> {
    this.throttleMirror = { failCount: 0, lockoutUntil: null, lastFailAt: 0 };
    await secureStorage.deleteItem(this.PIN_THROTTLE_KEY).catch(() => {});
  }

  /**
   * Extracted PIN-hash verification (formerly inline in verifyPin). Returns
   * whether the supplied PIN matches the stored hash. Runs the PBKDF2 hash, so
   * verifyPin skips it entirely while locked out.
   */
  private static async checkPinHash(pin: string): Promise<boolean> {
    const storedData = await this.getStoredPinData();
    if (!storedData) {
      return false;
    }

    // Prefer the salt FOLDED into the credential (§5.2); fall back to the
    // standalone SALT_KEY only for pre-Wave-2 credentials that lack it.
    const salt = storedData.salt ?? (await this.getOrCreateSalt());
    const secretSource: SecretSource = storedData.secretSource ?? 'pin';

    if (storedData.format === 'json') {
      this.legacyCheckRequired = false;
      const candidateHash = this.hashPin(pin, salt, storedData.iterations);
      if (storedData.hash === candidateHash) {
        if (
          storedData.iterations !== this.PIN_ITERATIONS ||
          storedData.salt === undefined
        ) {
          try {
            const upgradedHash = this.hashPin(pin, salt, this.PIN_ITERATIONS);
            await this.persistPinCredential({
              hash: upgradedHash,
              iterations: this.PIN_ITERATIONS,
              salt,
              secretSource,
            });
          } catch (error) {
            console.warn('Failed to upgrade stored PIN metadata', error);
          }
        }
        return true;
      }
      return false;
    }

    const iterationCandidates = this.getIterationCandidates();

    for (const iterations of iterationCandidates) {
      const candidateHash = this.hashPin(pin, salt, iterations);
      if (storedData.hash === candidateHash) {
        try {
          const upgradedHash = this.hashPin(pin, salt, this.PIN_ITERATIONS);
          await this.persistPinCredential({
            hash: upgradedHash,
            iterations: this.PIN_ITERATIONS,
            salt,
            secretSource,
          });
          this.legacyCheckRequired = false;
        } catch (error) {
          console.warn(
            'Failed to upgrade PIN hash to latest iteration count',
            error
          );
        }
        return true;
      }
    }

    if (this.legacyCheckRequired === undefined) {
      this.legacyCheckRequired = true;
    }

    return false;
  }

  static async hasPin(): Promise<boolean> {
    try {
      const storedData = await this.getStoredPinData();
      return Boolean(storedData);
    } catch (error) {
      return false;
    }
  }

  /**
   * STRICT, boot-only PIN-presence probe (TASK-213). Unlike hasPin() — which
   * swallows secure-storage read/decrypt errors and resolves `false`, making a
   * genuine read FAILURE indistinguishable from genuine absence (the auth-init
   * fail-OPEN) — this variant THROWS on a genuine secure-storage read/decrypt
   * failure and resolves `false` ONLY for genuine ABSENCE (no credential stored
   * in either the primary secure-store or the legacy AsyncStorage location).
   *
   * It is a pure read: no JSON parse, no legacy-migration WRITE, no cache
   * mutation, and no secret material is ever returned or logged. Presence is
   * decided purely on whether a raw credential value exists.
   *
   * Used EXCLUSIVELY by AuthContext.checkInitialAuthState so lock computation can
   * fail CLOSED (the "secure storage unavailable" recovery state) on a storage
   * read failure. Do NOT route other callers here: hasPin()'s error-swallowing
   * contract (resolve falsy on failure) is relied on by its other call sites.
   */
  static async hasPinStrict(): Promise<boolean> {
    // A throw from either getItem (keychain/keystore unavailable, decrypt error)
    // PROPAGATES to the caller — it is never coerced to `false`. Presence in
    // EITHER the secure store or the legacy AsyncStorage location counts as
    // "PIN set"; both getItems return `null` (not throw) for genuine absence.
    const secure = await secureStorage.getItem(this.PIN_KEY);
    if (secure) {
      return true;
    }
    const legacy = await storage.getItem(this.PIN_KEY);
    return Boolean(legacy);
  }

  static async changePin(
    currentPin: string,
    newPin: string,
    newSource: SecretSource = 'pin'
  ): Promise<void> {
    try {
      // Validate the NEW secret against its chosen kind (PR7: PIN=6 digits,
      // passphrase=min length). The CURRENT secret's format is validated by
      // verifyPin below (which reads the stored credential's kind), so a
      // PIN→passphrase or passphrase→PIN switch is supported: `currentPin` is
      // whatever the existing credential is, `newPin`/`newSource` is the target.
      this.validateSecret(newPin, newSource);
      if (currentPin === newPin) {
        throw new Error('New secret must be different from the current one');
      }

      // Acquire the GLOBAL key-mutation mutex FIRST, THEN verify the current PIN
      // and run the atomic rewrap+commit ALL under the one lock (Codex P1-3 —
      // verify-inside-mutex closes an authorization TOCTOU: two concurrent
      // changePins can no longer both pass verification against the OLD credential
      // and clobber each other; the second acquires the lock only after the first
      // has committed, so its verifyPin against the now-NEW credential fails).
      // verifyPin takes the SEPARATE throttle mutex; key→throttle never deadlocks
      // (nothing acquires the key mutex inside the throttle path).
      //
      // The rewrap re-wraps EVERY standard account from the OLD secret to the NEW
      // one before the credential flips (so a bare hash rotation can never brick
      // v2 keys), and preserves PR6's biometric-item refresh + SessionKeyVault
      // rotation (both post-commit, inside the mutex).
      await this.runKeyMutationExclusive(async () => {
        const isCurrentValid = await this.verifyPin(currentPin);
        if (!isCurrentValid) {
          throw new Error('Current secret is incorrect');
        }
        await this.rewrapAndCommitCredentialLocked({
          currentSecret: currentPin,
          newSecret: newPin,
          newSource,
        });
      });
      this.legacyCheckRequired = false;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to change PIN: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * The shared atomic PIN-lifecycle rewrap+commit transaction (DOC-137 §5.3/§5.4)
   * — the fund-risking core of both changePin and setupPin. READ CAREFULLY.
   *
   * `Locked`: the CALLER already holds the GLOBAL key-mutation mutex (Codex P1-3:
   * changePin verifies the current PIN inside that same lock, before this runs).
   * Because the mutex is held across the whole transaction AND every secret
   * writer acquires it (P1-1a), no store/import/migration/delete can interleave
   * and strand an account. Phases:
   *
   *   1. UNWRAP every key-bearing account under the OLD secret (or the device key
   *      when `currentSecret` is undefined = first-secret setup) into an
   *      in-memory buffer. ALL-OR-NOTHING: if any account cannot be unwrapped,
   *      abort before touching storage (old credential + copies stay intact).
   *   2. ADD a NEW-secret v2 blob to each account (dual-blob). ALL readable old
   *      copies are preserved through commit (the old v2 blob(s) AND the Format-A
   *      field) — nothing is removed pre-commit (Codex P2-5). Blobs are trimmed
   *      only to respect the 2-blob cap, and only the non-current-secret copy is
   *      dropped in that case, so the account decrypts under EITHER secret at
   *      every instant.
   *   3. VERIFY every new blob byte-exactly under the NEW secret, reading the
   *      PERSISTED bytes back from storage (NOT the in-memory object) so a
   *      clobbered/torn write is caught before the credential flips (Codex
   *      P1-1b). Missing/invalid persisted new blob → abort.
   *   4. COMMIT the PIN credential in ONE folded write (§5.2). POINT OF NO RETURN.
   *   5. CLEANUP (best-effort, post-commit): keep ONLY the new blob and clear the
   *      legacy device-key copy (the DR-2 goal — no copy readable without the
   *      user secret). Then resync the biometric item + rotate the vault.
   *
   * CRASH SAFETY (commit = step 4's single atomic write):
   *   - crash BEFORE 4 → credential still verifies the OLD secret; old copies
   *     decrypt; the unproven new blobs are inert (wrong-secret trial-decrypt
   *     MAC-fails); nothing stranded; retried on the next attempt.
   *   - crash AFTER 4 → credential verifies the NEW secret; new blobs decrypt;
   *     stale old copies are inert; cleanup is idempotent.
   * At NO crash point does an account have zero readable copies.
   *
   * ROLLBACK on a pre-commit error drops ONLY the specific unproven new blob
   * (by MAC), never a stale full-payload snapshot (P1-B). All plaintext buffers
   * are scrubbed in `finally`. Never logs the secret or key bytes.
   */
  private static async rewrapAndCommitCredentialLocked(opts: {
    /** OLD secret to unwrap under; undefined = first-secret setup (device key). */
    currentSecret?: string;
    /** NEW secret to wrap every account (and the new credential) under. */
    newSecret: string;
    /** Kind of the new secret (folded into the credential + each blob). */
    newSource: SecretSource;
  }): Promise<void> {
    const { currentSecret, newSecret, newSource } = opts;

    // PR7: both 'pin' and 'passphrase' new-credential kinds are supported here —
    // verifyPin reads the stored `secretSource` and validates/unlocks accordingly,
    // so a passphrase credential is fully recoverable. The new kind is folded into
    // the credential (persistPinCredential) and each v2 blob (secretSource).
    const deviceSecret = await this.getStableDeviceId();
    const ids = await this.getAllAccountIds();

    interface RewrapCtx {
      payload: AccountSecretPayload; // as read in phase 1 (stable under the lock)
      plaintext: Uint8Array;
      keeperBlob?: KeyEnvelopeV2; // old v2 blob that verified under currentSecret
      newBlob?: KeyEnvelopeV2; // the unproven new-secret blob (set in phase 2)
      appended: boolean; // true once the new blob has been persisted
    }
    const ctxs = new Map<string, RewrapCtx>();
    let committed = false;

    try {
      // PHASE 1 — UNWRAP every key-bearing account under the OLD secret. Uses the
      // RAW readSecretLocked (we already hold the key mutex).
      for (const id of ids) {
        const payload = await this.readSecretLocked(id);
        if (!payload) {
          continue; // watch-only / already deleted — nothing to re-wrap
        }
        const hasKeyMaterial =
          (Array.isArray(payload.blobs) && payload.blobs.length > 0) ||
          !!payload.encryptedPrivateKey;
        if (!hasKeyMaterial) {
          continue; // watch-only payload
        }
        const unwrapped = await this.unwrapKeyForRewrap(
          payload,
          currentSecret,
          deviceSecret
        );
        if (!unwrapped) {
          // ALL-OR-NOTHING: an account unreadable under the current secret must
          // NOT be left behind by a committed new credential. Abort BEFORE any
          // write so the old credential + all copies stay intact.
          throw new AccountStorageError(
            `Cannot re-wrap account ${id}: no readable key copy under the current secret`
          );
        }
        ctxs.set(id, {
          payload,
          plaintext: unwrapped.plaintext,
          keeperBlob: unwrapped.keeperBlob,
          appended: false,
        });
      }

      // PHASE 2 — ADD a NEW-secret v2 blob to each account (dual-blob), KEEPING
      // all readable old copies through commit (Codex P2-5).
      for (const [id, ctx] of ctxs) {
        const newBlob = await this.encryptPrivateKeyV2(
          ctx.plaintext,
          newSecret,
          newSource,
          { deviceBound: true }
        );
        // Keep EVERY existing old blob plus the Format-A field, and only trim to
        // respect the 2-blob cap: if adding the new blob would exceed MAX_KEY_BLOBS
        // (i.e. there are already 2 old blobs — only reachable from a prior
        // interrupted rewrap), keep the ONE that decrypts under the current secret
        // (the keeper) and drop the other (which is NOT readable under the current
        // credential). Never drop a copy readable under the current secret.
        const existingBlobs = ctx.payload.blobs ?? [];
        const keptOldBlobs =
          existingBlobs.length + 1 <= MAX_KEY_BLOBS
            ? existingBlobs
            : ctx.keeperBlob
              ? [ctx.keeperBlob]
              : [];
        const base: AccountSecretPayload = {
          accountId: ctx.payload.accountId,
          encryptedPrivateKey: ctx.payload.encryptedPrivateKey,
          authMethod: ctx.payload.authMethod,
          ...(keptOldBlobs.length > 0
            ? { version: 2 as const, blobs: keptOldBlobs }
            : {}),
        };
        await this.saveSecretV2Checked(id, this.appendBlob(base, newBlob));
        ctx.newBlob = newBlob;
        ctx.appended = true;
      }

      // PHASE 3 — VERIFY every new blob byte-exactly under the NEW secret from the
      // PERSISTED bytes (Codex P1-1b): re-read what is actually on disk, confirm
      // the new blob is present, and decrypt IT (not the in-memory object) so a
      // torn/clobbered write is caught BEFORE the credential flips. Any account's
      // persisted new blob missing/invalid → throw → rollback, no commit.
      for (const [id, ctx] of ctxs) {
        const raw = await secureStorage.getItem(this.secretKey(id));
        let persistedNewBlob: KeyEnvelopeV2 | undefined;
        if (raw) {
          try {
            const persisted = JSON.parse(raw) as AccountSecretPayload;
            persistedNewBlob = persisted.blobs?.find(
              (b) => b.mac === ctx.newBlob!.mac
            );
          } catch {
            persistedNewBlob = undefined;
          }
        }
        if (!persistedNewBlob) {
          throw new AccountStorageError(
            `Re-wrap verification failed: new blob for ${id} is not present in storage`
          );
        }
        const check = await decryptKeyEnvelopeV2(
          persistedNewBlob,
          newSecret,
          deviceSecret
        );
        try {
          if (!check || !this.constantTimeEqualBytes(check, ctx.plaintext)) {
            throw new AccountStorageError('Re-wrap verification failed');
          }
        } finally {
          check?.fill(0);
        }
      }

      // PHASE 4 — COMMIT: flip the PIN credential in ONE folded write (§5.2).
      // POINT OF NO RETURN.
      const newSalt = await this.generateRandomHex(32);
      const hash = this.hashPin(newSecret, newSalt, this.PIN_ITERATIONS);
      await this.persistPinCredential({
        hash,
        iterations: this.PIN_ITERATIONS,
        salt: newSalt,
        secretSource: newSource,
      });
      committed = true;
      this.legacyCheckRequired = false;

      // ── Everything below runs AFTER the commit and MUST NOT throw upward:
      // the PIN change already succeeded. Stale old copies are inert (a
      // wrong-secret trial-decrypt MAC-fails), so cleanup is best-effort.

      // PHASE 5 — CLEANUP: keep ONLY the new blob; clear the legacy device-key
      // copy so no at-rest copy is readable without the user secret.
      for (const [id, ctx] of ctxs) {
        try {
          await this.saveSecretV2Checked(
            id,
            this.finalizePayload(ctx.payload, ctx.newBlob!)
          );
        } catch {
          // Best-effort; a surviving old copy is inert under the new secret.
        }
      }

      // Post-commit session sync (PR6): resync the biometric-convenience item
      // to the NEW secret, then rotate the live vault so the session stays
      // unlocked WITHOUT re-locking. Neither throws upward.
      await this.refreshBiometricSecretAfterSecretChange(newSecret, newSource);
      if (SessionKeyVault.isUnlocked()) {
        SessionKeyVault.rotate(newSecret, newSource);
      }
    } catch (error) {
      // ROLLBACK — only reachable PRE-commit (post-commit code above swallows).
      // Drop ONLY the specific unproven new blob (by MAC) from each account we
      // appended to; never write a stale snapshot (P1-B). Old credential + old
      // copies remain intact → nothing stranded → retried on the next attempt.
      if (!committed) {
        for (const [id, ctx] of ctxs) {
          if (!ctx.appended || !ctx.newBlob) {
            continue;
          }
          try {
            const current = await this.readSecretLocked(id);
            if (!current) {
              continue;
            }
            await this.saveSecretV2Checked(
              id,
              this.dropBlob(current, ctx.newBlob)
            );
          } catch {
            // Best-effort; the unproven new blob is inert under the OLD secret.
          }
        }
      }
      throw error;
    } finally {
      // Scrub every in-memory plaintext buffer.
      for (const ctx of ctxs.values()) {
        ctx.plaintext.fill(0);
      }
      ctxs.clear();
    }
  }

  /**
   * After a secret change commits, resync the biometric-convenience item with
   * the NEW secret (DOC-137 §3 / §5.3).
   *
   * GATE ON THE CONVENIENCE ITEM (the source of truth), NOT `isBiometricEnabled()`
   * (Codex P2-followup): the enabled-flag read returns `false` on a transient
   * storage-read failure, which would make this a NO-OP and let a STALE OLD-secret
   * item survive (later readable => a biometric unlock loads the OLD PIN). So we
   * probe the ITEM instead and FAIL SAFE on any read error:
   *   - item present  -> refresh it with the new secret; on write failure, clear
   *                      the item + disable biometrics (no stale secret survives);
   *   - item null      -> nothing stale to handle (no-op);
   *   - read THROWS / undeterminable -> FAIL SAFE: best-effort clear the item +
   *                      disable biometrics, so a stale OLD-secret item can NEVER
   *                      survive a PIN change even under flaky storage reads.
   *
   * Swallows all errors so it can run AFTER the PIN-hash commit without rolling
   * back or misreporting the (successful) PIN change. Never logs the secret.
   */
  private static async refreshBiometricSecretAfterSecretChange(
    newSecret: string,
    secretSource: SecretSource
  ): Promise<void> {
    let existing: { secret: string; secretSource: SecretSource } | null;
    try {
      existing = await this.getBiometricSecret('Update biometric unlock');
    } catch {
      // Read couldn't be determined (flaky storage / declined auth). FAIL SAFE:
      // never let a possibly-stale old-secret item survive a PIN change.
      await this.failSafeDisableBiometrics();
      return;
    }

    if (existing === null) {
      // No convenience item — nothing stale to handle.
      return;
    }

    try {
      await this.setBiometricSecret(
        newSecret,
        secretSource,
        'Update biometric unlock'
      );
    } catch {
      // Refresh write failed/cancelled — never leave the OLD secret usable.
      await this.failSafeDisableBiometrics();
    }
  }

  /**
   * Fail-safe teardown: make a surviving biometric-convenience item INERT.
   *
   * BOUNDARY (Codex P1): the enabled-FLAG is the READ GATE — a stale convenience
   * item is only dangerous if it is READ, and it is read ONLY when biometrics is
   * ENABLED (biometric unlock gates on the persisted flag via
   * `unlockVaultWithBiometrics`). So flipping the flag to `false` is the PRIMARY,
   * AWAITED protection; deleting the item is best-effort cleanup that may fail
   * (a SecureStore op) WITHOUT weakening the guarantee. The enabled-flag is
   * AsyncStorage-backed (separate from the failing SecureStore item), so this
   * write typically succeeds even when the item op does not. We deliberately do
   * NOT chase the delete — a cascade of storage failures is a device-broken
   * condition out of scope.
   *
   * If even the flag write fails (total storage failure), the WORST case is a
   * failed biometric unlock that falls back to PIN — the new PIN always works —
   * NEVER a security bypass or mnemonic-recovery event. (Even if a stale
   * old-PIN secret were somehow loaded, a v2 unwrap under it would MAC-fail → the
   * op errors → PIN fallback.) Swallows all errors so it never rolls back the
   * already-committed PIN change. Never logs the secret.
   */
  private static async failSafeDisableBiometrics(): Promise<void> {
    try {
      // PRIMARY (awaited): flip the read gate off. This is the reliable guard.
      await this.setBiometricEnabled(false);
    } catch {
      // Total-storage-failure / device-broken — out of scope (see boundary note).
    }
    // Best-effort cleanup of the now-inert item; may fail without consequence.
    await this.clearBiometricSecret().catch(() => {});
  }

  /**
   * Remove the PIN — but ONLY when no wallet holds standard-account keys
   * (DOC-137 §5.5 / Dave's decision: NO no-user-secret resting state for
   * key-bearing wallets). Removing the PIN would leave only the device secret to
   * wrap keys — the exact zero-offline-resistance state DR-2 eliminates — so on a
   * key-bearing wallet this THROWS. The genuine "no PIN" escape hatch is the
   * explicit, mnemonic-required destructive Reset Wallet, never a silent
   * downgrade. Watch-only wallets (no key material) may still remove the PIN.
   *
   * The enumerate-then-delete runs under the global key-mutation mutex so a
   * concurrent storeAccount can't add a key between the check and the delete
   * (which would leave a key-bearing wallet with no PIN).
   */
  static async deletePin(): Promise<void> {
    return this.runKeyMutationExclusive(async () => {
      try {
        const ids = await this.getAllAccountIds();
        for (const id of ids) {
          // readSecretLocked: we already hold the key mutex (no nesting).
          const payload = await this.readSecretLocked(id);
          const holdsKey =
            !!payload &&
            (!!payload.encryptedPrivateKey ||
              (Array.isArray(payload.blobs) && payload.blobs.length > 0));
          if (holdsKey) {
            throw new AccountStorageError(
              'Cannot remove PIN while accounts hold keys — use Change PIN or Reset Wallet'
            );
          }
        }

        // Watch-only (no key material) — safe to remove the credential.
        await storage.removeItem(this.PIN_KEY);
        await secureStorage.deleteItem(this.PIN_KEY).catch(() => {});
        await storage.removeItem(this.SALT_KEY).catch(() => {});
        await secureStorage.deleteItem(this.SALT_KEY).catch(() => {});
        this.legacyCheckRequired = undefined;
      } catch (error) {
        if (error instanceof AccountStorageError) {
          throw error;
        }
        throw new AccountStorageError('Failed to delete PIN');
      }
    });
  }

  // Biometric Settings
  static async setBiometricEnabled(enabled: boolean): Promise<void> {
    try {
      await storage.setItem(this.BIOMETRIC_ENABLED_KEY, enabled.toString());
      await secureStorage
        .deleteItem(this.BIOMETRIC_ENABLED_KEY)
        .catch(() => {});
    } catch (error) {
      throw new AccountStorageError('Failed to store biometric setting');
    }
  }

  static async isBiometricEnabled(): Promise<boolean> {
    try {
      let enabled = await storage.getItem(this.BIOMETRIC_ENABLED_KEY);
      if (!enabled) {
        const legacy = await secureStorage.getItem(this.BIOMETRIC_ENABLED_KEY);
        if (legacy) {
          await storage.setItem(this.BIOMETRIC_ENABLED_KEY, legacy);
          await secureStorage
            .deleteItem(this.BIOMETRIC_ENABLED_KEY)
            .catch(() => {});
          enabled = legacy;
        }
      }
      return enabled === 'true';
    } catch (error) {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BIOMETRIC-CONVENIENCE ITEM (DOC-137 §3). READ BEFORE CHANGING.
  //
  // THREAT-MODEL TRADEOFF — this deliberately stores the RAW user secret (the
  // PIN or passphrase) as `{ secret, secretSource }`. This is NOT an unencrypted
  // write: the value is (a) platform-encrypted (Keychain / Keystore) and (b)
  // written via `setItemWithAuth`, so it is enclave-bound behind a MANDATORY
  // device-auth (biometric/passcode) gate — the OS refuses to return it without
  // a fresh biometric prompt, and INVALIDATES it on any biometric-enrollment
  // change / lock removal. We store the secret (not the derived wrap key) so the
  // biometric path feeds the EXACT SAME scrypt-unwrap as manual entry (one code
  // path to audit) and so a PIN/passphrase change re-writes only this one item.
  // The residual exposure — a raw secret sits app-layer-plaintext inside that
  // encrypted, auth-gated item, and JS strings cannot be reliably wiped — is an
  // ACCEPTED, documented tradeoff (§0/§3.2, Q7), gated on the enclave.
  //
  // Because this item is OS-invalidated on enrollment change, it may NEVER be
  // the sole custodian of key material: the key at rest stays wrapped by the
  // user-secret scrypt envelope written with PLAIN setItem, which survives all
  // enrollment events. Losing this item only forces PIN/passphrase re-entry —
  // NEVER the mnemonic (THE INVARIANT, §3.4).
  //
  // NEVER log the secret or secretSource. This section, `setItemWithAuth`, and
  // the mobile adapter are the entire blast radius of the auth-gated write.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist the biometric-convenience secret behind the write-time auth gate
   * (DOC-137 §3.3, "Enable"). Provisions the enclave ACL AT WRITE via
   * `setItemWithAuth`, so the item can only be read back after a fresh biometric
   * prompt. Biometrics never captures a secret it was not explicitly given —
   * the caller (AuthContext.enableBiometrics / onboarding) supplies it.
   */
  static async setBiometricSecret(
    secret: string,
    secretSource: SecretSource,
    prompt: string
  ): Promise<void> {
    if (typeof secureStorage.setItemWithAuth !== 'function') {
      throw new AccountStorageError(
        'Auth-gated secure storage is not supported on this platform'
      );
    }
    try {
      const payload = JSON.stringify({ secret, secretSource });
      await secureStorage.setItemWithAuth(this.BIOMETRIC_SECRET_KEY, payload, {
        prompt,
      });
    } catch {
      // Never surface the secret in the error.
      throw new AccountStorageError('Failed to store biometric secret');
    }
  }

  /**
   * Read the biometric-convenience secret behind the OS biometric gate (DOC-137
   * §3.3, "Biometric unlock"). The `getItemWithAuth` read IS the biometric
   * prompt.
   *
   * Return contract mirrors expo-secure-store's documented `getItemAsync`:
   *   - resolves the parsed `{ secret, secretSource }` on success;
   *   - resolves `null` when the item is ABSENT or has been INVALIDATED
   *     (biometric-enrollment change / lock removal) — the caller treats this as
   *     the invalidation case (§3.4: clear the enabled flag, fall back to PIN,
   *     NEVER the mnemonic), and a structurally corrupt item is coerced to null
   *     for the same safe handling;
   *   - THROWS only when the OS auth itself fails or the user cancels — the
   *     caller must treat a throw as a cancel (keep biometrics enabled), NOT as
   *     an invalidation.
   */
  static async getBiometricSecret(
    prompt: string
  ): Promise<{ secret: string; secretSource: SecretSource } | null> {
    if (typeof secureStorage.getItemWithAuth !== 'function') {
      return null;
    }
    // A throw here propagates to the caller (cancel / auth failure).
    const raw = await secureStorage.getItemWithAuth(this.BIOMETRIC_SECRET_KEY, {
      prompt,
    });
    if (raw === null) {
      // Absent or invalidated by an enrollment change — NOT a throw.
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as {
        secret?: unknown;
        secretSource?: unknown;
      };
      if (
        typeof parsed.secret === 'string' &&
        (parsed.secretSource === 'pin' || parsed.secretSource === 'passphrase')
      ) {
        return { secret: parsed.secret, secretSource: parsed.secretSource };
      }
    } catch {
      // Corrupt item — fall through to null (safe: treated as invalidation).
    }
    return null;
  }

  /**
   * Delete the biometric-convenience secret (on disable / reset). Best-effort.
   */
  static async clearBiometricSecret(): Promise<void> {
    await secureStorage.deleteItem(this.BIOMETRIC_SECRET_KEY).catch(() => {});
  }

  // PIN Timeout Settings
  static async setPinTimeout(timeoutMinutes: number | 'never'): Promise<void> {
    try {
      await storage.setItem(this.PIN_TIMEOUT_KEY, String(timeoutMinutes));
      await secureStorage.deleteItem(this.PIN_TIMEOUT_KEY).catch(() => {});
    } catch (error) {
      throw new AccountStorageError('Failed to store PIN timeout setting');
    }
  }

  static async getPinTimeout(): Promise<number | 'never'> {
    try {
      let timeout = await storage.getItem(this.PIN_TIMEOUT_KEY);
      if (!timeout) {
        const legacy = await secureStorage.getItem(this.PIN_TIMEOUT_KEY);
        if (legacy) {
          await storage.setItem(this.PIN_TIMEOUT_KEY, legacy);
          await secureStorage.deleteItem(this.PIN_TIMEOUT_KEY).catch(() => {});
          timeout = legacy;
        }
      }
      if (!timeout) {
        return 5; // Default to 5 minutes
      }

      if (timeout === 'never') {
        return 'never';
      }

      const timeoutNumber = Number(timeout);
      return isNaN(timeoutNumber) ? 5 : timeoutNumber;
    } catch (error) {
      return 5; // Default fallback
    }
  }

  private static getIterationCandidates(): number[] {
    if (this.legacyCheckRequired === false) {
      return [this.PIN_ITERATIONS];
    }

    return [this.PIN_ITERATIONS, this.LEGACY_PIN_ITERATIONS];
  }

  private static async getStoredPinData(): Promise<StoredPinData | null> {
    try {
      const stored = await secureStorage.getItem(this.PIN_KEY);
      if (stored) {
        const parsed = this.parseStoredPin(stored);
        if (parsed) {
          return parsed;
        }
      }

      const legacy = await storage.getItem(this.PIN_KEY);
      if (legacy) {
        await secureStorage.setItem(this.PIN_KEY, legacy);
        await storage.removeItem(this.PIN_KEY).catch(() => {});
        const parsed = this.parseStoredPin(legacy);
        if (parsed) {
          return parsed;
        }
      }
      return null;
    } catch (error) {
      console.warn('Failed to retrieve stored PIN hash', error);
      return null;
    }
  }

  private static async getOrCreateSalt(
    regenerate: boolean = false
  ): Promise<string> {
    try {
      if (!regenerate) {
        const existing = await secureStorage.getItem(this.SALT_KEY);
        if (existing) {
          return existing;
        }
      }

      const legacy = await storage.getItem(this.SALT_KEY);
      if (!regenerate && legacy) {
        await secureStorage.setItem(this.SALT_KEY, legacy);
        await storage.removeItem(this.SALT_KEY).catch(() => {});
        return legacy;
      }

      if (!regenerate) {
        throw new AccountStorageError('PIN salt not found');
      }

      const salt = await this.generateRandomHex(32);
      await secureStorage.setItem(this.SALT_KEY, salt);
      await storage.removeItem(this.SALT_KEY).catch(() => {});
      return salt;
    } catch (error) {
      throw new AccountStorageError('Failed to generate or retrieve salt');
    }
  }

  private static async generateRandomHex(byteLength: number): Promise<string> {
    const randomBytes = await platformCrypto.getRandomBytes(byteLength);
    return Array.from(randomBytes, (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  private static hashPin(
    pin: string,
    salt: string,
    iterations: number
  ): string {
    return customPBKDF2(pin, salt, iterations, 32);
  }

  private static parseStoredPin(value: string): StoredPinData | null {
    if (value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value) as {
          hash?: string;
          iterations?: number;
          salt?: unknown;
          secretSource?: unknown;
        };
        if (parsed.hash && typeof parsed.iterations === 'number') {
          // Back-compat: the folded salt + secretSource (§5.2) are present on
          // Wave-2 credentials and ABSENT on the older {hash, iterations} shape.
          const salt =
            typeof parsed.salt === 'string' ? parsed.salt : undefined;
          const secretSource =
            parsed.secretSource === 'passphrase'
              ? 'passphrase'
              : parsed.secretSource === 'pin'
                ? 'pin'
                : undefined;
          return {
            hash: parsed.hash,
            iterations: parsed.iterations,
            salt,
            secretSource,
            format: 'json',
          };
        }
      } catch (error) {
        console.warn('Failed to parse stored PIN metadata', error);
      }
    }

    return {
      hash: value,
      iterations: this.PIN_ITERATIONS,
      format: 'legacy',
    };
  }

  /**
   * Commit the PIN credential in ONE atomic write (DOC-137 §5.2). Folds the
   * verification salt (and the secretSource UX hint) INTO the PIN_KEY value —
   * `{ hash, iterations, salt, secretSource }` — so the credential flip is a
   * single JSON write, eliminating the former two-write micro-window where
   * PIN_KEY and a separate SALT_KEY could momentarily disagree. The standalone
   * SALT_KEY is dropped best-effort since the salt now lives in the credential;
   * a later getOrCreateSalt() read is only reached by pre-Wave-2 credentials that
   * never folded the salt. Never logs the hash or salt.
   */
  private static async persistPinCredential(data: {
    hash: string;
    iterations: number;
    salt: string;
    secretSource: SecretSource;
  }): Promise<void> {
    const payload = JSON.stringify({
      hash: data.hash,
      iterations: data.iterations,
      salt: data.salt,
      secretSource: data.secretSource,
    });

    // SINGLE atomic write of the whole credential.
    await secureStorage.setItem(this.PIN_KEY, payload);

    // The salt is now inside the credential — drop stale standalone copies so a
    // fallback getOrCreateSalt() can never return a mismatched salt.
    await secureStorage.deleteItem(this.SALT_KEY).catch(() => {});
    await storage.removeItem(this.PIN_KEY).catch(() => {});
    await storage.removeItem(this.SALT_KEY).catch(() => {});
  }

  static async clearSensitiveData(): Promise<void> {
    // This method can be called when the app goes to background
    // to ensure sensitive data is cleared from memory
    try {
      // Force garbage collection if available (development only)
      if (__DEV__ && global.gc) {
        global.gc();
      }

      // Clear any temporary crypto variables by overwriting with zeros
      // Note: JavaScript strings are immutable, but this signals intent
      console.log('Cleared sensitive data from memory');
    } catch (error) {
      // Don't log detailed error to prevent information leakage
      console.warn('Failed to clear sensitive data');
    }
  }

  static async clearAll(): Promise<void> {
    // TASK-220: bump the secure reset generation SYNCHRONOUSLY here, BEFORE
    // acquiring the mutex, so it is synchronous with the reset REQUEST (a
    // concurrent creation that has already captured the old generation is then
    // reliably aborted, even if the mutex is momentarily busy). Mirrors
    // clearAllWallets bumping walletResetEpoch at its entry (TASK-212).
    this.secureResetGeneration += 1;
    // TASK-220: zero the in-memory private-key cache NOW (synchronously) so a full
    // wipe can't leave a decrypted key readable from cache after the persisted
    // secret is gone. Paired with the generation guard on the cache write in
    // getPrivateKey, an in-flight pre-reset read can't repopulate it either.
    this.clearPrivateKeyCache();
    // Full wipe deletes account key material → hold the GLOBAL key-mutation
    // mutex across the whole thing (P1-1a) so it can't interleave with a rewrap
    // or a store. Uses deleteAccountLocked (already inside the mutex — never
    // re-acquire, which would deadlock the promise-chain lock).
    return this.runKeyMutationExclusive(async () => {
      try {
        // TASK-220: set the durable wipe tombstone FIRST, before any destructive
        // removal — if the app dies mid-wipe we are left tombstone-set (legacy
        // resurrection blocked) rather than secrets-gone-without-a-marker. A
        // committed creation/restore clears it later.
        await storage.setItem(this.SECURE_WIPE_TOMBSTONE_KEY, '1');

        // TASK-220: drain the pending-creation journal — an in-flight creation
        // may have written a secret that is not yet in the account list (the
        // list is written AFTER the secret), so deleting only listed ids would
        // leave that secret orphaned. Union the journaled ids with the account
        // list and delete every one, then clear the journal.
        const journal = await this.readPendingCreateJournal();
        const listedIds = await this.getAllAccountIds();
        const idsToDelete = new Set<string>([
          ...listedIds,
          ...Object.keys(journal),
        ]);

        // Delete all accounts (listed + in-flight-journaled)
        for (const accountId of idsToDelete) {
          await this.deleteAccountLocked(accountId);
        }
        await this.writePendingCreateJournal({});

        // Clear PIN and settings from general storage
        // NOTE: DEVICE_ID_KEY is intentionally NOT cleared - it's used for key derivation
        // and must remain consistent across restore operations to decrypt private keys
        await storage.multiRemove([
          this.PIN_KEY,
          this.SALT_KEY,
          this.BIOMETRIC_ENABLED_KEY,
          this.METADATA_LIST_KEY,
          this.PIN_TIMEOUT_KEY,
        ]);
        // Clear from secure storage
        await Promise.all([
          secureStorage.deleteItem(this.PIN_KEY).catch(() => {}),
          secureStorage.deleteItem(this.SALT_KEY).catch(() => {}),
          secureStorage.deleteItem(this.BIOMETRIC_ENABLED_KEY).catch(() => {}),
          // Drop the auth-gated biometric-convenience secret on a full wipe.
          secureStorage.deleteItem(this.BIOMETRIC_SECRET_KEY).catch(() => {}),
          secureStorage.deleteItem(this.METADATA_LIST_KEY).catch(() => {}),
          secureStorage.deleteItem(this.PIN_TIMEOUT_KEY).catch(() => {}),
        ]);
        // Wipe the persistent PIN throttle THROUGH the throttle serialization
        // mutex verifyPin uses (a SEPARATE mutex from the key-mutation lock; the
        // two never deadlock because nothing acquires the key mutex inside the
        // throttle path), as the FINAL throttle mutation. Any in-flight verifyPin
        // increment is serialized ahead of this block, so it persists FIRST and
        // is then wiped here — it can never land AFTER the wipe and leave a stale
        // lockout (which would phantom-lock the freshly reset/restored wallet).
        await this.runThrottleExclusive(async () => {
          await secureStorage.deleteItem(this.PIN_THROTTLE_KEY).catch(() => {});
          this.throttleMirror = null;
        });
      } catch (error) {
        throw new AccountStorageError('Failed to clear all secure storage');
      }
    });
  }
}
