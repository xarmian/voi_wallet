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
} from '../../types/wallet';
import {
  KeyEnvelopeV2,
  decryptKeyEnvelopeV2,
  MAX_KEY_BLOBS,
} from './envelopeV2';
import { SECURITY_CONFIG } from '../../config/security';

// Persistent PIN throttle (DOC-137 §8 / TASK-26). PIN_ATTEMPT_LIMIT = fails per
// window before a lockout; PIN_LOCKOUT_DURATION = base lockout, doubled each
// window (see pinLockoutBackoff). Wired from the previously-dead security config.
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
  private static readonly DEVICE_ID_KEY = 'voi_device_installation_id';
  private static readonly PIN_TIMEOUT_KEY = 'voi_pin_timeout_setting';
  private static readonly PIN_THROTTLE_KEY = 'voi_pin_throttle';

  // In-memory promise-chain mutex serializing the throttle read-modify-write so
  // concurrent verifyPin calls (e.g. batch signing) can never lose an
  // increment. Modeled on the inFlightRequests dedup below.
  private static throttleChain: Promise<unknown> = Promise.resolve();

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

  // Iteration counts optimized for mobile performance while maintaining security
  // SecureStore provides hardware-backed encryption, so lower iterations are acceptable
  private static readonly ENCRYPTION_KEY_ITERATIONS = 10000;
  // PIN verification now uses a hardware-backed store; tune iterations for mobile hardware
  private static readonly PIN_ITERATIONS = 8000;
  private static readonly LEGACY_PIN_ITERATIONS = 1000;
  private static readonly PREVIOUS_PIN_ITERATIONS: number[] = [];

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

  private static async readSecret(
    accountId: string
  ): Promise<AccountSecretPayload | null> {
    try {
      const stored = await secureStorage.getItem(this.secretKey(accountId));
      if (stored) {
        return JSON.parse(stored) as AccountSecretPayload;
      }

      // Fall back to legacy storage for migration
      const migrated = await this.migrateLegacyAccountData(accountId);
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

  private static async migrateLegacyAccountData(
    accountId: string
  ): Promise<PersistedAccountMetadata | null> {
    try {
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

      // Encrypt and store private key for Standard accounts
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
          const biometricEnabled = await this.isBiometricEnabled();

          if (biometricEnabled) {
            try {
              secretPayloadRaw = await secureStorage.getItemWithAuth(
                this.secretKey(accountId),
                { prompt: 'Authenticate to access private key' }
              );
            } catch (error) {
              throw new AuthenticationRequiredError(
                'Biometric authentication failed or was cancelled'
              );
            }
          } else {
            const hasPin = await this.hasPin();
            if (hasPin) {
              throw new AuthenticationRequiredError(
                'PIN required to access private key'
              );
            }

            try {
              secretPayloadRaw = await secureStorage.getItem(
                this.secretKey(accountId)
              );
            } catch (error) {
              throw new AccountRetrievalError(
                'Failed to retrieve account data'
              );
            }
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

        // Candidate 1 (v2 blobs) — tried FIRST when a verified user secret is
        // available. INERT today: no production writer emits blobs yet, so every
        // existing payload (no `blobs`) skips this and behaves exactly as before.
        // Security anchor: every accepted result MUST pass the envelope MAC — a
        // wrong secret cannot forge it, so the ladder simply falls through.
        if (pin && Array.isArray(parsed.blobs) && parsed.blobs.length > 0) {
          privateKey = await this.tryDecryptV2Blobs(parsed.blobs, pin);
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
        }

        await this.updateLastAccessed(accountId);

        // Cache the key for subsequent calls (60-second TTL)
        this.privateKeyCache.set(cacheKey, {
          key: new Uint8Array(privateKey), // Store a copy
          timestamp: Date.now(),
        });

        return privateKey;
      } catch (error) {
        if (
          error instanceof AccountNotFoundError ||
          error instanceof AccountStorageError ||
          error instanceof AuthenticationRequiredError ||
          error instanceof AccountRetrievalError
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
   * Trial-decrypt the v2 blob candidates under a verified user secret
   * (DOC-137 §4.3, candidate 1). Returns the first blob whose envelope MAC
   * verifies, or `undefined` to fall through to the legacy formats.
   *
   * Only up to MAX_KEY_BLOBS blobs are attempted — each attempt runs a memory-
   * hard scrypt, so capping the attempt count is itself a DoS guard. A wrong
   * secret cannot forge the MAC, so a non-matching blob returns null and the
   * ladder continues.
   */
  private static async tryDecryptV2Blobs(
    blobs: KeyEnvelopeV2[],
    secret: string
  ): Promise<Uint8Array | undefined> {
    const deviceSecret = await this.getStableDeviceId();
    for (const blob of blobs.slice(0, MAX_KEY_BLOBS)) {
      try {
        const privateKey = await decryptKeyEnvelopeV2(
          blob,
          secret,
          deviceSecret
        );
        if (privateKey) {
          return privateKey;
        }
      } catch {
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
  static async storePin(pin: string): Promise<void> {
    try {
      if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
        throw new Error('PIN must be 6 digits');
      }

      const salt = await this.getOrCreateSalt(true);
      const hashedPin = this.hashPin(pin, salt, this.PIN_ITERATIONS);

      await this.persistPinHash(hashedPin, salt);
      this.legacyCheckRequired = false;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to store PIN: ${error instanceof Error ? error.message : 'Unknown error'}`
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
    // is not produced by the UI (which only submits 6 digits), so it is not
    // counted as an attempt.
    if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
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
          // Success — clear the throttle so the user starts from a clean slate.
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

  private static async resetThrottle(): Promise<void> {
    // Clear BOTH the session mirror and the persisted record on a verified PIN.
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

    const salt = await this.getOrCreateSalt();

    if (storedData.format === 'json') {
      this.legacyCheckRequired = false;
      const candidateHash = this.hashPin(pin, salt, storedData.iterations);
      if (storedData.hash === candidateHash) {
        if (storedData.iterations !== this.PIN_ITERATIONS) {
          try {
            const upgradedHash = this.hashPin(pin, salt, this.PIN_ITERATIONS);
            await this.persistPinHash(upgradedHash, salt);
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
        if (iterations !== this.PIN_ITERATIONS) {
          try {
            const upgradedHash = this.hashPin(pin, salt, this.PIN_ITERATIONS);
            await this.persistPinHash(upgradedHash, salt);
            this.legacyCheckRequired = false;
          } catch (error) {
            console.warn(
              'Failed to upgrade PIN hash to latest iteration count',
              error
            );
          }
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

  static async changePin(currentPin: string, newPin: string): Promise<void> {
    try {
      // Validate inputs
      if (
        !currentPin ||
        currentPin.length !== 6 ||
        !/^\d{6}$/.test(currentPin)
      ) {
        throw new Error('Current PIN must be 6 digits');
      }
      if (!newPin || newPin.length !== 6 || !/^\d{6}$/.test(newPin)) {
        throw new Error('New PIN must be 6 digits');
      }
      if (currentPin === newPin) {
        throw new Error('New PIN must be different from current PIN');
      }

      // Verify current PIN first
      const isCurrentValid = await this.verifyPin(currentPin);
      if (!isCurrentValid) {
        throw new Error('Current PIN is incorrect');
      }

      // Generate a fresh salt for the new PIN
      const salt = await this.getOrCreateSalt(true);
      const hashedNewPin = this.hashPin(newPin, salt, this.PIN_ITERATIONS);

      await this.persistPinHash(hashedNewPin, salt);
      this.legacyCheckRequired = false;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to change PIN: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async deletePin(): Promise<void> {
    try {
      await storage.removeItem(this.PIN_KEY);
      await secureStorage.deleteItem(this.PIN_KEY).catch(() => {});
      await storage.removeItem(this.SALT_KEY).catch(() => {});
      await secureStorage.deleteItem(this.SALT_KEY).catch(() => {});
      this.legacyCheckRequired = undefined;
    } catch (error) {
      throw new AccountStorageError('Failed to delete PIN');
    }
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
        };
        if (parsed.hash && typeof parsed.iterations === 'number') {
          return {
            hash: parsed.hash,
            iterations: parsed.iterations,
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

  private static async persistPinHash(
    hash: string,
    salt: string,
    iterations: number = this.PIN_ITERATIONS
  ): Promise<void> {
    const payload = JSON.stringify({ hash, iterations });

    await secureStorage.setItem(this.PIN_KEY, payload);
    await secureStorage.setItem(this.SALT_KEY, salt);

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
    try {
      const accountIds = await this.getAllAccountIds();

      // Delete all accounts
      for (const accountId of accountIds) {
        await this.deleteAccount(accountId);
      }

      // Clear PIN and settings from general storage
      // NOTE: DEVICE_ID_KEY is intentionally NOT cleared - it's used for key derivation
      // and must remain consistent across restore operations to decrypt private keys
      await storage.multiRemove([
        this.PIN_KEY,
        this.SALT_KEY,
        this.BIOMETRIC_ENABLED_KEY,
        this.METADATA_LIST_KEY,
        this.PIN_TIMEOUT_KEY,
        this.PIN_THROTTLE_KEY,
      ]);
      // Clear from secure storage
      await Promise.all([
        secureStorage.deleteItem(this.PIN_KEY).catch(() => {}),
        secureStorage.deleteItem(this.SALT_KEY).catch(() => {}),
        secureStorage.deleteItem(this.BIOMETRIC_ENABLED_KEY).catch(() => {}),
        secureStorage.deleteItem(this.METADATA_LIST_KEY).catch(() => {}),
        secureStorage.deleteItem(this.PIN_TIMEOUT_KEY).catch(() => {}),
        // Reset the persistent PIN throttle so a fresh wallet starts unlocked.
        secureStorage.deleteItem(this.PIN_THROTTLE_KEY).catch(() => {}),
      ]);
      // Also clear the in-memory throttle mirror so the fresh wallet isn't
      // held under a prior session's lockout.
      this.throttleMirror = null;
    } catch (error) {
      throw new AccountStorageError('Failed to clear all secure storage');
    }
  }
}
