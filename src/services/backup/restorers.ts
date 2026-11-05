/**
 * Backup Data Restorers
 *
 * Functions to restore wallet data from backup.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SessionKeyVault } from '@/services/secure/SessionKeyVault';
import { markPinSetupPending } from '@/services/secure/pinSetupPending';
import {
  AccountType,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  RemoteSignerAccountMetadata,
  ResetRacedError,
  Wallet,
  withDefaultAuthLevel,
} from '@/types/wallet';
import { Friend } from '@/types/social';
import {
  BackupAccountData,
  BackupSettings,
  BackupExperimentalFlags,
  BackupRemoteSignerSettings,
  BackupError,
  RestoreResult,
  RestoreRecordOutcome,
  RestoreRecordResult,
} from './types';
import { redactAddress, redactError } from '@/utils/logRedaction';

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
};

// Remote signer storage keys
const REMOTE_SIGNER_STORAGE_KEYS = {
  APP_MODE: '@voi_remote_signer_mode',
  SIGNER_CONFIG: '@voi_signer_config',
  PAIRED_SIGNERS: '@voi_paired_signers',
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

/** Validate required standard phrases and retained keys before any write. */
export function validateRetainedKeys(accounts: BackupAccountData[]): void {
  // A later record reusing an id would overwrite (or, metadata-only, delete)
  // the key an earlier record stored, so ids must be unique.
  const ids = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) {
      throw new BackupError(
        'Backup contains duplicate account ids',
        'INVALID_FILE_FORMAT'
      );
    }
    ids.add(account.id);
  }
  for (const account of accounts) {
    const standard = account.type === AccountType.STANDARD;
    if (
      !standard &&
      (account.type !== AccountType.REKEYED || account.mnemonic === undefined)
    )
      continue;
    let derived: algosdk.Account;
    try {
      if (typeof account.mnemonic !== 'string') throw new Error('not a string');
      derived = algosdk.mnemonicToSecretKey(account.mnemonic);
    } catch {
      throw new BackupError(
        standard
          ? 'Standard account in the backup is missing a valid recovery phrase'
          : 'Retained key in the backup is not a valid recovery phrase',
        'INVALID_FILE_FORMAT'
      );
    }
    try {
      if (
        !standard &&
        (derived.addr.toString() !== account.address ||
          (account.publicKey &&
            Buffer.from(derived.sk.subarray(32)).toString('hex') !==
              account.publicKey))
      ) {
        throw new BackupError(
          'Retained key does not match the rekeyed account',
          'INVALID_FILE_FORMAT'
        );
      }
    } finally {
      derived.sk.fill(0);
    }
  }
}

/**
 * TASK-423: the address a record will be restored under. A STANDARD record is
 * restored under the address its mnemonic derives, not the payload's; null
 * for a record restore skips (no mnemonic) or that will fail on its own.
 */
function restoredAddress(account: BackupAccountData): string | null {
  if (account.type !== AccountType.STANDARD) return account.address;
  if (!account.mnemonic) return null;
  try {
    const derived = algosdk.mnemonicToSecretKey(account.mnemonic);
    derived.sk.fill(0);
    return derived.addr.toString();
  } catch {
    return null;
  }
}

/** TASK-423: lower wins when two records share an address. */
function dedupeRank(account: BackupAccountData): number {
  const keyBearing =
    (account.type === AccountType.STANDARD && !!account.mnemonic) ||
    (account.type === AccountType.REKEYED && account.mnemonic !== undefined);
  if (keyBearing) return 0;
  if (
    account.type === AccountType.LEDGER ||
    account.type === AccountType.REMOTE_SIGNER
  )
    return 1;
  return 2;
}

/**
 * TASK-423: keep one record per restored address, before anything is written.
 * Records sharing an address never carry different keys (a STANDARD address is
 * derived from its mnemonic; a retained REKEYED key is validated against its
 * address), so dropping duplicates loses only their labels. The kept record is
 * the key-bearing one, then Ledger/remote signer over watch, then backup order.
 */
export function dedupeAccountsByAddress(accounts: BackupAccountData[]): {
  accounts: BackupAccountData[];
  dropped: number;
} {
  const addresses = accounts.map(restoredAddress);
  const winners = new Map<string, BackupAccountData>();
  accounts.forEach((account, i) => {
    const address = addresses[i];
    if (address === null) return;
    const current = winners.get(address);
    if (!current || dedupeRank(account) < dedupeRank(current)) {
      winners.set(address, account);
    }
  });
  const kept = accounts.filter((account, i) => {
    const address = addresses[i];
    return address === null || winners.get(address) === account;
  });
  return { accounts: kept, dropped: accounts.length - kept.length };
}

