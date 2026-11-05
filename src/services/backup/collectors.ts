/**
 * Backup Data Collectors
 *
 * Functions to collect all wallet data for backup.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { MultiAccountWalletService } from '@/services/wallet';
import { SecureKeyManager } from '@/services/secure/keyManager';
import {
  FreshAuthError,
  type FreshAuthCapability,
} from '@/services/secure/freshAuth';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import {
  AccountType,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  RemoteSignerAccountMetadata,
  withDefaultAuthLevel,
} from '@/types/wallet';
import { Friend } from '@/types/social';
import { NetworkId } from '@/types/network';
import {
  BackupAccountData,
  BackupSettings,
  BackupThemeSettings,
  BackupSecuritySettings,
  BackupAssetFilterSettings,
  BackupExperimentalFlags,
  BackupNFTTheme,
  BackupRemoteSignerSettings,
  BackupSignerConfig,
  BackupPairedSigner,
  BackupLeftOutAccount,
  BackupLeftOutReason,
  BackupError,
} from './types';

// Storage keys for various settings
const STORAGE_KEYS = {
  // Theme
  THEME_MODE: '@voi_wallet_theme_mode',
  NFT_THEME: '@voi_wallet_nft_theme',
  NFT_THEME_ENABLED: '@voi_wallet_nft_theme_enabled',
  NFT_THEME_PALETTE_INDEX: '@voi_wallet_nft_theme_palette_index',
  NFT_THEME_BACKGROUND_ENABLED: '@voi_wallet_nft_theme_background_enabled',
  NFT_THEME_OVERLAY_INTENSITY: '@voi_wallet_nft_theme_overlay_intensity',
  // Network
  NETWORK: 'voi_selected_network',
  // Security (PIN timeout - note: PIN hash is NOT backed up)
  PIN_TIMEOUT: 'voi_pin_timeout_minutes',
  BIOMETRIC_ENABLED: 'voi_biometric_enabled',
  // Asset filters
  ASSET_SORT_BY: '@wallet-asset-sort-by',
  ASSET_SORT_ORDER: '@wallet-asset-sort-order',
  ASSET_BALANCE_THRESHOLD: '@wallet-asset-filter-balance-threshold',
  ASSET_VALUE_THRESHOLD: '@wallet-asset-filter-value-threshold',
  ASSET_NATIVE_FIRST: '@wallet-asset-native-tokens-first',
  // Friends
  FRIENDS_LIST: '@friends/list',
  // Experimental (Zustand persist key)
  EXPERIMENTAL: 'experimental-features',
};

// Remote signer storage keys
const REMOTE_SIGNER_STORAGE_KEYS = {
  APP_MODE: '@voi_remote_signer_mode',
  SIGNER_CONFIG: '@voi_signer_config',
  PAIRED_SIGNERS: '@voi_paired_signers',
};

/** What collectAccounts hands back: the records to save, and every account
 *  whose key the file does not hold (TASK-504). */
export interface CollectedAccounts {
  accounts: BackupAccountData[];
  leftOut: BackupLeftOutAccount[];
  /** Accounts in the wallet when the backup was taken. */
  total: number;
}

const UNLOCK_MESSAGE = 'Unlock the wallet to create a backup';

type KeyOutcome =
  | { kind: 'exported'; mnemonic: string }
  | { kind: 'left-out'; reason: BackupLeftOutReason };

/**
 * TASK-504: what the wallet holds under ONE record's own id, and so whether its
 * key goes in the file. The decision rests on the secret under that id (never on
 * the record's type, and never on originalOwner, which can outlive the key,
 * TASK-425 U4); the type only says whether an absence is expected.
 *
 *  - a readable key that derives to the record's address: exported;
 *  - a slot proven empty: a clean absence ('no-key-on-device'); for a record
 *    that is expected to hold a key (STANDARD, or REKEYED with originalOwner) it
 *    is reported, otherwise the absence is expected and nothing is left out;
 *  - anything else (another account's key, something no reader opens, a read
 *    that failed): a key the wallet expects and cannot read, 'key-unreadable',
 *    never quietly skipped.
 * A locked vault or an unusable fresh-auth capability is a session state, not a
 * key problem: it stops the whole backup.
 */
