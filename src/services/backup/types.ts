/**
 * Backup/Restore Types
 *
 * Type definitions for the wallet backup and restore functionality.
 */

import { AccountType, RemoteSignerAuthLevel } from '@/types/wallet';
import { Friend } from '@/types/social';
import { NetworkId } from '@/types/network';

/**
 * The main backup file structure (before encryption)
 */
export interface VoiBackupFile {
  /** Backup format version - for future compatibility */
  version: 1;
  /** ISO timestamp when backup was created */
  createdAt: string;
  /** App version that created the backup */
  appVersion: string;
  /** All accounts with their data */
  accounts: BackupAccountData[];
  /** User settings */
  settings: BackupSettings;
  /** Friends list */
  friends: Friend[];
  /** Experimental feature flags */
  experimental: BackupExperimentalFlags;
  /**
   * Present only on an INCOMPLETE backup (TASK-504): the accounts whose keys
   * the file does not hold. Address, label and reason only, never key material.
   * Its presence and the v3 envelope must agree; a new app refuses a file where
   * they do not.
   */
  incomplete?: BackupIncomplete;
}

/** Why an account's key is not in an incomplete backup. */
export type BackupLeftOutReason =
  /** The wallet holds no key for this account (a clean absence). */
  | 'no-key-on-device'
  /** The wallet expects a key it could not read (decrypt, integrity, mismatch,
   *  a standard account with no key). A possible key problem. */
  | 'key-unreadable';

export interface BackupLeftOutAccount {
  address: string;
  label?: string;
  reason: BackupLeftOutReason;
}

export interface BackupIncomplete {
  leftOut: BackupLeftOutAccount[];
}

/**
 * Account data in backup format
 */
export interface BackupAccountData {
  /** Unique account identifier */
  id: string;
  /** Algorand address */
  address: string;
  /** Account type */
  type: AccountType;
  /** User-defined label */
  label?: string;
  /** UI color identifier */
  color?: string;
  /** Public key in hex format */
  publicKey: string;
  /** Creation timestamp */
  createdAt: string;
  /** Import timestamp (for imported accounts) */
  importedAt?: string;
  /** Avatar URL from Envoi */
  avatarUrl?: string;
  /** Whether account is hidden in UI */
  isHidden: boolean;

  // Standard account fields (type === 'standard')
  /** 25-word recovery phrase - SENSITIVE */
  mnemonic?: string;
  /** HD derivation path if applicable */
  derivationPath?: string;
  /**
   * LEGACY flag meaning "a mnemonic was supplied for this account" (see
   * StandardAccountMetadata.hasBackup). Kept for wire compatibility with
   * existing backup payloads.
   *
   * NOTE (TASK-45 / DR-11): `backupVerified` is deliberately NOT part of this
   * format and must never be added. Recovery-phrase verification is a property
   * of the device/user that performed it, not of the encrypted payload — a
   * restore on a new device always starts unverified so the user is prompted to
   * confirm the phrase there.
   */
  hasBackup?: boolean;

  // Watch account fields (type === 'watch')
  /** Source of the watch account */
  source?: string;
  /** User notes about this account */
  notes?: string;

  // Rekeyed account fields (type === 'rekeyed')
  /** Address that has signing authority */
  authAddress?: string;
  /** When the account was rekeyed */
  rekeyedAt?: string;
  /** Whether this wallet was the original owner */
  originalOwner?: boolean;
  /** Whether we have the signing key for the auth address */
  canSign?: boolean;
  /** Original account address if we rekeyed it */
  rekeyedFrom?: string;

  // Ledger account fields (type === 'ledger')
  /** Unique Ledger device identifier */
  deviceId?: string;
  /** Account derivation index on device */
  derivationIndex?: number;
  /** BIP-44 derivation path */
  ledgerDerivationPath?: string;
  /** User-friendly device alias */
  deviceName?: string;

  // Remote Signer account fields (type === 'remote_signer')
  /** Unique identifier of the signer device */
  signerDeviceId?: string;
  /** User-friendly signer device name */
  signerDeviceName?: string;
  /** ISO timestamp when account was paired */
  pairedAt?: string;
  /** ISO timestamp of last signing activity */
  lastSigningActivity?: string;
  /** Pairing authentication level (defaults to 'v1-unsigned' when absent) */
  authLevel?: RemoteSignerAuthLevel;
}

