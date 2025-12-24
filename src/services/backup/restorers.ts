/**
 * Backup Data Restorers
 *
 * Functions to restore wallet data from backup.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';
import { storage } from '@/platform';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import {
  AccountType,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  RemoteSignerAccountMetadata,
  Wallet,
} from '@/types/wallet';
import { Friend } from '@/types/social';
import {
  BackupAccountData,
  BackupSettings,
  BackupExperimentalFlags,
  BackupRemoteSignerSettings,
  BackupError,
  RestoreResult,
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
  // Security
  PIN_TIMEOUT: 'voi_pin_timeout_minutes',
  // Asset filters
  ASSET_SORT_BY: '@wallet-asset-sort-by',
  ASSET_SORT_ORDER: '@wallet-asset-sort-order',
  ASSET_BALANCE_THRESHOLD: '@wallet-asset-filter-balance-threshold',
  ASSET_VALUE_THRESHOLD: '@wallet-asset-filter-value-threshold',
  ASSET_NATIVE_FIRST: '@wallet-asset-native-tokens-first',
  // Friends
  FRIENDS_LIST: '@friends/list',
  // Experimental
  EXPERIMENTAL: 'experimental-features',
  // Wallet
  WALLET_KEY: 'voi_wallet_metadata',
  ACCOUNT_LIST: 'voi_account_list',
};

// Remote signer storage keys
const REMOTE_SIGNER_STORAGE_KEYS = {
  APP_MODE: '@voi_remote_signer_mode',
  SIGNER_CONFIG: '@voi_signer_config',
  PAIRED_SIGNERS: '@voi_paired_signers',
  PROCESSED_REQUESTS: '@voi_processed_requests',
};

/**
 * Generate a unique device ID for signer devices
 * Uses cryptographically secure random bytes for security
 * Used when restoring to ensure each physical device has a unique ID
 */
function generateDeviceId(): string {
  const timestamp = Date.now().toString(36);
  // Use cryptographically secure random bytes instead of Math.random()
  const randomBytes = Crypto.getRandomBytes(8);
  const randomPart = Buffer.from(randomBytes).toString('hex').substring(0, 10);
  return `voi-signer-${timestamp}-${randomPart}`;
}

/**
 * Clear all existing wallet data before restore
 * This ensures a clean slate for the restore operation
 */