async function collectKeyForRecord(
  account: { id: string; address: string },
  expectsKey: boolean,
  cap: FreshAuthCapability
): Promise<KeyOutcome | { kind: 'none' }> {
  let slot;
  try {
    slot = await AccountSecureStorage.inspectSecretSlot(
      account.id,
      account.address
    );
  } catch {
    // A read that failed is a key the wallet cannot read, not an empty slot.
    await stopIfLocked();
    return { kind: 'left-out', reason: 'key-unreadable' };
  }
  if (slot.vault === 'locked') await stopIfLocked();
  if (slot.state === 'empty') {
    return expectsKey
      ? { kind: 'left-out', reason: 'no-key-on-device' }
      : { kind: 'none' };
  }
  if (slot.state !== 'key-matches') {
    return { kind: 'left-out', reason: 'key-unreadable' };
  }
  try {
    const mnemonic = await SecureKeyManager.revealMnemonicForRecord(
      account,
      cap,
      'export_backup'
    );
    if (!mnemonic) return { kind: 'left-out', reason: 'key-unreadable' };
    return { kind: 'exported', mnemonic };
  } catch (error) {
    if (error instanceof FreshAuthError) {
      throw new BackupError(UNLOCK_MESSAGE, 'AUTHENTICATION_REQUIRED');
    }
    await stopIfLocked();
    return { kind: 'left-out', reason: 'key-unreadable' };
  }
}

/** A PIN device whose vault is locked cannot give any key: stop the backup. */
async function stopIfLocked(): Promise<void> {
  if (
    !SessionKeyVault.isUnlocked() &&
    (await AccountSecureStorage.hasPinStrict())
  ) {
    throw new BackupError(UNLOCK_MESSAGE, 'AUTHENTICATION_REQUIRED');
  }
}

/**
 * Collect all accounts with their data for backup.
 *
 * Saves what it can and names what it leaves out (TASK-504). Only a locked
 * vault or a fresh-auth failure stops the backup; every other account whose key
 * cannot be exported is left out of the file and listed in `leftOut`, so the
 * file is marked incomplete and the user is told which accounts and why.
 */
export async function collectAccounts(
  cap: FreshAuthCapability
): Promise<CollectedAccounts> {
  try {
    // Confirmed read (TASK-443): a swallowed read error or a timed-out legacy
    // read must fail the backup, never save an empty one that a later restore
    // would use to clear the wallet.
    const wallet = await MultiAccountWalletService.getCurrentWalletConfirmed();
    if (!wallet || wallet.accounts.length === 0) {
      return { accounts: [], leftOut: [], total: 0 };
    }

    // A locked vault stops the backup before anything is read: a skip here
    // would turn a locked session into a "successful" backup with no keys.
    if (
      wallet.accounts.some(
        (a) => a.type === AccountType.STANDARD || a.type === AccountType.REKEYED
      )
    ) {
      await stopIfLocked();
    }

    const backupAccounts: BackupAccountData[] = [];
    const leftOut: BackupLeftOutAccount[] = [];

    for (const account of wallet.accounts) {
      const baseData: BackupAccountData = {
        id: account.id,
        address: account.address,
        type: account.type,
        label: account.label,
        color: account.color,
        publicKey: account.publicKey,
        createdAt: account.createdAt,
        importedAt: account.importedAt,
        avatarUrl: account.avatarUrl,
        isHidden: account.isHidden,
      };

      switch (account.type) {
        case AccountType.STANDARD: {
          const standardAccount = account as StandardAccountMetadata;
          const outcome = await collectKeyForRecord(account, true, cap);
          if (outcome.kind === 'exported') {
            backupAccounts.push({
              ...baseData,
              mnemonic: outcome.mnemonic,
              derivationPath: standardAccount.derivationPath,
              hasBackup: standardAccount.hasBackup,
              // TASK-45/DR-11: `backupVerified` is intentionally NOT collected.
              // It describes what the user of THIS device proved, so it must not
              // travel inside a portable encrypted backup.
            });
          } else if (outcome.kind === 'left-out') {
            // A standard account the wallet expects a key for: no record that
            // could restore as an account able to sign goes in the file.
            leftOut.push({
              address: account.address,
              label: account.label,
              reason: 'key-unreadable',
            });
          }
          break;
        }

        case AccountType.WATCH: {
          const watchAccount = account as WatchAccountMetadata;
          backupAccounts.push({
            ...baseData,
            source: watchAccount.source,
            notes: watchAccount.notes,
          });
          break;
        }

        case AccountType.REKEYED: {
          const rekeyedAccount = account as RekeyedAccountMetadata;
          // originalOwner says a key is EXPECTED here; whether one is held is
          // read from the secret under this record's id.
          const outcome = await collectKeyForRecord(
            account,
            rekeyedAccount.originalOwner === true,
            cap
          );
          if (
            outcome.kind === 'left-out' &&
            outcome.reason === 'key-unreadable'
          ) {
            leftOut.push({
              address: account.address,
              label: account.label,
              reason: 'key-unreadable',
            });
            break;
          }
          if (outcome.kind === 'left-out') {
            // A clean absence on an account that should hold its key: the
            // metadata still goes in the file (as in 0.1.x), without a key.
            leftOut.push({
              address: account.address,
              label: account.label,
              reason: 'no-key-on-device',
            });
          }
          backupAccounts.push({
            ...baseData,
            mnemonic:
              outcome.kind === 'exported' ? outcome.mnemonic : undefined,
            hasBackup: rekeyedAccount.hasBackup,
            authAddress: rekeyedAccount.authAddress,
            rekeyedAt: rekeyedAccount.rekeyedAt,
            originalOwner: rekeyedAccount.originalOwner,
            canSign: rekeyedAccount.canSign,
            rekeyedFrom: rekeyedAccount.rekeyedFrom,
          });
          break;
        }

        case AccountType.LEDGER: {
          const ledgerAccount = account as LedgerAccountMetadata;
          // Only metadata for Ledger accounts - no secrets
          backupAccounts.push({
            ...baseData,
            deviceId: ledgerAccount.deviceId,
            derivationIndex: ledgerAccount.derivationIndex,
            ledgerDerivationPath: ledgerAccount.derivationPath,
            deviceName: ledgerAccount.deviceName,
          });
          break;
        }

        case AccountType.REMOTE_SIGNER: {
          const remoteSignerAccount = account as RemoteSignerAccountMetadata;
          // Metadata only for remote signer accounts - keys are on signer device
          backupAccounts.push({
            ...baseData,
            signerDeviceId: remoteSignerAccount.signerDeviceId,
            signerDeviceName: remoteSignerAccount.signerDeviceName,
            pairedAt: remoteSignerAccount.pairedAt,
            lastSigningActivity: remoteSignerAccount.lastSigningActivity,
            // Conservative default for legacy records with no persisted level.
            authLevel: withDefaultAuthLevel(remoteSignerAccount.authLevel),
          });
          break;
        }

        default: {
          // Unknown account type - include base data only with warning
          // This handles future account types that may be added
          const unknownAccount = account as { type: string };
          console.warn(
            `Unknown account type during backup: ${unknownAccount.type}`
          );
          backupAccounts.push(baseData);
        }
      }
    }

    return { accounts: backupAccounts, leftOut, total: wallet.accounts.length };
  } catch (error) {
    if (error instanceof BackupError) {
      throw error;
    }
    throw new BackupError(
      `Failed to collect accounts: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'COLLECTION_FAILED'
    );
  }
}

/**
 * Collect all settings for backup
 */
export async function collectSettings(): Promise<BackupSettings> {
  try {
    const theme = await collectThemeSettings();
    const security = await collectSecuritySettings();
    const network = await collectNetworkSetting();
    const assetFilters = await collectAssetFilterSettings();
    const remoteSigner = await collectRemoteSignerSettings();

    return {
      theme,
      security,
      network,
      assetFilters,
      remoteSigner,
    };
  } catch (error) {
    throw new BackupError(
      `Failed to collect settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'COLLECTION_FAILED'
    );
  }
}