/**
 * Settings backup structure
 */
export interface BackupSettings {
  /** Theme settings */
  theme: BackupThemeSettings;
  /** Security settings */
  security: BackupSecuritySettings;
  /** Selected network */
  network: NetworkId | null;
  /** Asset filter/sort preferences */
  assetFilters: BackupAssetFilterSettings;
  /** Remote signer settings (optional for backward compatibility) */
  remoteSigner?: BackupRemoteSignerSettings;
}

/**
 * Remote signer settings for backup
 */
export interface BackupRemoteSignerSettings {
  /** App mode: 'wallet' or 'signer' */
  appMode: 'wallet' | 'signer';
  /** Signer device configuration (when in signer mode) */
  signerConfig: BackupSignerConfig | null;
  /** Paired signer devices (when in wallet mode) */
  pairedSigners: BackupPairedSigner[];
}

/**
 * Signer device configuration for backup
 */
export interface BackupSignerConfig {
  /** Unique device identifier */
  deviceId: string;
  /** User-defined device name */
  deviceName: string;
  /** Whether to require PIN for each transaction */
  requirePinPerTxn: boolean;
}

/**
 * Paired signer device info for backup
 */
export interface BackupPairedSigner {
  /** Unique device identifier */
  deviceId: string;
  /** Device name from pairing */
  deviceName?: string;
  /** Timestamp of initial pairing (Unix ms) */
  pairedAt: number;
  /** Addresses managed by this signer */
  addresses: string[];
  /** Last successful signing activity (Unix ms) */
  lastActivity?: number;
}

/**
 * Theme settings for backup
 */
export interface BackupThemeSettings {
  /** Theme mode: light, dark, or system */
  mode: 'light' | 'dark' | 'system';
  /** NFT theme data if set */
  nftTheme: BackupNFTTheme | null;
  /** Whether NFT theme is enabled */
  nftThemeEnabled: boolean;
  /** Selected palette index (0-2) */
  selectedPaletteIndex: number;
  /** Whether background image is enabled */
  backgroundImageEnabled: boolean;
  /** Overlay intensity (0-1) */
  overlayIntensity: number;
}

/**
 * NFT theme data for backup
 */
export interface BackupNFTTheme {
  /** NFT contract/asset ID */
  nftId: string;
  /** NFT image URL */
  imageUrl: string;
  /** Extracted color palettes */
  palettes: string[][];
  /** Selected palette index */
  selectedPaletteIndex: number;
}

/**
 * Security settings for backup
 * Note: PIN hash is NOT backed up - user sets new PIN on restore
 */
export interface BackupSecuritySettings {
  /** PIN timeout in minutes, or 'never' */
  pinTimeout: number | 'never';
  /** Whether biometric auth is enabled */
  biometricEnabled: boolean;
}

/**
 * Asset filter/sort settings for backup
 */
export interface BackupAssetFilterSettings {
  /** Sort field */
  sortBy: 'name' | 'balance' | 'value';
  /** Sort direction */
  sortOrder: 'asc' | 'desc';
  /** Balance threshold filter */
  balanceThreshold: number;
  /** USD value threshold filter */
  valueThreshold: number;
  /** Whether to show native tokens first */
  nativeTokensFirst: boolean;
}

/**
 * Experimental feature flags for backup
 */
export interface BackupExperimentalFlags {
  /** Swap feature enabled */
  swapEnabled: boolean;
  /** Messaging feature enabled */
  messagingEnabled: boolean;
}

/**
 * scrypt KDF parameters (v2 envelope).
 *
 * Memory footprint of scrypt is ~128 * N * r bytes. These are validated and
 * capped before the KDF runs (see encryption.ts) so a tampered/oversized
 * backup can never force a huge allocation.
 */
export interface ScryptKdfParams {
  /** CPU/memory cost — must be a power of two */
  N: number;
  /** Block size */
  r: number;
  /** Parallelization */
  p: number;
  /** Derived key length in bytes (32 for AES-256) */
  dkLen: number;
}

/**
 * v1 encrypted backup envelope (PBKDF2-SHA256 + AES-256-CTR + HMAC).
 *
 * LEGACY / read-only: new backups are written as v2, but existing v1 files MUST
 * still decrypt. Do not change this shape or the v1 decrypt path.
 */
