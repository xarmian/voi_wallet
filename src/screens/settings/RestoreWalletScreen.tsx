import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, CommonActions } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import PasswordInputModal from '@/components/backup/PasswordInputModal';
import BackupProgressModal from '@/components/backup/BackupProgressModal';
import RestoreConfirmationModal from '@/components/backup/RestoreConfirmationModal';
import {
  BackupService,
  RestoreProgress,
  BackupInfo,
  BackupError,
} from '@/services/backup';

interface RouteParams {
  isOnboarding?: boolean;
}

export default function RestoreWalletScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { isOnboarding } = (route.params as RouteParams) || {};
  const { theme, reloadTheme } = useTheme();
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  // State
  const [selectedFile, setSelectedFile] = useState<{
    uri: string;
    name: string;
  } | null>(null);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showProgressModal, setShowProgressModal] = useState(false);
  const [showConfirmationModal, setShowConfirmationModal] = useState(false);
  const [progress, setProgress] = useState<RestoreProgress | null>(null);
  const [backupInfo, setBackupInfo] = useState<BackupInfo | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [isValidating, setIsValidating] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  // Set up progress callback
  useEffect(() => {
    BackupService.setProgressCallback((p) => {
      setProgress(p as RestoreProgress);
    });

    return () => {
      BackupService.clearProgressCallback();
    };
  }, []);

  const handleSelectFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled || !result.assets || result.assets.length === 0) {
        return;
      }

      const file = result.assets[0];

      // Validate file extension
      if (!file.name.endsWith('.voibackup')) {
        Alert.alert(
          'Invalid File',
          'Please select a valid Voi Wallet backup file (.voibackup)',
          [{ text: 'OK' }]
        );
        return;
      }

      setSelectedFile({
        uri: file.uri,
        name: file.name,
      });
      setError(undefined);
      setBackupInfo(null);

      // Show password modal to decrypt and validate
      setShowPasswordModal(true);
    } catch (err) {
      Alert.alert('Error', 'Failed to select file. Please try again.', [
        { text: 'OK' },
      ]);
    }
  }, []);

  const handlePasswordConfirm = useCallback(
    async (enteredPassword: string) => {
      if (!selectedFile) return;

      setPassword(enteredPassword);
      setIsValidating(true);
      setError(undefined);

      try {
        // Validate the backup file
        const info = await BackupService.validateBackupFile(
          selectedFile.uri,
          enteredPassword
        );

        setBackupInfo(info);
        setShowPasswordModal(false);
        setShowConfirmationModal(true);
      } catch (err) {
        if (err instanceof BackupError) {
          if (err.code === 'INTEGRITY_CHECK_FAILED') {
            setError('Incorrect password or corrupted file');
          } else {
            setError(err.message);
          }
        } else {
          setError('Failed to validate backup file');
        }
      } finally {
        setIsValidating(false);
      }
    },
    [selectedFile]
  );

  const handleConfirmRestore = useCallback(async () => {
    if (!selectedFile || !password) return;

    setShowConfirmationModal(false);
    setShowProgressModal(true);
    setIsRestoring(true);

    try {
      const result = await BackupService.restoreBackup(selectedFile.uri, password);
      setShowProgressModal(false);

      // Reload theme to reflect restored settings
      await reloadTheme();

      // Show success message
      const ledgerNote =
        result.ledgerAccountCount > 0
          ? `\n\nNote: ${result.ledgerAccountCount} Ledger account(s) will need to be re-paired with your device.`
          : '';

      Alert.alert(
        'Restore Complete',
        `Successfully restored:\n\n` +
          `• ${result.standardAccountCount} Standard account(s)\n` +
          `• ${result.watchAccountCount} Watch account(s)\n` +
          `• ${result.rekeyedAccountCount} Rekeyed account(s)\n` +
          `• ${result.ledgerAccountCount} Ledger account(s)\n` +
          `• ${result.friendsCount} Friend(s)${ledgerNote}`,
        [
          {
            text: 'OK',
            onPress: () => {
              // Navigate based on context
              if (isOnboarding) {
                // Go to security setup to set PIN
                navigation.dispatch(
                  CommonActions.reset({
                    index: 0,
                    routes: [
                      {
                        name: 'SecuritySetup',
                        params: { source: 'restore' },
                      },
                    ],
                  })
                );
              } else {
                // Go back to main - force app to reload state
                navigation.dispatch(
                  CommonActions.reset({
                    index: 0,
                    routes: [{ name: 'Main' }],
                  })
                );
              }
            },
          },
        ]
      );
    } catch (err) {
      setShowProgressModal(false);
      const message =
        err instanceof BackupError
          ? err.message
          : 'Failed to restore backup. Please try again.';
      Alert.alert('Restore Failed', message, [{ text: 'OK' }]);
    } finally {
      setIsRestoring(false);
      setPassword('');
    }
  }, [selectedFile, password, isOnboarding, navigation, reloadTheme]);

  const handleCancelPassword = useCallback(() => {
    setShowPasswordModal(false);
    setSelectedFile(null);
    setError(undefined);
    setPassword('');
  }, []);

  const handleCancelConfirmation = useCallback(() => {
    setShowConfirmationModal(false);
    setBackupInfo(null);
    setPassword('');
  }, []);

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
        <Text style={styles.headerTitle}>Restore from Backup</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
      >
        {/* Info Section */}
        <GlassCard variant="light" style={styles.infoCard}>
          <View style={styles.infoIconContainer}>
            <Ionicons name="cloud-download" size={32} color={colors.primary} />
          </View>
          <Text style={styles.infoTitle}>Restore Your Wallet</Text>
          <Text style={styles.infoText}>
            Select a Voi Wallet backup file (.voibackup) to restore your
            accounts, settings, and preferences. You will need the password you
            used when creating the backup.
          </Text>
        </GlassCard>

        {/* Warning */}
        <View style={styles.warningContainer}>
          <Ionicons name="alert-circle" size={20} color={colors.error} />
          <Text style={styles.warningText}>
            Restoring from a backup will replace ALL existing accounts and
            settings. Make sure you have backed up your current wallet if
            needed.
          </Text>
        </View>

        {/* Selected File Info */}
        {selectedFile && backupInfo && (
          <GlassCard variant="light" style={styles.fileCard}>
            <View style={styles.fileInfo}>
              <Ionicons name="document" size={24} color={colors.primary} />
              <View style={styles.fileDetails}>
                <Text style={styles.fileName}>{selectedFile.name}</Text>
                <Text style={styles.fileAccounts}>
                  {backupInfo.accountCount} account(s)
                </Text>
              </View>
              <TouchableOpacity onPress={handleSelectFile}>
                <Ionicons
                  name="close-circle"
                  size={24}
                  color={colors.textMuted}
                />
              </TouchableOpacity>
            </View>
          </GlassCard>
        )}

        {/* Instructions */}
        <Text style={styles.sectionTitle}>How to Restore</Text>
        <GlassCard variant="light" style={styles.stepsCard}>
          <View style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>1</Text>
            </View>
            <Text style={styles.stepText}>
              Select your .voibackup file from your device or cloud storage
            </Text>
          </View>
          <View style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>2</Text>
            </View>
            <Text style={styles.stepText}>
              Enter the password you used to create the backup
            </Text>
          </View>
          <View style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>3</Text>
            </View>
            <Text style={styles.stepText}>
              Review and confirm the accounts to be restored
            </Text>
          </View>
          <View style={styles.step}>
            <View style={styles.stepNumber}>
              <Text style={styles.stepNumberText}>4</Text>
            </View>
            <Text style={styles.stepText}>
              Set up a new PIN for your restored wallet
            </Text>
          </View>
        </GlassCard>

        {/* Select File Button */}
        <TouchableOpacity style={styles.selectButton} onPress={handleSelectFile}>
          <Ionicons name="folder-open" size={20} color="#FFFFFF" />
          <Text style={styles.selectButtonText}>Select Backup File</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Password Modal */}
      <PasswordInputModal
        visible={showPasswordModal}
        mode="enter"
        title="Enter Backup Password"
        subtitle="Enter the password you used when creating this backup."
        onCancel={handleCancelPassword}
        onConfirm={handlePasswordConfirm}
        isSubmitting={isValidating}
        error={error}
      />

      {/* Confirmation Modal */}
      <RestoreConfirmationModal
        visible={showConfirmationModal}
        backupInfo={backupInfo}
        onCancel={handleCancelConfirmation}
        onConfirm={handleConfirmRestore}
      />

      {/* Progress Modal */}
      <BackupProgressModal
        visible={showProgressModal}
        progress={progress}
        mode="restore"
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
      marginBottom: theme.spacing.lg,
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
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(239, 68, 68, 0.1)' : '#FEE2E2',
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.lg,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.error,
    },
    warningText: {
      flex: 1,
      marginLeft: theme.spacing.sm,
      fontSize: 13,
      color: theme.mode === 'dark' ? theme.colors.error : '#991B1B',
      lineHeight: 18,
    },
    fileCard: {
      marginBottom: theme.spacing.lg,
    },
    fileInfo: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    fileDetails: {
      flex: 1,
      marginLeft: theme.spacing.md,
    },
    fileName: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
    },
    fileAccounts: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 2,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    stepsCard: {
      marginBottom: theme.spacing.xl,
    },
    step: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      marginBottom: theme.spacing.md,
    },
    stepNumber: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
    },
    stepNumberText: {
      fontSize: 12,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    stepText: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.textSecondary,
      lineHeight: 20,
    },
    selectButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
    },
    selectButtonText: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: '600',
      marginLeft: theme.spacing.sm,
    },
  });