/**
 * Collect theme settings
 */
async function collectThemeSettings(): Promise<BackupThemeSettings> {
  const [
    mode,
    nftThemeRaw,
    nftThemeEnabled,
    paletteIndex,
    backgroundEnabled,
    overlayIntensity,
  ] = await AsyncStorage.multiGet([
    STORAGE_KEYS.THEME_MODE,
    STORAGE_KEYS.NFT_THEME,
    STORAGE_KEYS.NFT_THEME_ENABLED,
    STORAGE_KEYS.NFT_THEME_PALETTE_INDEX,
    STORAGE_KEYS.NFT_THEME_BACKGROUND_ENABLED,
    STORAGE_KEYS.NFT_THEME_OVERLAY_INTENSITY,
  ]);

  let nftTheme: BackupNFTTheme | null = null;
  if (nftThemeRaw[1]) {
    try {
      nftTheme = JSON.parse(nftThemeRaw[1]) as BackupNFTTheme;
    } catch {
      // Invalid JSON, skip
    }
  }

  return {
    mode: (mode[1] as 'light' | 'dark' | 'system') || 'system',
    nftTheme,
    nftThemeEnabled: nftThemeEnabled[1] === 'true',
    selectedPaletteIndex: paletteIndex[1] ? parseInt(paletteIndex[1], 10) : 0,
    backgroundImageEnabled: backgroundEnabled[1] !== 'false', // Default true
    overlayIntensity: overlayIntensity[1]
      ? parseFloat(overlayIntensity[1])
      : 0.5,
  };
}

/**
 * Collect security settings (NOT including PIN hash)
 */
async function collectSecuritySettings(): Promise<BackupSecuritySettings> {
  const pinTimeout = await AccountSecureStorage.getPinTimeout();
  const biometricEnabled = await AccountSecureStorage.isBiometricEnabled();

  return {
    pinTimeout,
    biometricEnabled,
  };
}

