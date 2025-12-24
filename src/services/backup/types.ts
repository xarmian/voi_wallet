/**
 * Backup/Restore Types
 *
 * Type definitions for the wallet backup and restore functionality.
 */

import { AccountType } from '@/types/wallet';
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
  /** Whether backup has been verified */
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
 * Encrypted backup file structure (written to .voibackup file)
 */
export interface EncryptedBackupFile {
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
 * Result of creating a backup
 */
export interface BackupResult {
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
}

/**
 * Result of restoring a backup
 */
export interface RestoreResult {
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
  /** Whether settings were restored */
  settingsRestored: boolean;
  /** Number of friends restored */
  friendsCount: number;
  /** Whether remote signer settings were restored */
  remoteSignerSettingsRestored: boolean;
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
  step: 'reading' | 'decrypting' | 'validating' | 'clearing' | 'restoring';
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