/** Where each record of the file stands against the accounts already on the
 *  device, decided before anything is written for it (TASK-504). */
function conflictWithDevice(
  id: string,
  address: string,
  deviceAccounts: { id: string; address: string }[]
): RestoreRecordOutcome | null {
  const sameId = deviceAccounts.find((account) => account.id === id);
  if (sameId) {
    return sameId.address === address
      ? 'already-present'
      : 'rejected-id-conflict';
  }
  if (deviceAccounts.some((account) => account.address === address)) {
    return 'kept-device-record';
  }
  return null;
}

/**
 * Add-only restore of the file's accounts (TASK-504). Nothing already on the
 * device is deleted or overwritten. Each record is decided against the device
 * and gets exactly one result. Key slots are read and written inside one
 * key-mutation task, a record whose id names an occupied slot is stored under a
 * fresh id, and the wallet blob is merged once, at the end, into the latest
 * blob re-read inside the write queue. Rollback touches only what this attempt
 * wrote: journaled key slots, and metadata it added for key-less records.
 */
export async function restoreAccounts(
  backupAccounts: BackupAccountData[]
): Promise<{
  total: number;
  standard: number;
  watch: number;
  rekeyed: number;
  ledger: number;
  remoteSigner: number;
  duplicatesDropped: number;
  records: RestoreRecordResult[];
  /** The wallet blob re-read inside the commit task already held accounts. */
  deviceHadAccountsAtCommit: boolean;
}> {
  // Defensive: the full-restore entry points validate first, but a direct call
  // must not bypass the duplicate-id and key-identity checks.
  validateRetainedKeys(backupAccounts);
  const { accounts, dropped } = dedupeAccountsByAddress(backupAccounts);
  const counts = {
    duplicatesDropped: dropped,
    total: 0,
    standard: 0,
    watch: 0,
    rekeyed: 0,
    ledger: 0,
    remoteSigner: 0,
    records: [] as RestoreRecordResult[],
    deviceHadAccountsAtCommit: false,
  };

  if (accounts.length === 0) {
    return counts;
  }

  // TASK-220: capture the secure reset generation now so the whole restore, the
  // per-account secret writes and the final wallet-metadata commit, aborts
  // (ResetRacedError) if a full reset races it, and the secrets written so far
  // are rolled back (ownership-checked), so the racing reset wins (DR-2).
  const creationGen = AccountSecureStorage.getResetGeneration();
  // Slots this attempt wrote (journaled, with the ownership token).
  const pendingCreates: { id: string; token: string }[] = [];
  // Metadata this attempt added without writing a slot.
  const metadataOnly = new Set<string>();
  // Once the wallet blob MAY reference the restored accounts, their secrets
  // must never be rolled back: deleting them would leave persisted accounts
  // keyless. storeWallet writes the blob and THEN clears the wipe tombstone, so
  // a rejection from the persist call can arrive after the blob is written.
  let persistAttempted = false;

  try {
    // The device is read first and strictly: a failed read stops here with
    // nothing written, and is never taken as an empty device.
    const deviceWallet = await MultiAccountWalletService.readWalletStrict();
    const deviceAccounts = deviceWallet?.accounts ?? [];
    // A restored key must end up under the same protection as the device's
    // other keys, and a locked vault cannot give that: stop, device unchanged.
    if (
      deviceAccounts.length > 0 &&
      (await AccountSecureStorage.hasPinStrict()) &&
      !SessionKeyVault.isUnlocked()
    ) {
      throw new BackupError(
        'Unlock the wallet to restore accounts',
        'AUTHENTICATION_REQUIRED'
      );
    }

    const restoredAccounts: (
      | StandardAccountMetadata
      | WatchAccountMetadata
      | RekeyedAccountMetadata
      | LedgerAccountMetadata
      | RemoteSignerAccountMetadata
    )[] = [];
    const resultByStoredId = new Map<string, RestoreRecordResult>();
    const tokenByStoredId = new Map<string, string>();

    for (const backupAccount of accounts) {
      const address = restoredAddress(backupAccount) ?? backupAccount.address;
      const record: RestoreRecordResult = {
        id: backupAccount.id,
        address,
        label: backupAccount.label,
        outcome: 'added',
      };
      const conflict = conflictWithDevice(
        backupAccount.id,
        address,
        deviceAccounts
      );
      if (conflict) {
        record.outcome = conflict;
        counts.records.push(record);
        continue;
      }

      // Records the file cannot supply: reported, never silently dropped.
      if (
        backupAccount.type === AccountType.REMOTE_SIGNER &&
        (!backupAccount.signerDeviceId || !backupAccount.pairedAt)
      ) {
        console.warn(
          `Skipping remote signer account ${redactAddress(backupAccount.address)} - missing signer fields`
        );
        record.outcome = 'rejected-invalid';
        counts.records.push(record);
        continue;
      }

      let stored: { id: string; reassigned: boolean; inPlace?: boolean };
      let account:
        | StandardAccountMetadata
        | WatchAccountMetadata
        | RekeyedAccountMetadata
        | LedgerAccountMetadata
        | RemoteSignerAccountMetadata;

      switch (backupAccount.type) {
        case AccountType.STANDARD: {
          // Derive account from mnemonic
          const algoAccount = algosdk.mnemonicToSecretKey(
            backupAccount.mnemonic!
          );

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
            // TASK-111: Never persist the 25-word mnemonic to general storage.
            // The secret key is passed separately to the store below
            // (expo-secure-store); the secure key manager re-derives the phrase from the
            // sk on demand, so Show-Recovery-Phrase still works.
            mnemonic: '',
            derivationPath: backupAccount.derivationPath,
            // TASK-45: was `backupAccount.hasBackup || true`, which is
            // unconditionally truthy — every restored account was marked backed
            // up regardless of what the payload said. Honour the payload, and
            // fail closed when the field is absent (older payloads predate it).
            hasBackup: backupAccount.hasBackup ?? false,
            // TASK-45/DR-11: `backupVerified` is deliberately NOT part of the
            // backup format. Verification is a property of THIS device's user,
            // not of the encrypted payload, so a restore always starts at false
            // and the Home banner asks the user to confirm on this device.
            backupVerified: false,
          };

          try {
            const written = await AccountSecureStorage.storeAccountForRestore(
              standardAccount,
              algoAccount.sk,
              creationGen
            );
            if (written.kind === 'occupied-other') {
              // A different key is stored under this id: not ours to re-id,
              // reported, nothing written.
              record.outcome = 'rejected-slot-occupied';
              counts.records.push(record);
              continue;
            }
            stored = {
              id: written.id,
              reassigned: written.kind === 'written' && written.reassigned,
              inPlace: written.kind === 'in-place',
            };
            if (written.kind === 'written') {
              pendingCreates.push({ id: written.id, token: written.token });
              tokenByStoredId.set(written.id, written.token);
            } else {
              metadataOnly.add(written.id);
            }
          } finally {
            // Clear secret key from memory regardless of outcome.
            algoAccount.sk.fill(0);
          }
          account = standardAccount;
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

          stored = await AccountSecureStorage.storeKeylessAccountForRestore(
            watchAccount,
            creationGen
          );
          metadataOnly.add(stored.id);
          account = watchAccount;
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
            // A record claims a retained key only when the file holds the phrase
            // (TASK-425 U4).
            originalOwner: !!backupAccount.mnemonic,
            hasBackup: backupAccount.hasBackup ?? false,
            backupVerified: false,
            canSign: backupAccount.canSign || false,
            rekeyedFrom: backupAccount.rekeyedFrom,
          };

          if (backupAccount.mnemonic !== undefined) {
            validateRetainedKeys([backupAccount]);
            const derived = algosdk.mnemonicToSecretKey(backupAccount.mnemonic);
            try {
              const written = await AccountSecureStorage.storeAccountForRestore(
                rekeyedAccount,
                derived.sk,
                creationGen
              );
              if (written.kind === 'occupied-other') {
                record.outcome = 'rejected-slot-occupied';
                counts.records.push(record);
                continue;
              }
              stored = {
                id: written.id,
                reassigned: written.kind === 'written' && written.reassigned,
                inPlace: written.kind === 'in-place',
              };
              if (written.kind === 'written') {
                pendingCreates.push({ id: written.id, token: written.token });
                tokenByStoredId.set(written.id, written.token);
              } else {
                metadataOnly.add(written.id);
              }
            } finally {
              derived.sk.fill(0);
            }
          } else {
            stored = await AccountSecureStorage.storeKeylessAccountForRestore(
              rekeyedAccount,
              creationGen
            );
            metadataOnly.add(stored.id);
          }
          account = rekeyedAccount;
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
            derivationPath:
              backupAccount.ledgerDerivationPath || "44'/283'/0'/0/0",
            deviceName: backupAccount.deviceName,
          };

          stored = await AccountSecureStorage.storeKeylessAccountForRestore(
            ledgerAccount,
            creationGen
          );
          metadataOnly.add(stored.id);
          account = ledgerAccount;
          break;
        }

        case AccountType.REMOTE_SIGNER: {
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
            signerDeviceId: backupAccount.signerDeviceId!,
            signerDeviceName: backupAccount.signerDeviceName,
            pairedAt: backupAccount.pairedAt!,
            lastSigningActivity: backupAccount.lastSigningActivity,
            // Conservative default for backups written before this field existed.
            authLevel: withDefaultAuthLevel(backupAccount.authLevel),
          };

          stored = await AccountSecureStorage.storeKeylessAccountForRestore(
            remoteSignerAccount,
            creationGen
          );
          metadataOnly.add(stored.id);
          account = remoteSignerAccount;
          break;
        }

        default:
          console.warn(`Unknown account type: ${backupAccount.type}`);
          record.outcome = 'rejected-invalid';
          counts.records.push(record);
          continue;
      }

      account.id = stored.id;
      record.outcome = stored.reassigned
        ? 'added-new-id'
        : stored.inPlace
          ? 'added-in-place'
          : 'added';
      if (stored.id !== backupAccount.id) record.storedId = stored.id;
      resultByStoredId.set(stored.id, record);
      counts.records.push(record);
      restoredAccounts.push(account);
    }

    if (restoredAccounts.length > 0) {
      const shell: Omit<Wallet, 'accounts' | 'activeAccountId'> = {
        id: `wallet_${Date.now()}`,
        version: '2.0',
        createdAt: new Date().toISOString(),
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

      // Merge into the latest wallet blob inside the write queue (TASK-111:
      // sanitized like every other write; TASK-220: generation-guarded so a
      // reset racing the restore aborts this commit instead of resurrecting the
      // wallet).
      persistAttempted = true;
      const merged = await MultiAccountWalletService.mergeRestoredAccounts(
        restoredAccounts,
        creationGen,
        shell
      );
      counts.deviceHadAccountsAtCommit = merged.hadAccounts;

      // A record the blob took in the meantime (another writer added the same
      // id or address after the device read): it is not added, so what this
      // attempt wrote for it is undone, and the report says so.
      for (const skip of merged.skipped) {
        const record = resultByStoredId.get(skip.id);
        if (record) {
          record.outcome =
            skip.reason === 'id' ? 'already-present' : 'kept-device-record';
        }
        const token = tokenByStoredId.get(skip.id);
        try {
          if (token !== undefined) {
            await AccountSecureStorage.deleteAccountIfAttemptMatches(
              skip.id,
              token
            );
            tokenByStoredId.delete(skip.id);
          } else if (metadataOnly.has(skip.id)) {
            await AccountSecureStorage.removeAccountMetadataOnly(skip.id);
          }
        } catch (undoError) {
          console.warn('Restore undo failed:', redactError(undoError));
        }
        const index = pendingCreates.findIndex((p) => p.id === skip.id);
        if (index >= 0) pendingCreates.splice(index, 1);
      }
    }

    // TASK-220: metadata committed — finalize each secret this attempt wrote
    // (drop its pending-creation journal entry). The secure wipe tombstone stays
    // sticky. A metadata-only record never had a journal entry.
    for (const p of pendingCreates) {
      await AccountSecureStorage.commitPendingCreate(p.id, p.token);
    }

    const typeOfRecord = new Map(accounts.map((a) => [a.id, a.type] as const));
    for (const record of counts.records) {
      if (
        record.outcome !== 'added' &&
        record.outcome !== 'added-new-id' &&
        record.outcome !== 'added-in-place'
      ) {
        continue;
      }
      counts.total++;
      switch (typeOfRecord.get(record.id)) {
        case AccountType.STANDARD:
          counts.standard++;
          break;
        case AccountType.WATCH:
          counts.watch++;
          break;
        case AccountType.REKEYED:
          counts.rekeyed++;
          break;
        case AccountType.LEDGER:
          counts.ledger++;
          break;
        case AccountType.REMOTE_SIGNER:
          counts.remoteSigner++;
          break;
      }
    }
    return counts;
  } catch (error) {
    // Roll back this attempt's own writes only when no blob can have been
    // written: before the persist call, or a reset race, which storeWallet
    // throws before its write (TASK-220 DR-2). Any other persist-time or later
    // failure keeps them; an orphan journaled secret is reconciled at boot,
    // a keyless persisted account is not (TASK-421 U3).
    const rollback = !persistAttempted || error instanceof ResetRacedError;
    for (const p of rollback ? pendingCreates : []) {
      try {
        await AccountSecureStorage.deleteAccountIfAttemptMatches(p.id, p.token);
      } catch (rollbackError) {
        // TASK-415: retry this indexed, journaled id during reconciliation.
        console.warn('Restore rollback failed:', redactError(rollbackError));
      }
    }
    // Metadata added without a slot is undone by id; the slot is never touched.
    for (const id of rollback ? metadataOnly : []) {
      try {
        await AccountSecureStorage.removeAccountMetadataOnly(id);
      } catch (rollbackError) {
        console.warn('Restore rollback failed:', redactError(rollbackError));
      }
    }
    if (error instanceof ResetRacedError || error instanceof BackupError)
      throw error;
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

    // Security settings are never taken from a file: neither the PIN timeout
    // nor the biometric switch (TASK-504). A file does not get to loosen how
    // this device locks.

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

    await AsyncStorage.setItem(
      STORAGE_KEYS.FRIENDS_LIST,
      JSON.stringify(friends)
    );
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

    // Paired signers are NOT restored (TASK-504): a pairing is trust, and a
    // file does not get to grant it. The user pairs again on this device.

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
 * Full restore operation (TASK-504): add-only. It never clears anything. The
 * file's accounts are added to what the device already holds; on a device that
 * is still fresh (no PIN and no accounts) the file's display settings, friends
 * and experimental flags are taken as well, and on any other device they are
 * not touched.
 */
export async function performFullRestore(
  accounts: BackupAccountData[],
  settings: BackupSettings,
  friends: Friend[],
  experimental: BackupExperimentalFlags
): Promise<RestoreResult> {
  // Stage a private copy so callers cannot change validated phrases while
  // the storage operations below are awaiting completion.
  const stagedAccounts = accounts.map((account) => ({ ...account }));
  validateRetainedKeys(stagedAccounts);

  // Decide "fresh" BEFORE any account is added, from strict reads: a read
  // error stops the restore here, with nothing written. The decision runs
  // inside a wallet-queue task on the re-read blob (no PIN, no accounts, empty
  // account list, journal and quarantine set, no breadcrumb; DOC-507 section 1
  // rule 2). It is checked again at the commit below.
  let hasPin: boolean;
  let fresh: boolean;
  try {
    hasPin = await AccountSecureStorage.hasPinStrict();
    fresh = await MultiAccountWalletService.isDeviceFreshStrict();
  } catch (error) {
    throw new BackupError(
      `Failed to restore accounts: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'RESTORE_FAILED'
    );
  }

  // TASK-213 (restore-before-PIN false-lockout fix): with no PIN, set the
  // durable plaintext breadcrumb BEFORE any key-bearing (STANDARD) account is
  // persisted below. Restore writes key material with NO PIN yet (the user sets
  // it afterward on SecuritySetup). A cold-kill in that window would otherwise
  // boot into the fail-closed recovery screen (whose Reset WIPES this
  // just-restored wallet); the breadcrumb lets checkInitialAuthState route to
  // SecuritySetup (resume PIN setup) instead. setupPin clears it on success.
  if (!hasPin) {
    await markPinSetupPending();
  }

  const accountCounts = await restoreAccounts(stagedAccounts);

  // The device was fresh when this restore began; if another writer put an
  // account on the wallet before our commit, it is not fresh now, and the file
  // changes accounts only. A stale "fresh" can only affect display settings: a
  // fresh restore never sets a PIN or protection state from the file.
  fresh = fresh && !accountCounts.deviceHadAccountsAtCommit;

  let remoteSignerSettingsRestored = false;
  let friendsCount = 0;
  if (fresh) {
    await restoreSettings(settings);
    remoteSignerSettingsRestored = await restoreRemoteSignerSettings(
      settings.remoteSigner
    );
    friendsCount = await restoreFriends(friends);
    await restoreExperimental(experimental);
  }

  return {
    records: accountCounts.records,
    accountCount: accountCounts.total,
    ledgerAccountCount: accountCounts.ledger,
    standardAccountCount: accountCounts.standard,
    watchAccountCount: accountCounts.watch,
    rekeyedAccountCount: accountCounts.rekeyed,
    remoteSignerAccountCount: accountCounts.remoteSigner,
    duplicateAccountsDropped: accountCounts.duplicatesDropped,
    settingsRestored: fresh,
    friendsCount,
    remoteSignerSettingsRestored,
    // Pairings are never taken from a file (a pairing is trust). The count lets
    // a FRESH restore's report say so when the file held any. On a restore that
    // is not fresh nothing of the file's signer settings is taken or claimed, so
    // the count is 0 and the line would be false.
    pairedSignersNotRestored: fresh
      ? (settings.remoteSigner?.pairedSigners?.length ?? 0)
      : 0,
  };
}