export interface EncryptedBackupFileV1 {
  /** File format identifier */
  format: 'voibackup';
  /** Encryption format version */
  version: 1;
  /** Salt for PBKDF2 key derivation (hex) */
  salt: string;
  /** Initialization vector for AES (hex) */
  iv: string;
  /** Encrypted backup data (base64) */
  ciphertext: string;
  /** HMAC for authentication (hex) */
  hmac: string;
}

/**
 * v2 encrypted backup envelope (scrypt + AES-256-CTR + encrypt-then-MAC).
 *
 * The HMAC binds the envelope parameters (version/kdf/kdfParams/salt/iv), not
 * just the ciphertext, so none of them can be tampered without failing the
 * integrity check (see canonicalV2Aad in encryption.ts).
 */
export interface EncryptedBackupFileV2 {
  /** File format identifier */
  format: 'voibackup';
  /** Encryption format version */
  version: 2;
  /** Key derivation function identifier */
  kdf: 'scrypt';
  /** scrypt parameters (validated + capped before use) */
  kdfParams: ScryptKdfParams;
  /** Salt for scrypt key derivation (hex) */
  salt: string;
  /** Initialization vector for AES (hex) */
  iv: string;
  /** Encrypted backup data (base64) */
  ciphertext: string;
  /** HMAC over canonical(envelope params) + ciphertext (hex) */
  hmac: string;
}

/**
 * v3 encrypted backup envelope: the v2 construction (scrypt + AES-256-CTR +
 * encrypt-then-MAC) under version 3. It is written only for an INCOMPLETE
 * backup (TASK-504), so an app that predates it refuses the file at the
 * envelope (VERSION_MISMATCH, before any decrypt) and never restores it with a
 * wipe that would destroy a key the file leaves out. The version is inside the
 * MAC's authenticated parameters, so editing it to 2 fails the integrity check
 * on every build. The envelope carries the version only: no address, label or
 * count lives outside the encryption.
 */
export interface EncryptedBackupFileV3 extends Omit<
  EncryptedBackupFileV2,
  'version'
> {
  version: 3;
}

/**
 * Encrypted backup file structure (written to .voibackup file).
 *
 * Discriminated union on `version`: v1 = legacy PBKDF2, v2 = scrypt.
 */
export type EncryptedBackupFile =
  EncryptedBackupFileV1 | EncryptedBackupFileV2 | EncryptedBackupFileV3;

/**
 * Result of creating a backup
 */
export interface BackupResult {
  rekeyedKeyCount?: number;
  /** Generated filename */
  filename: string;
  /** File URI in cache directory */
  fileUri: string;
  /** Raw file content for saving */
  fileContent: string;
  /** File size in bytes */
  size: number;
  /** Number of accounts backed up */
  accountCount: number;
  /** Backup creation timestamp */
  createdAt: string;
  /** Total accounts in the wallet when the backup was taken */
  totalAccountCount: number;
  /** Set when any key was left out: the file is incomplete (TASK-504) */
  incomplete?: BackupIncomplete;
}

/**
 * What restore did with one record of the file (TASK-504). Every record gets
 * exactly one result; anything other than `added` or `added-in-place` means the
 * device was left as it was for that record.
 */
export type RestoreRecordOutcome =
  /** Added under the id the file gave it. */
  | 'added'
  /** Added under a fresh id because the file's id names an occupied key slot. */
  | 'added-new-id'
  /** Added against a key already on this device that derives to the same address. */
  | 'added-in-place'
  /** Same id and same address already on this device. */
  | 'already-present'
  /** The address is already on this device under another id or type. */
  | 'kept-device-record'
  /**
   * The address is on this device with a key slot proven empty, and the file
   * holds the key (report input only: it decides no write).
   */
  | 'device-key-unreadable'
  /**
   * The address is on this device and its stored key is not readable here, or
   * reads as another account's, or the read failed. The file holds the key.
   */
  | 'device-key-problem'
  /**
   * The address is on this device as a record that holds no key (Watch Only,
   * Ledger or Airgap). `deviceType` names which. The file's key was not added.
   */
  | 'device-keyless'
  /** The id is on this device with a different address. */
  | 'rejected-id-conflict'
  /** The id's key slot holds a different key that derives to another address. */
  | 'rejected-slot-occupied'
  /** A key for this record could not be placed safely. */
  | 'rejected-no-safe-slot'
  /** The record lacks fields restore needs (for example a signer device). */
  | 'rejected-invalid';

