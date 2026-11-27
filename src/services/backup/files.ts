/**
 * Where backup files live on this device. BackupService and the wipe (TASK-469)
 * both read the locations from here, so there is one definition of each.
 *
 * Kept free of the backup service's other imports, so the wipe can use it
 * without loading the collectors and restorers.
 */

import { Directory, Paths } from 'expo-file-system';

/** The extension of every backup file the app writes. */
export const BACKUP_FILE_EXTENSION = '.voibackup';

/** Where BackupService writes a backup before it is shared or saved. */
export function backupDirectory(): Directory {
  return new Directory(Paths.cache, 'backups');
}

/**
 * Where expo-document-picker copies a picked file when `copyToCacheDirectory`
 * is set, as RestoreWalletScreen does: `<cache>/DocumentPicker/<uuid>.<ext>` on
 * iOS (DocumentPickerModule.swift) and Android (DocumentPickerModule.kt).
 */
export function pickerCacheDirectory(): Directory {
  return new Directory(Paths.cache, 'DocumentPicker');
}
