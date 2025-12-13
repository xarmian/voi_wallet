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
  BackupError,
} from './types';
import { encryptBackup, decryptBackup } from './encryption';
import {
  collectAccounts,
  collectSettings,
  collectFriends,
  collectExperimental,
} from './collectors';
import { performFullRestore } from './restorers';

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
 * Generate backup filename
 */
function generateBackupFilename(): string {
  const dateStr = formatDateForFilename(new Date());
  return `voi-wallet-${dateStr}.voibackup`;
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
  private static progressCallback?: (progress: BackupProgress | RestoreProgress) => void;

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
  private static reportProgress(progress: BackupProgress | RestoreProgress): void {
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
  static async createBackup(password: string, pin?: string): Promise<BackupResult> {
    try {
      // Step 1: Collect accounts
      this.reportProgress({
        step: 'collecting',
        progress: 10,
        message: 'Collecting account data...',
      });

      const accounts = await collectAccounts(pin);

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
      };

      this.reportProgress({
        step: 'encrypting',
        progress: 60,
        message: 'Encrypting backup...',
      });

      // Step 6: Encrypt backup
      const encrypted = await encryptBackup(JSON.stringify(backup), password);

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
        message: 'Backup complete!',
      });

      return {
        filename,
        fileUri: backupFile.uri,
        fileContent,
        size: fileContent.length,
        accountCount: accounts.length,
        createdAt: backup.createdAt,
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
    password: string
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

      let encrypted: EncryptedBackupFile;
      try {
        encrypted = JSON.parse(fileContent) as EncryptedBackupFile;
      } catch {
        throw new BackupError('Invalid backup file format', 'INVALID_FILE_FORMAT');
      }

      // Step 2: Validate format
      this.reportProgress({
        step: 'validating',
        progress: 20,
        message: 'Validating backup...',
      });

      if (encrypted.format !== 'voibackup') {
        throw new BackupError(
          'Not a valid Voi Wallet backup file',
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
        throw new BackupError(
          'Backup data is corrupted',
          'DECRYPTION_FAILED'
        );
      }

      // Step 4: Validate backup structure
      if (!backup.version || !backup.accounts) {
        throw new BackupError(
          'Invalid backup structure',
          'INVALID_FILE_FORMAT'
        );
      }

      // Step 5: Clear existing data
      this.reportProgress({
        step: 'clearing',
        progress: 50,
        message: 'Clearing existing data...',
      });

      // Step 6: Restore all data
      this.reportProgress({
        step: 'restoring',
        progress: 60,
        message: 'Restoring accounts...',
      });

      const result = await performFullRestore(
        backup.accounts,
        backup.settings,
        backup.friends,
        backup.experimental
      );

      this.reportProgress({
        step: 'restoring',
        progress: 100,
        message: 'Restore complete!',
      });

      return result;
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

      let encrypted: EncryptedBackupFile;
      try {
        encrypted = JSON.parse(fileContent) as EncryptedBackupFile;
      } catch {
        throw new BackupError('Invalid backup file format', 'INVALID_FILE_FORMAT');
      }

      // Validate format
      if (encrypted.format !== 'voibackup') {
        throw new BackupError(
          'Not a valid Voi Wallet backup file',
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
            accountTypes.standard++;
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
export { validatePasswordStrength, getPasswordStrengthLabel, getPasswordStrengthColor } from './encryption';