/**
 * Options for a restore that runs on the old-PIN screen (TASK-504, DOC-507 4.1
 * item 9). `epoch` is the session vault's epoch recorded when the old PIN was
 * verified IN THIS restore. A key-less rekeyed record may keep its id over a
 * surviving key only while the vault still holds exactly what that verify put in
 * it; an epoch that moved stops the restore at the next record boundary.
 */
export interface RestoreOptions {
  oldPinSession?: { epoch: number };
  /**
   * The forgotten-PIN step (DOC-507 section 5): remove the old PIN credential
   * first (step B), then restore add-only. Never together with `oldPinSession`.
   */
  removeOldPin?: boolean;
}

export interface RestoreRecordResult {
  id: string;
  address: string;
  label?: string;
  outcome: RestoreRecordOutcome;
  /** The id the record was stored under, when it differs from the file's. */
  storedId?: string;
  /** The type of the key-less device record, for `device-keyless` only. */
  deviceType?:
    AccountType.WATCH | AccountType.LEDGER | AccountType.REMOTE_SIGNER;
}

/**
 * Result of restoring a backup
 */
export interface RestoreResult {
  /** One result per record of the file (TASK-504) */
  records: RestoreRecordResult[];
  /** Number of accounts restored */
  accountCount: number;
  /** Number of Ledger accounts (metadata only) */
  ledgerAccountCount: number;
  /** Number of standard accounts with keys */
  standardAccountCount: number;
  /** Number of watch accounts */
  watchAccountCount: number;
  /** Number of rekeyed accounts */
  rekeyedAccountCount: number;
  /** Number of remote signer accounts */
  remoteSignerAccountCount: number;
  /** Records dropped because another record had the same address (TASK-423) */
  duplicateAccountsDropped: number;
  /** Whether settings were restored */
  settingsRestored: boolean;
  /** Number of friends restored */
  friendsCount: number;
  /** Whether remote signer settings were restored */
  remoteSignerSettingsRestored: boolean;
  /** Airgap signer pairings the file held, none of which are restored */
  pairedSignersNotRestored: number;
  /** An incomplete file's left-out accounts, so the report can name them */
  leftOut?: BackupLeftOutAccount[];
}

/**
 * Backup file info (from validation before restore)
 */
export interface BackupInfo {
  /** When the backup was created */
  createdAt: string;
  /** App version that created the backup */
  appVersion: string;
  /** Total account count */
  accountCount: number;
  /** Account breakdown by type */
  accountTypes: {
    standard: number;
    watch: number;
    rekeyed: number;
    ledger: number;
    remoteSigner: number;
  };
  /** Whether backup contains friends */
  hasFriends: boolean;
  /** Number of friends in backup */
  friendsCount: number;
  /** Whether backup contains remote signer settings */
  hasRemoteSignerSettings: boolean;
  /** Set when the file is incomplete: the accounts whose keys it lacks */
  incomplete?: BackupIncomplete;
  /** What a restore would add, for the forgotten-PIN consent screen */
  restorePlan: {
    total: number;
    addable: number;
    addableWithKey: number;
    notAdded: { label?: string; address: string }[];
  };
}

/**
 * Backup creation progress
 */
export interface BackupProgress {
  /** Current step */
  step: 'collecting' | 'encrypting' | 'saving';
  /** Progress percentage (0-100) */
  progress: number;
  /** Current step description */
  message: string;
}

/**
 * Restore progress
 */
export interface RestoreProgress {
  /** Current step */
  step: 'reading' | 'decrypting' | 'validating' | 'restoring';
  /** Progress percentage (0-100) */
  progress: number;
  /** Current step description */
  message: string;
}

/**
 * Backup service errors
 */
export class BackupError extends Error {
  constructor(
    message: string,
    public code: BackupErrorCode
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export type BackupErrorCode =
  | 'INVALID_PASSWORD'
  | 'WEAK_PASSWORD'
  | 'INVALID_FILE_FORMAT'
  | 'DECRYPTION_FAILED'
  | 'INTEGRITY_CHECK_FAILED'
  | 'VERSION_MISMATCH'
  | 'COLLECTION_FAILED'
  | 'ENCRYPTION_FAILED'
  | 'FILE_WRITE_FAILED'
  | 'FILE_READ_FAILED'
  | 'RESTORE_FAILED'
  | 'AUTHENTICATION_REQUIRED';
