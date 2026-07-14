/**
 * SessionKeyVault (Wave-2, DR-2 / DOC-137 §6, PR3)
 *
 * An in-memory-ONLY singleton that holds the unlocked-session user secret and a
 * memoized, per-account at-rest wrap key. It is the replacement custodian for
 * the callers that today pass `pin=undefined` and rely on the ambient device-key
 * wrap + the 60 s plaintext-key cache (DOC-137 §6.1). Under the future
 * user-secret wrap (PR4/PR5) those callers derive the wrap key from the vault
 * secret; in THIS PR keys are still Format A, so the vault is populated on unlock
 * but the device-key path still performs decryption — no behavior change.
 *
 * NEVER PERSISTED: this state lives only for the process/session. It is cleared
 * on every lock (explicit / inactivity / background-grace) via
 * AuthContext.lock() (DOC-137 §6.3).
 *
 * WHY CACHE THE WRAP KEY, NOT THE PRIVATE KEY (DOC-137 §6.2): scrypt is
 * deliberately expensive, so it must not run per signature; the cheap AES-CTR
 * unwrap from a cached wrap key lets each getPrivateKey unwrap freshly (and the
 * caller zeroes the seed). This is strictly LESS sensitive than the status quo
 * 60 s full-private-key cache.
 *
 * VAULT EPOCH (Codex P1-D): a monotonic `epoch` is bumped on every secret-state
 * transition (set / rotate / clear). Any async key op captures the epoch before
 * its awaits and, after each await, ABORTS (returns no material, caches nothing)
 * if the epoch changed — so an in-flight scrypt started before a lock cannot
 * return or cache key material after the lock.
 *
 * SECURITY: this module never logs the secret, the derived wrap key, or any
 * private key. Wrap-key buffers are zeroed (`fill(0)`) whenever they leave the
 * cache (clear / rotate / re-set) or when an epoch-abort discards a fresh
 * derivation. JS strings (the secret) cannot be reliably wiped; the vault holds
 * exactly one reference and drops it on clear.
 */

import { deriveWrapKey, AT_REST_KDF_PARAMS } from './envelopeV2';
import type { ScryptKdfParams } from '../backup/types';

/** Which kind of user secret currently unlocks the session (UX hint only). */
export type SecretSource = 'pin' | 'passphrase';

/**
 * Thrown by `getWrapKey` when no key material can be safely returned: the vault
 * is locked at call time, or its epoch changed mid-derivation (Codex P1-D). It
 * carries NO key material and never includes the secret in its message.
 */
export class VaultLockedError extends Error {
  constructor(message = 'SessionKeyVault is locked') {
    super(message);
    this.name = 'VaultLockedError';
  }
}

interface GetWrapKeyOptions {
  /** scrypt params to derive with (defaults to AT_REST_KDF_PARAMS). */
  kdfParams?: ScryptKdfParams;
  /** Device id for the optional post-mix; omit for a non-device-bound key. */
  deviceSecret?: string;
}

class SessionKeyVaultImpl {
  /** The active session secret (PIN or passphrase). null => locked. */
  private secret: string | null = null;
  /** UX hint mirroring the unlocking secret's kind. */
  private secretSource: SecretSource = 'pin';
  /** Memoized deriveWrapKey() outputs keyed by accountId (the R2 cache). */
  private readonly wrapKeys: Map<string, Uint8Array> = new Map();
  /** Monotonic epoch; bumped on every set / rotate / clear (Codex P1-D). */
  private epoch = 0;

  /** True while a session secret is held. */
  isUnlocked(): boolean {
    return this.secret !== null;
  }

  /** The current monotonic epoch (Codex P1-D abort anchor). */
  currentEpoch(): number {
    return this.epoch;
  }

  /**
   * The active session secret, or null when locked. Callers MUST NOT log it and
   * MUST NOT retain it beyond the immediate derivation.
   */
  getSecret(): string | null {
    return this.secret;
  }

  /** The active secret's kind (UX hint only — never a decryption gate). */
  getSecretSource(): SecretSource {
    return this.secretSource;
  }

