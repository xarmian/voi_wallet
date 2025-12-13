/**
 * Backup Data Collectors
 *
 * Functions to collect all wallet data for backup.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { MultiAccountWalletService } from '@/services/wallet';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import {
  AccountType,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  RemoteSignerAccountMetadata,
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

/**
 * Collect all accounts with their data for backup
 * For standard accounts, retrieves the mnemonic (requires PIN/biometric auth)
 */
export async function collectAccounts(pin?: string): Promise<BackupAccountData[]> {
  try {
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    if (!wallet || wallet.accounts.length === 0) {
      return [];
    }

    const backupAccounts: BackupAccountData[] = [];

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
          try {
            // Get mnemonic - this may require PIN auth
            const mnemonic = await SecureKeyManager.getMnemonic(account.address);
            backupAccounts.push({
              ...baseData,
              mnemonic,
              derivationPath: standardAccount.derivationPath,
              hasBackup: standardAccount.hasBackup,
            });
          } catch (error) {
            throw new BackupError(
              `Failed to retrieve mnemonic for account ${account.label || account.address}: ${
                error instanceof Error ? error.message : 'Unknown error'
              }`,
              'AUTHENTICATION_REQUIRED'
            );
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
          backupAccounts.push({
            ...baseData,
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
          });
          break;
        }

        default: {
          // Unknown account type - include base data only with warning
          // This handles future account types that may be added
          const unknownAccount = account as { type: string };
          console.warn(`Unknown account type during backup: ${unknownAccount.type}`);
          backupAccounts.push(baseData);
        }
      }
    }

    return backupAccounts;
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
    overlayIntensity: overlayIntensity[1] ? parseFloat(overlayIntensity[1]) : 0.5,
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
    const experimentalJson = await AsyncStorage.getItem(STORAGE_KEYS.EXPERIMENTAL);
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
    const storedMode = await AsyncStorage.getItem(REMOTE_SIGNER_STORAGE_KEYS.APP_MODE);
    const appMode: 'wallet' | 'signer' = storedMode === 'signer' ? 'signer' : 'wallet';

    // Get signer config (when in signer mode)
    let signerConfig: BackupSignerConfig | null = null;
    const storedConfig = await AsyncStorage.getItem(REMOTE_SIGNER_STORAGE_KEYS.SIGNER_CONFIG);
    if (storedConfig) {
      try {
        signerConfig = JSON.parse(storedConfig) as BackupSignerConfig;
      } catch {
        console.warn('Failed to parse signer config');
      }
    }

    // Get paired signers (when in wallet mode)
    let pairedSigners: BackupPairedSigner[] = [];
    const storedSigners = await AsyncStorage.getItem(REMOTE_SIGNER_STORAGE_KEYS.PAIRED_SIGNERS);
    if (storedSigners) {
      try {
        // Stored as array of [deviceId, SignerDeviceInfo] tuples (Map serialization)
        const parsed = JSON.parse(storedSigners) as [string, {
          deviceId: string;
          deviceName?: string;
          pairedAt: number;
          addresses: string[];
          lastActivity?: number;
        }][];
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