export async function clearAllData(): Promise<void> {
  try {
    // Clear all accounts via AccountSecureStorage
    await AccountSecureStorage.clearAll();

    // Clear wallet metadata
    await storage.removeItem(STORAGE_KEYS.WALLET_KEY);
    await storage.removeItem(STORAGE_KEYS.ACCOUNT_LIST);

    // Clear settings
    await AsyncStorage.multiRemove([
      STORAGE_KEYS.THEME_MODE,
      STORAGE_KEYS.NFT_THEME,
      STORAGE_KEYS.NFT_THEME_ENABLED,
      STORAGE_KEYS.NFT_THEME_PALETTE_INDEX,
      STORAGE_KEYS.NFT_THEME_BACKGROUND_ENABLED,
      STORAGE_KEYS.NFT_THEME_OVERLAY_INTENSITY,
      STORAGE_KEYS.NETWORK,
      STORAGE_KEYS.PIN_TIMEOUT,
      STORAGE_KEYS.ASSET_SORT_BY,
      STORAGE_KEYS.ASSET_SORT_ORDER,
      STORAGE_KEYS.ASSET_BALANCE_THRESHOLD,
      STORAGE_KEYS.ASSET_VALUE_THRESHOLD,
      STORAGE_KEYS.ASSET_NATIVE_FIRST,
      STORAGE_KEYS.FRIENDS_LIST,
      STORAGE_KEYS.EXPERIMENTAL,
      // Remote signer storage keys
      // NOTE: PROCESSED_REQUESTS is intentionally cleared and NOT restored from backup
      // to prevent replay attacks. The request timestamp validation in the remote signer
      // protocol provides protection against old requests being re-processed after restore.
      REMOTE_SIGNER_STORAGE_KEYS.APP_MODE,
      REMOTE_SIGNER_STORAGE_KEYS.SIGNER_CONFIG,
      REMOTE_SIGNER_STORAGE_KEYS.PAIRED_SIGNERS,
      REMOTE_SIGNER_STORAGE_KEYS.PROCESSED_REQUESTS,
    ]);

    // Clear balance caches
    const allKeys = await AsyncStorage.getAllKeys();
    const cacheKeys = allKeys.filter(
      (key) =>
        key.includes('balance_cache') ||
        key.includes('claimable') ||
        key.includes('messages')
    );
    if (cacheKeys.length > 0) {
      await AsyncStorage.multiRemove(cacheKeys);
    }
  } catch (error) {
    throw new BackupError(
      `Failed to clear existing data: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'RESTORE_FAILED'
    );
  }
}

/**
 * Restore accounts from backup data
 * Creates new wallet structure and stores all accounts
 */
export async function restoreAccounts(
  accounts: BackupAccountData[]
): Promise<{
  total: number;
  standard: number;
  watch: number;
  rekeyed: number;
  ledger: number;
  remoteSigner: number;
}> {
  const counts = {
    total: 0,
    standard: 0,
    watch: 0,
    rekeyed: 0,
    ledger: 0,
    remoteSigner: 0,
  };

  if (accounts.length === 0) {
    return counts;
  }

  try {
    const restoredAccounts: (
      | StandardAccountMetadata
      | WatchAccountMetadata
      | RekeyedAccountMetadata
      | LedgerAccountMetadata
      | RemoteSignerAccountMetadata
    )[] = [];

    for (const backupAccount of accounts) {
      switch (backupAccount.type) {
        case AccountType.STANDARD: {
          if (!backupAccount.mnemonic) {
            console.warn(
              `Skipping standard account ${backupAccount.address} - no mnemonic`
            );
            continue;
          }

          // Derive account from mnemonic
          const algoAccount = algosdk.mnemonicToSecretKey(backupAccount.mnemonic);

          const standardAccount: StandardAccountMetadata = {
            id: backupAccount.id,
            address: algoAccount.addr.toString(),
            publicKey:
              backupAccount.publicKey ||
              Buffer.from(algoAccount.sk.slice(32)).toString('hex'),
            type: AccountType.STANDARD,
            label: backupAccount.label,
            color: backupAccount.color,
            isHidden: backupAccount.isHidden,
            createdAt: backupAccount.createdAt,
            importedAt: backupAccount.importedAt,
            lastUsed: new Date().toISOString(),
            avatarUrl: backupAccount.avatarUrl,
            mnemonic: backupAccount.mnemonic,
            derivationPath: backupAccount.derivationPath,
            hasBackup: backupAccount.hasBackup || true, // Restored = backed up
          };

          // Store account securely (this encrypts the private key)
          await AccountSecureStorage.storeAccount(standardAccount, algoAccount.sk);

          // Clear secret key from memory
          algoAccount.sk.fill(0);

          restoredAccounts.push(standardAccount);
          counts.standard++;
          counts.total++;
          break;
        }

        case AccountType.WATCH: {
          const watchAccount: WatchAccountMetadata = {
            id: backupAccount.id,
            address: backupAccount.address,
            publicKey: backupAccount.publicKey,
            type: AccountType.WATCH,
            label: backupAccount.label,
            color: backupAccount.color,
            isHidden: backupAccount.isHidden,
            createdAt: backupAccount.createdAt,
            lastUsed: new Date().toISOString(),
            avatarUrl: backupAccount.avatarUrl,
            source: backupAccount.source,
            notes: backupAccount.notes,
          };

          await AccountSecureStorage.storeAccount(watchAccount);
          restoredAccounts.push(watchAccount);
          counts.watch++;
          counts.total++;
          break;
        }

        case AccountType.REKEYED: {
          const rekeyedAccount: RekeyedAccountMetadata = {
            id: backupAccount.id,
            address: backupAccount.address,
            publicKey: backupAccount.publicKey,
            type: AccountType.REKEYED,
            label: backupAccount.label,
            color: backupAccount.color,
            isHidden: backupAccount.isHidden,
            createdAt: backupAccount.createdAt,
            lastUsed: new Date().toISOString(),
            avatarUrl: backupAccount.avatarUrl,
            authAddress: backupAccount.authAddress || '',
            rekeyedAt: backupAccount.rekeyedAt,
            originalOwner: backupAccount.originalOwner,
            canSign: backupAccount.canSign || false,
            rekeyedFrom: backupAccount.rekeyedFrom,
          };

          await AccountSecureStorage.storeAccount(rekeyedAccount);
          restoredAccounts.push(rekeyedAccount);
          counts.rekeyed++;
          counts.total++;
          break;
        }

        case AccountType.LEDGER: {
          // Ledger accounts only have metadata - no secrets
          const ledgerAccount: LedgerAccountMetadata = {
            id: backupAccount.id,
            address: backupAccount.address,
            publicKey: backupAccount.publicKey,
            type: AccountType.LEDGER,
            label: backupAccount.label,
            color: backupAccount.color,
            isHidden: backupAccount.isHidden,
            createdAt: backupAccount.createdAt,
            lastUsed: new Date().toISOString(),
            avatarUrl: backupAccount.avatarUrl,
            deviceId: backupAccount.deviceId || '',
            derivationIndex: backupAccount.derivationIndex || 0,
            derivationPath: backupAccount.ledgerDerivationPath || "44'/283'/0'/0/0",
            deviceName: backupAccount.deviceName,
          };

          await AccountSecureStorage.storeAccount(ledgerAccount);
          restoredAccounts.push(ledgerAccount);
          counts.ledger++;
          counts.total++;
          break;
        }

        case AccountType.REMOTE_SIGNER: {
          // Validate required fields for remote signer accounts
          if (!backupAccount.signerDeviceId) {
            console.warn(
              `Skipping remote signer account ${backupAccount.address} - missing signerDeviceId`
            );
            continue;
          }

          if (!backupAccount.pairedAt) {
            console.warn(
              `Skipping remote signer account ${backupAccount.address} - missing pairedAt`
            );
            continue;
          }

          // Remote signer accounts only have metadata - keys are on signer device
          const remoteSignerAccount: RemoteSignerAccountMetadata = {
            id: backupAccount.id,
            address: backupAccount.address,
            publicKey: backupAccount.publicKey,
            type: AccountType.REMOTE_SIGNER,
            label: backupAccount.label,
            color: backupAccount.color,
            isHidden: backupAccount.isHidden,
            createdAt: backupAccount.createdAt,
            importedAt: backupAccount.importedAt,
            lastUsed: new Date().toISOString(),
            avatarUrl: backupAccount.avatarUrl,
            signerDeviceId: backupAccount.signerDeviceId,
            signerDeviceName: backupAccount.signerDeviceName,
            pairedAt: backupAccount.pairedAt,
            lastSigningActivity: backupAccount.lastSigningActivity,
          };

          await AccountSecureStorage.storeAccount(remoteSignerAccount);
          restoredAccounts.push(remoteSignerAccount);
          counts.remoteSigner++;
          counts.total++;
          break;
        }

        default:
          console.warn(`Unknown account type: ${backupAccount.type}`);
      }
    }

    // Create wallet structure
    if (restoredAccounts.length > 0) {
      const wallet: Wallet = {
        id: `wallet_${Date.now()}`,
        version: '2.0',
        createdAt: new Date().toISOString(),
        accounts: restoredAccounts,
        activeAccountId: restoredAccounts[0].id,
        settings: {
          theme: 'system',
          currency: 'USD',
          hideSmallBalances: false,
          requireBiometric: false,
          autoLock: 5,
          notifications: {
            transactionAlerts: true,
            priceAlerts: false,
            securityAlerts: true,
            pushNotifications: true,
          },
        },
      };

      // Store wallet metadata
      await storage.setItem(STORAGE_KEYS.WALLET_KEY, JSON.stringify(wallet));
    }

    return counts;
  } catch (error) {
    throw new BackupError(
      `Failed to restore accounts: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'RESTORE_FAILED'
    );
  }
}