  /**
   * Populate the vault at unlock. Any previously memoized wrap keys are zeroed
   * and dropped (a fresh unlock starts clean), and the epoch is bumped so an
   * in-flight derivation from a prior session aborts.
   */
  set(secret: string, source: SecretSource): void {
    this.zeroWrapKeys();
    this.secret = secret;
    this.secretSource = source;
    this.epoch++;
  }

  /**
   * Change the session secret WITHOUT re-locking (used by changePin/passphrase
   * change so the session survives the rotation — DOC-137 §6.3). Memoized wrap
   * keys were derived under the OLD secret, so they are zeroed + dropped and the
   * epoch is bumped (an in-flight old-secret derivation must abort).
   */
  rotate(newSecret: string, newSource?: SecretSource): void {
    this.zeroWrapKeys();
    this.secret = newSecret;
    if (newSource) {
      this.secretSource = newSource;
    }
    this.epoch++;
  }

  /**
   * Lazily derive (and memoize) the per-account at-rest wrap key via scrypt.
   * scrypt runs at most once per account per session; subsequent calls return
   * the memoized buffer. The returned buffer is OWNED by the vault — callers
   * MUST treat it as read-only and MUST NOT zero it (the vault zeroes it on
   * clear/rotate).
   *
   * Epoch guard (Codex P1-D): the epoch is captured before the scrypt await; if
   * it changes during derivation (a concurrent set/rotate/clear — e.g. a lock),
   * the fresh key is zeroed, nothing is cached, and VaultLockedError is thrown so
   * no post-lock key material is ever returned.
   *
   * @throws VaultLockedError if locked at call time or if the epoch changed mid-derivation.
   */
  async getWrapKey(
    accountId: string,
    saltHex: string,
    options?: GetWrapKeyOptions
  ): Promise<Uint8Array> {
    const secret = this.secret;
    if (secret === null) {
      throw new VaultLockedError();
    }

    // Memoize per (accountId, salt): a re-wrap transiently holds two blobs with
    // DIFFERENT salts (the "dual slot"), so each blob must derive/cache its own
    // wrap key rather than collide on accountId alone.
    const cacheKey = this.wrapKeyCacheKey(accountId, saltHex);
    const memoized = this.wrapKeys.get(cacheKey);
    if (memoized) {
      return memoized;
    }

    const startEpoch = this.epoch;
    const kdfParams = options?.kdfParams ?? AT_REST_KDF_PARAMS;
    const derived = await deriveWrapKey(
      secret,
      saltHex,
      kdfParams,
      options?.deviceSecret
    );

    // Epoch guard: the session that requested this key no longer exists.
    if (this.epoch !== startEpoch) {
      derived.fill(0);
      throw new VaultLockedError(
        'SessionKeyVault epoch changed during derivation'
      );
    }

    // A concurrent call for the same (account, salt) may have populated the memo
    // while we were deriving; prefer the existing entry and drop our duplicate
    // so the cache holds exactly one buffer per (account, salt).
    const raced = this.wrapKeys.get(cacheKey);
    if (raced) {
      derived.fill(0);
      return raced;
    }

    this.wrapKeys.set(cacheKey, derived);
    return derived;
  }

  /**
   * Lock the vault: zero every memoized wrap-key buffer, drop the secret, and
   * bump the epoch so any in-flight derivation aborts (Codex P1-D). Idempotent.
   */
  clear(): void {
    this.zeroWrapKeys();
    this.secret = null;
    this.epoch++;
  }

  /** Composite memo key for the (accountId, salt) pair. The salt is a fixed-
   *  length hex string, so joining with a separator is unambiguous. */
  private wrapKeyCacheKey(accountId: string, saltHex: string): string {
    return `${accountId}|${saltHex}`;
  }

  /** Zero and drop every memoized wrap key (defense-in-depth scrub). */
  private zeroWrapKeys(): void {
    this.wrapKeys.forEach((key) => key.fill(0));
    this.wrapKeys.clear();
  }
}

/** The process-wide, in-memory-only session key vault singleton. */
export const SessionKeyVault = new SessionKeyVaultImpl();
