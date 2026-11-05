/**
 * Backup Service
 *
 * Main service for creating and restoring encrypted wallet backups.
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Constants from 'expo-constants';
import {
  VoiBackupFile,
  EncryptedBackupFile,
  BackupResult,
  RestoreResult,
  BackupInfo,
  BackupProgress,
  RestoreProgress,
  BackupIncomplete,
  RestoreOptions,
  BackupError,
  BACKUP_LEFT_OUT_REASONS,
} from './types';
import {
  encryptBackup,
  decryptBackup,
  validateEncryptedBackupFile,
  validatePasswordStrength,
} from './encryption';
import {
  collectAccounts,
  collectSettings,
  collectFriends,
  collectExperimental,
} from './collectors';
import type { FreshAuthCapability } from '@/services/secure/freshAuth';
import { AccountType } from '@/types/wallet';
import {
  performFullRestore,
  planRestore,
  removeOldPinForRestore,
  validateRetainedKeys,
} from './restorers';

/**
 * Format date for filename
 */
function formatDateForFilename(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Generate backup filename. The name is the same for a complete and an
 * incomplete backup: whether the file lacks keys is read from inside it, never
 * from its name (product e7912207). No address or label goes in the name.
 */
function generateBackupFilename(): string {
  const dateStr = formatDateForFilename(new Date());
  return `voi-wallet-${dateStr}.voibackup`;
}

const INVALID_FILE =
  'This backup file is damaged or was altered, so it was not used.';

/**
 * TASK-504: the without-key flag and the incomplete list must agree, both ways.
 * Both sit inside the encrypted payload, so a mismatch means the file was built
 * by hand or altered. Checked on export as well, so this app can never write a
 * file its own import refuses.
 *
 *  - `withoutKey` is only ever `true`, only on a standard or rekeyed record, and
 *    a flagged record carries no phrase;
 *  - every flagged record has exactly one list entry at its address, and every
 *    entry has one flagged record, except `other-key-on-device`, whose account's
 *    own key IS in the file: that entry needs a keyed (unflagged, phrase-
 *    carrying) record at its address and no flagged record;
 *  - every reason is one of the known ones.
 */
export function assertFlagsMatchList(backup: VoiBackupFile): void {
  const refuse = (): never => {
    throw new BackupError(INVALID_FILE, 'INVALID_FILE_FORMAT');
  };
  const flaggedByAddress = new Map<string, number>();
  const keyedAddresses = new Set<string>();
  for (const account of backup.accounts) {
    const flag = (account as { withoutKey?: unknown }).withoutKey;
    if (flag === undefined) {
      if (typeof account.mnemonic === 'string' && account.mnemonic.length > 0) {
        keyedAddresses.add(account.address);
      }
      continue;
    }
    if (
      flag !== true ||
      (account.type !== AccountType.STANDARD &&
        account.type !== AccountType.REKEYED) ||
      account.mnemonic !== undefined
    ) {
      refuse();
    }
    flaggedByAddress.set(
      account.address,
      (flaggedByAddress.get(account.address) ?? 0) + 1
    );
  }
  const entriesByAddress = new Map<string, number>();
  for (const entry of backup.incomplete?.leftOut ?? []) {
    if (!BACKUP_LEFT_OUT_REASONS.includes(entry.reason)) refuse();
    if (entry.reason === 'other-key-on-device') {
      if (!keyedAddresses.has(entry.address)) refuse();
      continue;
    }
    entriesByAddress.set(
      entry.address,
      (entriesByAddress.get(entry.address) ?? 0) + 1
    );
  }
  if (flaggedByAddress.size !== entriesByAddress.size) refuse();
  for (const [address, count] of flaggedByAddress) {
    if (entriesByAddress.get(address) !== count) refuse();
  }
}

/**
 * The envelope and the encrypted payload must agree on whether the file is
 * incomplete (TASK-504). The envelope version is authenticated and the list sits
 * inside the encryption; a file where they differ was altered or built by hand,
 * and is refused before anything is read from it.
 */
export function assertEnvelopeMatchesPayload(
  encrypted: EncryptedBackupFile,
  backup: VoiBackupFile
): void {
  const envelopeIncomplete = encrypted.version === 3;
  const payload = backup.incomplete;
  const payloadIncomplete =
    payload !== undefined &&
    Array.isArray(payload.leftOut) &&
    payload.leftOut.length > 0;
  if (payload !== undefined && !payloadIncomplete) {
    throw new BackupError('Invalid backup structure', 'INVALID_FILE_FORMAT');
  }
  if (envelopeIncomplete !== payloadIncomplete) {
    throw new BackupError(INVALID_FILE, 'INVALID_FILE_FORMAT');
  }
  assertFlagsMatchList(backup);
}

/**
 * Get the backup cache directory
 */
async function getBackupDirectory(): Promise<Directory> {
  const backupDir = new Directory(Paths.cache, 'backups');
  if (!backupDir.exists) {
    await backupDir.create();
  }
  return backupDir;
}

/**
 * Backup Service class
 */
export class BackupService {
  private static progressCallback?: (
    progress: BackupProgress | RestoreProgress
  ) => void;

  /**
   * Set progress callback for UI updates
   */
  static setProgressCallback(
    callback: (progress: BackupProgress | RestoreProgress) => void
  ): void {
    this.progressCallback = callback;
  }

  /**
   * Clear progress callback
   */
  static clearProgressCallback(): void {
    this.progressCallback = undefined;
  }

  /**
   * Report progress to UI
   */
  private static reportProgress(
    progress: BackupProgress | RestoreProgress
  ): void {
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  /**
   * Create an encrypted backup of the wallet
   *
   * @param password - User's chosen backup password
   * @param pin - Optional PIN for authentication (required to access mnemonics)
   * @returns Backup result with file info
   */
  static async createBackup(
    password: string,
    cap: FreshAuthCapability
  ): Promise<BackupResult> {
    try {
      // Step 0: Enforce the passphrase policy at the service boundary. The UI
      // modal already gates on this, but a direct caller must not be able to
      // create a backup protecting mnemonics under a weak password.
      // NOTE: this gate applies to CREATION only — restore/import intentionally
      // never validates against this policy, so any older/any backup still
      // imports.
      const strength = validatePasswordStrength(password);
      if (!strength.isValid) {
        throw new BackupError(
          strength.feedback[0] ||
            'Password does not meet the minimum strength requirements',
          'WEAK_PASSWORD'
        );
      }

      // Step 1: Collect accounts
      this.reportProgress({
        step: 'collecting',
        progress: 10,
        message: 'Collecting account data...',
      });

      const collected = await collectAccounts(cap);
      const accounts = collected.accounts;
      const incomplete: BackupIncomplete | undefined =
        collected.leftOut.length > 0
          ? { leftOut: collected.leftOut }
          : undefined;

      this.reportProgress({
        step: 'collecting',
        progress: 30,
        message: 'Collecting settings...',
      });

      // Step 2: Collect settings
      const settings = await collectSettings();

      this.reportProgress({
        step: 'collecting',
        progress: 40,
        message: 'Collecting friends...',
      });

      // Step 3: Collect friends
      const friends = await collectFriends();

      this.reportProgress({
        step: 'collecting',
        progress: 50,
        message: 'Collecting preferences...',
      });

      // Step 4: Collect experimental flags
      const experimental = await collectExperimental();

      // Step 5: Build backup object
      const backup: VoiBackupFile = {
        version: 1,
        createdAt: new Date().toISOString(),
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        accounts,
        settings,
        friends,
        experimental,
        ...(incomplete ? { incomplete } : {}),
      };

      // The file must satisfy the same agreement the importer checks (TASK-504).
      assertFlagsMatchList(backup);

      this.reportProgress({
        step: 'encrypting',
        progress: 60,
        message: 'Encrypting backup...',
      });

      // Step 6: Encrypt backup
      const encrypted = await encryptBackup(JSON.stringify(backup), password, {
        incomplete: incomplete !== undefined,
      });

      this.reportProgress({
        step: 'saving',
        progress: 80,
        message: 'Saving backup file...',
      });

      // Step 7: Write to file system
      const filename = generateBackupFilename();
      const fileContent = JSON.stringify(encrypted, null, 2);

      const backupDir = await getBackupDirectory();
      const backupFile = new File(backupDir, filename);
      await backupFile.write(fileContent);

      this.reportProgress({
        step: 'saving',
        progress: 100,
        // An incomplete backup is never announced as complete (TASK-504).
        message: incomplete ? 'Backup saved' : 'Backup complete!',
      });

      return {
        filename,
        fileUri: backupFile.uri,
        fileContent,
        size: fileContent.length,
        accountCount: accounts.length,
        rekeyedKeyCount: accounts.filter(
          (account) =>
            account.type === 'rekeyed' && account.mnemonic !== undefined
        ).length,
        createdAt: backup.createdAt,
        totalAccountCount: collected.total,
        ...(incomplete ? { incomplete } : {}),
      };
    } catch (error) {
      if (error instanceof BackupError) {
        throw error;
      }
      throw new BackupError(
        `Backup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'COLLECTION_FAILED'
      );
    }
  }

  /**
   * Restore wallet from an encrypted backup file
   *
   * @param fileUri - URI of the backup file to restore
   * @param password - User's backup password
   * @returns Restore result with counts
   */
  static async restoreBackup(
    fileUri: string,
    password: string,
    options: RestoreOptions = {}
  ): Promise<RestoreResult> {
    try {
      // Step 1: Read file
      this.reportProgress({
        step: 'reading',
        progress: 10,
        message: 'Reading backup file...',
      });

      const sourceFile = new File(fileUri);
      const fileContent = await sourceFile.text();

      // Step 2: Validate format + envelope shape (and cap v2 KDF params before
      // any scrypt work — this parses untrusted JSON).
      this.reportProgress({
        step: 'validating',
        progress: 20,
        message: 'Validating backup...',
      });

      let encrypted: EncryptedBackupFile;
      try {
        encrypted = validateEncryptedBackupFile(JSON.parse(fileContent));
      } catch (parseError) {
        if (parseError instanceof BackupError) {
          throw parseError;
        }
        throw new BackupError(
          'Invalid backup file format',
          'INVALID_FILE_FORMAT'
        );
      }

      // Step 3: Decrypt
      this.reportProgress({
        step: 'decrypting',
        progress: 40,
        message: 'Decrypting backup...',
      });

      const decrypted = await decryptBackup(encrypted, password);

      let backup: VoiBackupFile;
      try {
        backup = JSON.parse(decrypted) as VoiBackupFile;
      } catch {
        throw new BackupError('Backup data is corrupted', 'DECRYPTION_FAILED');
      }

      // Step 4: Validate backup structure
      if (!backup.version || !backup.accounts) {
        throw new BackupError(
          'Invalid backup structure',
          'INVALID_FILE_FORMAT'
        );
      }

      assertEnvelopeMatchesPayload(encrypted, backup);
      validateRetainedKeys(backup.accounts);

      // The forgotten-PIN step (DOC-507 5.4): B first. performFullRestore then
      // decides "fresh", sets the breadcrumb, and writes keys, in that order.
      if (options.removeOldPin) {
        if (options.oldPinSession) {
          throw new BackupError(
            'The PIN cannot be both entered and removed',
            'RESTORE_FAILED'
          );
        }
        this.reportProgress({
          step: 'validating',
          progress: 50,
          message: 'Removing the old PIN...',
        });
        await removeOldPinForRestore(backup.accounts);
      }

      // Step 5: Add the file's data to this device (nothing is cleared)
      this.reportProgress({
        step: 'restoring',
        progress: 60,
        message: 'Restoring accounts...',
      });

      const result = await performFullRestore(
        backup.accounts,
        backup.settings,
        backup.friends,
        backup.experimental,
        options
      );

      this.reportProgress({
        step: 'restoring',
        progress: 100,
        message: 'Restore complete!',
      });

      return backup.incomplete
        ? { ...result, leftOut: backup.incomplete.leftOut }
        : result;
    } catch (error) {
      if (error instanceof BackupError) {
        throw error;
      }
      throw new BackupError(
        `Restore failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'RESTORE_FAILED'
      );
    }
  }

  /**
   * Validate a backup file and return info without restoring
   *
   * @param fileUri - URI of the backup file to validate
   * @param password - User's backup password
   * @returns Backup info
   */
  static async validateBackupFile(
    fileUri: string,
    password: string
  ): Promise<BackupInfo> {
    try {
      // Read file
      const sourceFile = new File(fileUri);
      const fileContent = await sourceFile.text();

      // Validate format + envelope shape (and cap v2 KDF params before any
      // scrypt work — this parses untrusted JSON).
      let encrypted: EncryptedBackupFile;
      try {
        encrypted = validateEncryptedBackupFile(JSON.parse(fileContent));
      } catch (parseError) {
        if (parseError instanceof BackupError) {
          throw parseError;
        }
        throw new BackupError(
          'Invalid backup file format',
          'INVALID_FILE_FORMAT'
        );
      }

      // Decrypt
      const decrypted = await decryptBackup(encrypted, password);

      let backup: VoiBackupFile;
      try {
        backup = JSON.parse(decrypted) as VoiBackupFile;
      } catch {
        throw new BackupError('Backup data is corrupted', 'DECRYPTION_FAILED');
      }

      assertEnvelopeMatchesPayload(encrypted, backup);

      // Count account types
      const accountTypes = {
        standard: 0,
        watch: 0,
        rekeyed: 0,
        ledger: 0,
        remoteSigner: 0,
      };

      for (const account of backup.accounts) {
        switch (account.type) {
          case 'standard':
            // A record the file carries without its key is added as Watch Only.
            if (account.withoutKey === true) accountTypes.watch++;
            else accountTypes.standard++;
            break;
          case 'watch':
            accountTypes.watch++;
            break;
          case 'rekeyed':
            accountTypes.rekeyed++;
            break;
          case 'ledger':
            accountTypes.ledger++;
            break;
          case 'remote_signer':
            accountTypes.remoteSigner++;
            break;
        }
      }

      return {
        createdAt: backup.createdAt,
        appVersion: backup.appVersion,
        accountCount: backup.accounts.length,
        accountTypes,
        hasFriends: backup.friends && backup.friends.length > 0,
        friendsCount: backup.friends?.length || 0,
        hasRemoteSignerSettings: !!backup.settings?.remoteSigner,
        ...(backup.incomplete ? { incomplete: backup.incomplete } : {}),
        restorePlan: planRestore(backup.accounts),
      };
    } catch (error) {
      if (error instanceof BackupError) {
        throw error;
      }
      throw new BackupError(
        `Validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'INVALID_FILE_FORMAT'
      );
    }
  }

  /**
   * Share a backup file using system share sheet
   */
  static async shareBackup(fileUri: string): Promise<void> {
    const isAvailable = await Sharing.isAvailableAsync();
    if (!isAvailable) {
      throw new BackupError(
        'Sharing is not available on this device',
        'FILE_WRITE_FAILED'
      );
    }

    await Sharing.shareAsync(fileUri, {
      mimeType: 'application/octet-stream',
      dialogTitle: 'Save Voi Wallet Backup',
      UTI: 'public.data',
    });
  }

  /**
   * Save backup to a specific directory (Downloads)
   * Note: On iOS, this will use the share sheet
   */
  static async saveBackupToDevice(
    fileUri: string,
    filename: string
  ): Promise<string> {
    // On mobile, we use the share sheet to save
    // The user can choose where to save (Files app, Google Drive, etc.)
    await this.shareBackup(fileUri);
    return fileUri;
  }

  /**
   * Clean up temporary backup files
   */
  static async cleanupTempFiles(): Promise<void> {
    try {
      const backupDir = new Directory(Paths.cache, 'backups');
      if (!backupDir.exists) {
        return;
      }

      const contents = await backupDir.list();
      for (const item of contents) {
        if (item instanceof File && item.uri.endsWith('.voibackup')) {
          try {
            await item.delete();
          } catch {
            // Ignore individual file deletion errors
          }
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Re-export types
export * from './types';
export {
  validatePasswordStrength,
  getPasswordStrengthLabel,
  getPasswordStrengthColor,
} from './encryption';