/**
 * Restore settings from backup
 */
export async function restoreSettings(settings: BackupSettings): Promise<void> {
  try {
    const keyValuePairs: [string, string][] = [];

    // Theme settings
    if (settings.theme) {
      keyValuePairs.push([STORAGE_KEYS.THEME_MODE, settings.theme.mode]);

      if (settings.theme.nftTheme) {
        keyValuePairs.push([
          STORAGE_KEYS.NFT_THEME,
          JSON.stringify(settings.theme.nftTheme),
        ]);
      }

      keyValuePairs.push([
        STORAGE_KEYS.NFT_THEME_ENABLED,
        String(settings.theme.nftThemeEnabled),
      ]);

      keyValuePairs.push([
        STORAGE_KEYS.NFT_THEME_PALETTE_INDEX,
        String(settings.theme.selectedPaletteIndex),
      ]);

      keyValuePairs.push([
        STORAGE_KEYS.NFT_THEME_BACKGROUND_ENABLED,
        String(settings.theme.backgroundImageEnabled),
      ]);

      keyValuePairs.push([
        STORAGE_KEYS.NFT_THEME_OVERLAY_INTENSITY,
        String(settings.theme.overlayIntensity),
      ]);
    }

    // Network setting
    if (settings.network) {
      keyValuePairs.push([STORAGE_KEYS.NETWORK, settings.network]);
    }

    // Security settings (PIN timeout - NOT PIN hash)
    if (settings.security) {
      keyValuePairs.push([
        STORAGE_KEYS.PIN_TIMEOUT,
        String(settings.security.pinTimeout),
      ]);

      // Biometric enabled is stored via AccountSecureStorage
      await AccountSecureStorage.setBiometricEnabled(
        settings.security.biometricEnabled
      );
    }

    // Asset filter settings
    if (settings.assetFilters) {
      keyValuePairs.push([
        STORAGE_KEYS.ASSET_SORT_BY,
        settings.assetFilters.sortBy,
      ]);
      keyValuePairs.push([
        STORAGE_KEYS.ASSET_SORT_ORDER,
        settings.assetFilters.sortOrder,
      ]);
      keyValuePairs.push([
        STORAGE_KEYS.ASSET_BALANCE_THRESHOLD,
        String(settings.assetFilters.balanceThreshold),
      ]);
      keyValuePairs.push([
        STORAGE_KEYS.ASSET_VALUE_THRESHOLD,
        String(settings.assetFilters.valueThreshold),
      ]);
      keyValuePairs.push([
        STORAGE_KEYS.ASSET_NATIVE_FIRST,
        String(settings.assetFilters.nativeTokensFirst),
      ]);
    }

    // Write all settings at once
    if (keyValuePairs.length > 0) {
      await AsyncStorage.multiSet(keyValuePairs);
    }
  } catch (error) {
    throw new BackupError(
      `Failed to restore settings: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'RESTORE_FAILED'
    );
  }
}

/**
 * Restore friends list from backup
 */
export async function restoreFriends(friends: Friend[]): Promise<number> {
  try {
    if (!friends || friends.length === 0) {
      return 0;
    }

    await AsyncStorage.setItem(STORAGE_KEYS.FRIENDS_LIST, JSON.stringify(friends));
    return friends.length;
  } catch (error) {
    console.warn('Failed to restore friends list:', error);
    return 0;
  }
}

/**
 * Restore experimental feature flags from backup
 */
export async function restoreExperimental(
  flags: BackupExperimentalFlags
): Promise<void> {
  try {
    // Zustand persist format
    const experimentalState = {
      state: {
        swapEnabled: flags.swapEnabled || false,
        messagingEnabled: flags.messagingEnabled || false,
      },
      version: 0,
    };

    await AsyncStorage.setItem(
      STORAGE_KEYS.EXPERIMENTAL,
      JSON.stringify(experimentalState)
    );
  } catch (error) {
    console.warn('Failed to restore experimental flags:', error);
  }
}

/**
 * Restore remote signer settings from backup
 *
 * SECURITY NOTE: When restoring in signer mode, a new deviceId is generated
 * to ensure each physical device has a unique identity. This prevents issues
 * where multiple devices might share the same deviceId after a backup is
 * restored to a different device.
 */
export async function restoreRemoteSignerSettings(
  settings: BackupRemoteSignerSettings | undefined
): Promise<boolean> {
  // If no settings in backup, skip (backward compatibility)
  if (!settings) {
    return false;
  }

  try {
    const keyValuePairs: [string, string][] = [];

    // Restore app mode
    keyValuePairs.push([REMOTE_SIGNER_STORAGE_KEYS.APP_MODE, settings.appMode]);

    // Restore signer config (if present)
    if (settings.signerConfig) {
      // SECURITY: Always generate a new deviceId when restoring signer config
      // This ensures each physical device has a unique identity, even if:
      // - The same backup is restored to multiple devices
      // - The user switches from wallet mode to signer mode after restore
      const newDeviceId = generateDeviceId();
      const restoredConfig = {
        ...settings.signerConfig,
        deviceId: newDeviceId,
      };
      keyValuePairs.push([
        REMOTE_SIGNER_STORAGE_KEYS.SIGNER_CONFIG,
        JSON.stringify(restoredConfig),
      ]);
      console.log(
        `[Restore] Generated new device ID for restored signer config: ${newDeviceId}`
      );
    }

    // Restore paired signers (if present)
    if (settings.pairedSigners && settings.pairedSigners.length > 0) {
      // Validate and filter paired signers before restoring
      const validSigners = settings.pairedSigners.filter((signer) => {
        // Validate required fields
        if (!signer.deviceId) {
          console.warn('Skipping paired signer - missing deviceId');
          return false;
        }
        if (typeof signer.pairedAt !== 'number') {
          console.warn(`Skipping paired signer ${signer.deviceId} - invalid pairedAt`);
          return false;
        }
        // Validate addresses array
        if (!Array.isArray(signer.addresses) || signer.addresses.length === 0) {
          console.warn(`Skipping paired signer ${signer.deviceId} - invalid or empty addresses`);
          return false;
        }
        return true;
      });

      if (validSigners.length > 0) {
        // Convert back to Map serialization format [deviceId, info][]
        const mapEntries = validSigners.map((signer) => [
          signer.deviceId,
          {
            deviceId: signer.deviceId,
            deviceName: signer.deviceName,
            pairedAt: signer.pairedAt,
            addresses: signer.addresses,
            lastActivity: signer.lastActivity,
          },
        ]);
        keyValuePairs.push([
          REMOTE_SIGNER_STORAGE_KEYS.PAIRED_SIGNERS,
          JSON.stringify(mapEntries),
        ]);

        if (validSigners.length < settings.pairedSigners.length) {
          console.warn(
            `Restored ${validSigners.length} of ${settings.pairedSigners.length} paired signers (some were invalid)`
          );
        }
      }
    }

    // Write all settings at once
    if (keyValuePairs.length > 0) {
      await AsyncStorage.multiSet(keyValuePairs);
    }

    return true;
  } catch (error) {
    console.warn('Failed to restore remote signer settings:', error);
    return false;
  }
}

/**
 * Full restore operation
 * Clears existing data and restores from backup
 */
export async function performFullRestore(
  accounts: BackupAccountData[],
  settings: BackupSettings,
  friends: Friend[],
  experimental: BackupExperimentalFlags
): Promise<RestoreResult> {
  // Clear all existing data first
  await clearAllData();

  // Restore accounts
  const accountCounts = await restoreAccounts(accounts);

  // Restore settings
  await restoreSettings(settings);

  // Restore remote signer settings (check if present for backward compatibility)
  const remoteSignerSettingsRestored = await restoreRemoteSignerSettings(
    settings.remoteSigner
  );

  // Restore friends
  const friendsCount = await restoreFriends(friends);

  // Restore experimental flags
  await restoreExperimental(experimental);

  return {
    accountCount: accountCounts.total,
    ledgerAccountCount: accountCounts.ledger,
    standardAccountCount: accountCounts.standard,
    watchAccountCount: accountCounts.watch,
    rekeyedAccountCount: accountCounts.rekeyed,
    remoteSignerAccountCount: accountCounts.remoteSigner,
    settingsRestored: true,
    friendsCount,
    remoteSignerSettingsRestored,
  };
}
