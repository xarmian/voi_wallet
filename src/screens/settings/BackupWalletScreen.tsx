import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  Platform,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import { useAccounts } from '@/store/walletStore';
import { AccountType } from '@/types/wallet';
import PasswordInputModal from '@/components/backup/PasswordInputModal';
import BackupProgressModal from '@/components/backup/BackupProgressModal';
import {
  BackupService,
  BackupProgress,
  BackupResult,
  BackupError,
} from '@/services/backup';

export default function BackupWalletScreen() {
  const navigation = useNavigation();
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();
  const accounts = useAccounts();

  // Modal states
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [backupSaved, setBackupSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Account counts
  const standardAccounts = accounts.filter((a) => a.type === AccountType.STANDARD);
  const watchAccounts = accounts.filter((a) => a.type === AccountType.WATCH);
  const rekeyedAccounts = accounts.filter((a) => a.type === AccountType.REKEYED);
  const ledgerAccounts = accounts.filter((a) => a.type === AccountType.LEDGER);

  // Set up progress callback
  useEffect(() => {
    BackupService.setProgressCallback((p) => {
      setProgress(p as BackupProgress);
    });

    return () => {
      BackupService.clearProgressCallback();
    };
  }, []);

  const handleStartBackup = useCallback(() => {
    if (accounts.length === 0) {
      Alert.alert(
        'No Accounts',
        'You need at least one account to create a backup.',
        [{ text: 'OK' }]
      );
      return;
    }
    setError(undefined);
    setShowPasswordModal(true);
  }, [accounts.length]);

  const handlePasswordConfirm = useCallback(async (password: string) => {
    setShowPasswordModal(false);
    setShowProgressModal(true);
    setIsCreatingBackup(true);
    setError(undefined);

    try {
      const result = await BackupService.createBackup(password);
      setBackupResult(result);
      setShowProgressModal(false);
      // Show success state - user will see save/share options in the UI
    } catch (err) {
      setShowProgressModal(false);
      const message =
        err instanceof BackupError
          ? err.message
          : 'Failed to create backup. Please try again.';
      Alert.alert('Backup Failed', message, [{ text: 'OK' }]);
    } finally {
      setIsCreatingBackup(false);
    }
  }, [navigation]);

  const handleCancel = useCallback(() => {
    setShowPasswordModal(false);
    setError(undefined);
  }, []);

  const handleSaveLocal = useCallback(async () => {
    if (!backupResult) return;

    if (Platform.OS === 'android') {
      try {
        // Use SAF to let user pick a directory
        const permissions =
          await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (!permissions.granted) {
          return;
        }

        // Create file in user-selected directory
        const newFileUri = await FileSystem.StorageAccessFramework.createFileAsync(
          permissions.directoryUri,
          backupResult.filename,
          'application/octet-stream'
        );

        // Write content to the new file (use content from backup result)
        await FileSystem.writeAsStringAsync(newFileUri, backupResult.fileContent);
        setBackupSaved(true);
        Alert.alert('Saved', 'Backup saved to your selected folder.');
      } catch (err) {
        console.error('Save error:', err);
        const message = (err as Error).message || '';
        if (message.includes('cancel') || message.includes('Cancel')) {
          return; // User cancelled
        }
        Alert.alert(
          'Save Failed',
          `Could not save the backup file: ${message}`
        );
      }
    } else {
      // iOS - use share sheet which includes "Save to Files"
      try {
        await BackupService.shareBackup(backupResult.fileUri);
        setBackupSaved(true);
      } catch (err) {
        Alert.alert('Save Failed', 'Could not save the backup file. Please try again.');
      }
    }
  }, [backupResult]);

  const handleShare = useCallback(async () => {
    if (!backupResult) return;
    try {
      await BackupService.shareBackup(backupResult.fileUri);
      setBackupSaved(true);
    } catch (err) {
      Alert.alert('Share Failed', 'Could not share the backup file. Please try again.');
    }
  }, [backupResult]);

  const handleDone = useCallback(async () => {
    if (!backupSaved && backupResult) {
      Alert.alert(
        'Backup Not Saved',
        'Your backup has not been saved yet. If you leave now, the backup file will be lost.',
        [
          { text: 'Go Back', style: 'cancel' },
          {
            text: 'Discard Backup',
            style: 'destructive',
            onPress: async () => {
              await BackupService.cleanupTempFiles();
              navigation.goBack();
            },
          },
        ]
      );
    } else {
      await BackupService.cleanupTempFiles();
      navigation.goBack();
    }
  }, [backupSaved, backupResult, navigation]);


  // Success state - backup is ready to save
  if (backupResult) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <View style={styles.placeholder} />
          <Text style={styles.headerTitle}>Backup Ready</Text>
          <View style={styles.placeholder} />
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
        >
          {/* Success Icon */}
          <GlassCard variant="light" style={styles.infoCard}>
            <View
              style={[
                styles.infoIconContainer,
                { backgroundColor: backupSaved ? `${colors.success}15` : `${colors.primary}15` },
              ]}
            >
              <Ionicons
                name={backupSaved ? 'checkmark-circle' : 'document'}
                size={32}
                color={backupSaved ? colors.success : colors.primary}
              />
            </View>
            <Text style={styles.infoTitle}>
              {backupSaved ? 'Backup Saved!' : 'Backup Created'}
            </Text>
            <Text style={styles.infoText}>
              {backupSaved
                ? 'Your backup has been saved. Store it in a safe place.'
                : 'Your encrypted backup is ready. Save it to your device or share it to cloud storage.'}
            </Text>
          </GlassCard>

          {/* Backup Details */}
          <Text style={styles.sectionTitle}>Backup Details</Text>
          <GlassCard variant="light" style={styles.card}>
            <View style={styles.includeRow}>
              <Ionicons name="document-text" size={20} color={colors.primary} />
              <Text style={styles.includeLabel}>Filename</Text>
            </View>
            <Text style={styles.filenameText}>{backupResult.filename}</Text>

            <View style={styles.divider} />

            <View style={styles.includeRow}>
              <Ionicons name="people" size={20} color={colors.primary} />
              <Text style={styles.includeLabel}>Accounts</Text>
              <Text style={styles.includeValue}>{backupResult.accountCount}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.includeRow}>
              <Ionicons name="resize" size={20} color={colors.primary} />
              <Text style={styles.includeLabel}>Size</Text>
              <Text style={styles.includeValue}>
                {(backupResult.size / 1024).toFixed(1)} KB
              </Text>
            </View>
          </GlassCard>

          {/* Warning if not saved */}
          {!backupSaved && (
            <View style={styles.warningContainer}>
              <Ionicons name="alert-circle" size={20} color={colors.error} />
              <Text style={[styles.warningText, { color: colors.error }]}>
                Your backup has not been saved yet! Save it now or it will be lost.
              </Text>
            </View>
          )}

          {/* Action Buttons */}
          {Platform.OS === 'android' ? (
            <>
              <TouchableOpacity style={styles.createButton} onPress={handleSaveLocal}>
                <Ionicons name="folder" size={20} color="#FFFFFF" />
                <Text style={styles.createButtonText}>
                  {backupSaved ? 'Save Another Copy' : 'Save to Device'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.secondaryButton, { marginTop: 12 }]}
                onPress={handleShare}
              >
                <View style={styles.secondaryButtonContent}>
                  <Ionicons name="share-outline" size={18} color={colors.text} />
                  <Text style={[styles.secondaryButtonText, { marginLeft: 8 }]}>
                    Share to Cloud or Other Apps
                  </Text>
                </View>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <TouchableOpacity style={styles.createButton} onPress={handleSaveLocal}>
                <Ionicons name="share-outline" size={20} color="#FFFFFF" />
                <Text style={styles.createButtonText}>
                  {backupSaved ? 'Export Another Copy' : 'Export Backup'}
                </Text>
              </TouchableOpacity>

              <Text style={styles.exportHint}>
                Save to Files, iCloud, Google Drive, or share via AirDrop
              </Text>
            </>
          )}

          <TouchableOpacity
            style={[styles.doneButton, !backupSaved && styles.doneButtonMuted]}
            onPress={handleDone}
          >
            <Text style={[styles.doneButtonText, !backupSaved && styles.doneButtonTextMuted]}>
              Done
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Backup Wallet</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
      >
        {/* Info Section */}
        <GlassCard variant="light" style={styles.infoCard}>
          <View style={styles.infoIconContainer}>
            <Ionicons name="cloud-upload" size={32} color={colors.primary} />
          </View>
          <Text style={styles.infoTitle}>Secure Backup</Text>
          <Text style={styles.infoText}>
            Create an encrypted backup of your entire wallet, including all
            accounts, settings, and preferences. The backup will be protected
            with a password of your choice.
          </Text>
        </GlassCard>

        {/* What's Included */}
        <Text style={styles.sectionTitle}>What's Included</Text>
        <GlassCard variant="light" style={styles.card}>
          <View style={styles.includeRow}>
            <Ionicons name="wallet" size={20} color={colors.primary} />
            <Text style={styles.includeLabel}>Standard Accounts</Text>
            <Text style={styles.includeValue}>{standardAccounts.length}</Text>
          </View>
          {standardAccounts.length > 0 && (
            <Text style={styles.includeNote}>
              Recovery phrases will be encrypted
            </Text>
          )}

          <View style={styles.divider} />

          <View style={styles.includeRow}>
            <Ionicons name="eye" size={20} color={colors.primary} />
            <Text style={styles.includeLabel}>Watch Accounts</Text>
            <Text style={styles.includeValue}>{watchAccounts.length}</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.includeRow}>
            <Ionicons name="key" size={20} color={colors.primary} />
            <Text style={styles.includeLabel}>Rekeyed Accounts</Text>
            <Text style={styles.includeValue}>{rekeyedAccounts.length}</Text>
          </View>

          <View style={styles.divider} />

          <View style={styles.includeRow}>
            <Ionicons name="hardware-chip" size={20} color={colors.primary} />
            <Text style={styles.includeLabel}>Ledger Accounts</Text>
            <Text style={styles.includeValue}>{ledgerAccounts.length}</Text>
          </View>
          {ledgerAccounts.length > 0 && (
            <Text style={styles.includeNote}>
              Metadata only - device re-pairing required on restore
            </Text>
          )}

          <View style={styles.divider} />

          <View style={styles.includeRow}>
            <Ionicons name="settings" size={20} color={colors.primary} />
            <Text style={styles.includeLabel}>Settings & Preferences</Text>
            <Ionicons
              name="checkmark-circle"
              size={20}
              color={colors.success}
            />
          </View>

          <View style={styles.divider} />

          <View style={styles.includeRow}>
            <Ionicons name="people" size={20} color={colors.primary} />
            <Text style={styles.includeLabel}>Friends List</Text>
            <Ionicons
              name="checkmark-circle"
              size={20}
              color={colors.success}
            />
          </View>
        </GlassCard>

        {/* Security Warning */}
        <View style={styles.warningContainer}>
          <Ionicons name="shield-checkmark" size={20} color={colors.warning} />
          <Text style={styles.warningText}>
            Your backup will be encrypted with AES-256 encryption. Make sure to
            store your backup password securely - you will need it to restore
            your wallet.
          </Text>
        </View>

        {/* Create Backup Button */}
        <TouchableOpacity
          style={[
            styles.createButton,
            accounts.length === 0 && styles.buttonDisabled,
          ]}
          onPress={handleStartBackup}
          disabled={accounts.length === 0}
        >
          <Ionicons name="download" size={20} color="#FFFFFF" />
          <Text style={styles.createButtonText}>Create Backup</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Password Modal */}
      <PasswordInputModal
        visible={showPasswordModal}
        mode="create"
        onCancel={handleCancel}
        onConfirm={handlePasswordConfirm}
        isSubmitting={isCreatingBackup}
        error={error}
      />

      {/* Progress Modal */}
      <BackupProgressModal
        visible={showProgressModal}
        progress={progress}
        mode="backup"
      />
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    backButton: {
      padding: theme.spacing.sm,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholder: {
      width: 40,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      padding: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
    },
    infoCard: {
      alignItems: 'center',
      marginBottom: theme.spacing.xl,
    },
    infoIconContainer: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: `${theme.colors.primary}15`,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    infoTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    infoText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    card: {
      marginBottom: theme.spacing.lg,
    },
    includeRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
    },
    includeLabel: {
      flex: 1,
      fontSize: 15,
      color: theme.colors.text,
      marginLeft: theme.spacing.md,
    },
    includeValue: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    includeNote: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginLeft: 36,
      marginTop: -4,
      marginBottom: theme.spacing.sm,
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.borderLight,
      marginVertical: theme.spacing.sm,
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(255, 159, 10, 0.1)' : '#FFF3CD',
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.xl,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.warning,
    },
    warningText: {
      flex: 1,
      marginLeft: theme.spacing.sm,
      fontSize: 13,
      color: theme.mode === 'dark' ? theme.colors.warning : '#856404',
      lineHeight: 18,
    },
    createButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
    },
    createButtonText: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: '600',
      marginLeft: theme.spacing.sm,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    filenameText: {
      fontSize: 13,
      color: theme.colors.textMuted,
      marginLeft: 36,
      marginTop: -4,
      marginBottom: theme.spacing.sm,
      fontFamily: 'monospace',
    },
    secondaryButton: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    secondaryButtonText: {
      color: theme.colors.text,
      fontSize: 15,
      fontWeight: '500',
    },
    secondaryButtonContent: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    exportHint: {
      fontSize: 12,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.md,
    },
    doneButton: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.lg,
      marginTop: theme.spacing.md,
    },
    doneButtonMuted: {
      opacity: 0.6,
    },
    doneButtonText: {
      color: theme.colors.primary,
      fontSize: 16,
      fontWeight: '600',
    },
    doneButtonTextMuted: {
      color: theme.colors.textMuted,
    },
  });