/**
 * Collect network setting
 */
async function collectNetworkSetting(): Promise<NetworkId | null> {
  const network = await AsyncStorage.getItem(STORAGE_KEYS.NETWORK);
  return network as NetworkId | null;
}

/**
 * Collect asset filter settings
 */
async function collectAssetFilterSettings(): Promise<BackupAssetFilterSettings> {
  const [sortBy, sortOrder, balanceThreshold, valueThreshold, nativeFirst] =
    await AsyncStorage.multiGet([
      STORAGE_KEYS.ASSET_SORT_BY,
      STORAGE_KEYS.ASSET_SORT_ORDER,
      STORAGE_KEYS.ASSET_BALANCE_THRESHOLD,
      STORAGE_KEYS.ASSET_VALUE_THRESHOLD,
      STORAGE_KEYS.ASSET_NATIVE_FIRST,
    ]);

  return {
    sortBy: (sortBy[1] as 'name' | 'balance' | 'value') || 'value',
    sortOrder: (sortOrder[1] as 'asc' | 'desc') || 'desc',
    balanceThreshold: balanceThreshold[1] ? parseFloat(balanceThreshold[1]) : 0,
    valueThreshold: valueThreshold[1] ? parseFloat(valueThreshold[1]) : 0,
    nativeTokensFirst: nativeFirst[1] !== 'false', // Default true
  };
}

/**
 * Collect friends list
 */
export async function collectFriends(): Promise<Friend[]> {
  try {
    const friendsJson = await AsyncStorage.getItem(STORAGE_KEYS.FRIENDS_LIST);
    if (!friendsJson) {
      return [];
    }
    return JSON.parse(friendsJson) as Friend[];
  } catch (error) {
    console.warn('Failed to collect friends list:', error);
    return [];
  }
}

/**
 * Collect experimental feature flags
 */
export async function collectExperimental(): Promise<BackupExperimentalFlags> {
  try {
    const experimentalJson = await AsyncStorage.getItem(
      STORAGE_KEYS.EXPERIMENTAL
    );
    if (!experimentalJson) {
      return {
        swapEnabled: false,
        messagingEnabled: false,
      };
    }

    const experimental = JSON.parse(experimentalJson);
    // Zustand persist format has state nested
    const state = experimental.state || experimental;

    return {
      swapEnabled: state.swapEnabled || false,
      messagingEnabled: state.messagingEnabled || false,
    };
  } catch (error) {
    console.warn('Failed to collect experimental flags:', error);
    return {
      swapEnabled: false,
      messagingEnabled: false,
    };
  }
}

/**
 * Collect remote signer settings
 */
async function collectRemoteSignerSettings(): Promise<BackupRemoteSignerSettings> {
  try {
    // Get app mode
    const storedMode = await AsyncStorage.getItem(
      REMOTE_SIGNER_STORAGE_KEYS.APP_MODE
    );
    const appMode: 'wallet' | 'signer' =
      storedMode === 'signer' ? 'signer' : 'wallet';

    // Get signer config (when in signer mode)
    let signerConfig: BackupSignerConfig | null = null;
    const storedConfig = await AsyncStorage.getItem(
      REMOTE_SIGNER_STORAGE_KEYS.SIGNER_CONFIG
    );
    if (storedConfig) {
      try {
        signerConfig = JSON.parse(storedConfig) as BackupSignerConfig;
      } catch {
        console.warn('Failed to parse signer config');
      }
    }

    // Get paired signers (when in wallet mode)
    let pairedSigners: BackupPairedSigner[] = [];
    const storedSigners = await AsyncStorage.getItem(
      REMOTE_SIGNER_STORAGE_KEYS.PAIRED_SIGNERS
    );
    if (storedSigners) {
      try {
        // Stored as array of [deviceId, SignerDeviceInfo] tuples (Map serialization)
        const parsed = JSON.parse(storedSigners) as [
          string,
          {
            deviceId: string;
            deviceName?: string;
            pairedAt: number;
            addresses: string[];
            lastActivity?: number;
          },
        ][];
        pairedSigners = parsed.map(([, info]) => ({
          deviceId: info.deviceId,
          deviceName: info.deviceName,
          pairedAt: info.pairedAt,
          addresses: info.addresses || [],
          lastActivity: info.lastActivity,
        }));
      } catch {
        console.warn('Failed to parse paired signers');
      }
    }

    return {
      appMode,
      signerConfig,
      pairedSigners,
    };
  } catch (error) {
    console.warn('Failed to collect remote signer settings:', error);
    return {
      appMode: 'wallet',
      signerConfig: null,
      pairedSigners: [],
    };
  }
}
