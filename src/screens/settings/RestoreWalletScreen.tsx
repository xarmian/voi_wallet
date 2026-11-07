import { useCoverPaused } from '@/hooks/useCoverPaused';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useNavigation,
  useRoute,
  CommonActions,
} from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import { useTheme } from '@/contexts/ThemeContext';
import { useAuth } from '@/contexts/AuthContext';
import { useWalletStore } from '@/store/walletStore';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import PasswordInputModal from '@/components/backup/PasswordInputModal';
import BackupProgressModal from '@/components/backup/BackupProgressModal';
import RestoreConfirmationModal from '@/components/backup/RestoreConfirmationModal';
import OldPinStep from '@/components/backup/OldPinStep';
import ForgottenPinConsent from '@/components/backup/ForgottenPinConsent';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { ENTER_PIN_INSTEAD_TEXT } from '@/services/backup/forgottenPinCopy';
import {
  BackupService,
  RestoreProgress,
  BackupInfo,
  BackupError,
} from '@/services/backup';
import {
  buildRestoreReport,
  formatRestoreReport,
  RESTORE_ADDS_TEXT,
  SETTINGS_STAY_TEXT,
} from '@/services/backup/restoreReport';

// How long a verified old PIN keeps the session vault filled on this screen.
const OLD_PIN_SESSION_MS = 5 * 60 * 1000;

export default function RestoreWalletScreen() {
  const covered = useCoverPaused();
  const navigation = useNavigation();
  const route = useRoute();
  const isOnboarding = (route.params as { isOnboarding?: boolean } | undefined)
    ?.isOnboarding;
  const { recheckAuthState, unlockForRestore, clearRestoreVault } = useAuth();
  // One selector, one primitive (a derived object would loop the store).
  const deviceAccountCount = useWalletStore(
    (state) => state.wallet?.accounts.length ?? 0
  );
  const { reloadTheme } = useTheme();
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
  // The old-PIN step (DOC-507 section 3): on an onboarding restore where the
  // device still holds a PIN credential, the PIN is verified BEFORE a file is
  // chosen. 'needed' blocks the file chooser; 'verified' carries the vault epoch
  // the verify produced.
  const [oldPin, setOldPin] = useState<
    'checking' | 'none' | 'needed' | 'verified' | 'forgotten'
  >(isOnboarding ? 'checking' : 'none');
  const [showForgottenConsent, setShowForgottenConsent] = useState(false);
  const oldPinEpoch = useRef<number | null>(null);
  const restoreInFlight = useRef(false);
  const validationGeneration = useRef(0);
  useEffect(() => {
    if (covered) {
      validationGeneration.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- A lock must discard the parent password and return confirmation to password entry.
      setPassword('');
      setIsValidating(false);
      setBackupInfo(null);
      setShowConfirmationModal(false);
      setShowForgottenConsent(false);
      setShowPasswordModal(!!selectedFile && !restoreInFlight.current);
    }
  }, [covered, selectedFile]);
  // Bumped whenever the screen is left or the app leaves the foreground. A PIN
  // check that started before the bump must not fill the vault when it ends.
  const oldPinGeneration = useRef(0);
  const sessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const endOldPinSession = useCallback(
    (backTo: 'needed' | null) => {
      // Every way out of the step (background, leaving, the forgotten link,
      // cancel, finishing, the timer) invalidates a PIN check that is still
      // running, so it cannot fill the vault or arm a session when it ends.
      oldPinGeneration.current += 1;
      if (sessionTimer.current) clearTimeout(sessionTimer.current);
      sessionTimer.current = null;
      // Only a verified session has anything to end. A background event on a
      // screen with no session (Settings, or before the PIN) changes nothing.
      if (oldPinEpoch.current === null) return;
      oldPinEpoch.current = null;
      clearRestoreVault();
      if (backTo) {
        setSelectedFile(null);
        setBackupInfo(null);
        setPassword('');
        setShowPasswordModal(false);
        setShowConfirmationModal(false);
        setOldPin(backTo);
      }
    },
    [clearRestoreVault]
  );

  useEffect(() => {
    if (!isOnboarding) return;
    let cancelled = false;
    AccountSecureStorage.hasPinStrict()
      .then((hasPin) => {
        if (!cancelled) setOldPin(hasPin ? 'needed' : 'none');
      })
      .catch(() => {
        // A credential that cannot be read is not shown as absent: the restore
        // itself reads strictly and stops.
        if (!cancelled) setOldPin('none');
      });
    return () => {
      cancelled = true;
    };
  }, [isOnboarding]);

  // The vault is cleared when the user leaves, the app goes to the background,
  // or the session times out; the step returns.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') endOldPinSession('needed');
    });
    return () => {
      sub.remove();
      endOldPinSession(null);
    };
  }, [endOldPinSession]);

  const handleOldPinVerified = useCallback(
    (epoch: number) => {
      oldPinEpoch.current = epoch;
      setOldPin('verified');
      if (sessionTimer.current) clearTimeout(sessionTimer.current);
      sessionTimer.current = setTimeout(
        () => endOldPinSession('needed'),
        OLD_PIN_SESSION_MS
      );
    },
    [endOldPinSession]
  );

  const readLockedUntil = useCallback(
    async () => (await AccountSecureStorage.getPinThrottleState()).lockedUntil,
    []
  );

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
    } catch {
      Alert.alert('Error', 'Failed to select file. Please try again.', [
        { text: 'OK' },
      ]);
    }
  }, []);

  const handlePasswordConfirm = useCallback(
    async (enteredPassword: string) => {
      if (!selectedFile) return;
      const generation = validationGeneration.current;

      setPassword(enteredPassword);
      setIsValidating(true);
      setError(undefined);

      try {
        // Validate the backup file
        const info = await BackupService.validateBackupFile(
          selectedFile.uri,
          enteredPassword
        );

        if (generation !== validationGeneration.current) return;
        setBackupInfo(info);
        setShowPasswordModal(false);
        // The forgotten-PIN step has its own consent screen (DOC-507 5.3).
        if (oldPin === 'forgotten') setShowForgottenConsent(true);
        else setShowConfirmationModal(true);
      } catch (err) {
        if (generation !== validationGeneration.current) return;
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
        if (generation === validationGeneration.current) setIsValidating(false);
      }
    },
    [selectedFile, oldPin]
  );

  const handleConfirmRestore = useCallback(async () => {
    if (!selectedFile || !password) return;
    // A second tap before the first restore ends starts nothing.
    if (restoreInFlight.current) return;
    restoreInFlight.current = true;

    setShowConfirmationModal(false);
    setShowForgottenConsent(false);
    setShowProgressModal(true);

    try {
      const result = await BackupService.restoreBackup(
        selectedFile.uri,
        password,
        oldPin === 'forgotten'
          ? { removeOldPin: true }
          : oldPinEpoch.current !== null
            ? { oldPinSession: { epoch: oldPinEpoch.current } }
            : {}
      );
      setShowProgressModal(false);

      // Reload theme to reflect restored settings
      await reloadTheme();

      // Report what happened to each record. The words are product's and are
      // built (and tested) in restoreReport.
      const report = buildRestoreReport(result);

      Alert.alert(report.title, formatRestoreReport(report), [
        {
          text: 'OK',
          onPress: () => {
            // Restore is add-only and never clears a PIN, so SecuritySetup is
            // right ONLY for a fresh device (no PIN, no accounts before it),
            // where the restored keys still have no PIN. Anything else keeps
            // the PIN it has: from Settings the session simply carries on, and
            // from onboarding the auth state is re-read, which now finds a
            // wallet and a PIN and lands on the normal unlock (DOC-507 3.6).
            if (result.settingsRestored) {
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
            } else if (isOnboarding) {
              // The old-PIN vault is cleared first: the normal unlock fills it
              // again (and runs the sweep that upgrades the restored keys).
              endOldPinSession(null);
              void recheckAuthState();
            } else {
              navigation.goBack();
            }
          },
        },
      ]);
    } catch (err) {
      setShowProgressModal(false);
      const message =
        err instanceof BackupError
          ? err.message
          : 'Failed to restore backup. Please try again.';
      Alert.alert('Restore Failed', message, [{ text: 'OK' }]);
      if (oldPin === 'forgotten') {
        // The step may have removed the PIN before it failed: show what is true.
        AccountSecureStorage.hasPinStrict()
          .then((hasPin) => setOldPin(hasPin ? 'forgotten' : 'none'))
          .catch(() => {});
      }
    } finally {
      restoreInFlight.current = false;
      setPassword('');
    }
  }, [
    selectedFile,
    password,
    navigation,
    reloadTheme,
    isOnboarding,
    recheckAuthState,
    endOldPinSession,
    oldPin,
  ]);

  const handleCancelPassword = useCallback(() => {
    setShowPasswordModal(false);
    setSelectedFile(null);
    setError(undefined);
    setPassword('');
  }, []);

  const handleForgotten = useCallback(() => {
    // The vault must not carry a verified PIN into the step (DOC-507 5.4).
    endOldPinSession(null);
    setOldPin('forgotten');
  }, [endOldPinSession]);

  const handleCancelConfirmation = useCallback(() => {
    setShowConfirmationModal(false);
    setShowForgottenConsent(false);
    setBackupInfo(null);
    setPassword('');
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => {
            endOldPinSession(null);
            navigation.goBack();
          }}
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
            Select a Voi Wallet backup file (.voibackup) to add its accounts to
            this wallet. You will need the password you used when creating the
            backup.
          </Text>
        </GlassCard>

        {/* What restore does: it only adds */}
        <View style={styles.warningContainer}>
          <Ionicons
            name="information-circle"
            size={20}
            color={colors.primary}
          />
          <Text style={styles.warningText}>
            {RESTORE_ADDS_TEXT}
            {deviceAccountCount > 0 ? ` ${SETTINGS_STAY_TEXT}` : ''}
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
              Set up a PIN if this phone doesn&apos;t have one yet
            </Text>
          </View>
        </GlassCard>

        {oldPin === 'needed' && (
          <OldPinStep
            unlock={(secret) => {
              const generation = oldPinGeneration.current;
              return unlockForRestore(
                secret,
                () => oldPinGeneration.current === generation
              );
            }}
            readLockedUntil={readLockedUntil}
            onVerified={handleOldPinVerified}
            onForgotten={handleForgotten}
          />
        )}

        {oldPin === 'forgotten' && showForgottenConsent && backupInfo && (
          <ForgottenPinConsent
            info={backupInfo}
            onConfirm={handleConfirmRestore}
            onCancel={handleCancelConfirmation}
          />
        )}

        {oldPin === 'forgotten' && !showForgottenConsent && (
          <TouchableOpacity
            onPress={() => setOldPin('needed')}
            accessibilityRole="button"
          >
            <Text style={styles.stepText}>{ENTER_PIN_INSTEAD_TEXT}</Text>
          </TouchableOpacity>
        )}

        {/* Select File Button */}
        {(oldPin === 'none' ||
          oldPin === 'verified' ||
          (oldPin === 'forgotten' && !showForgottenConsent)) && (
          <TouchableOpacity
            style={styles.selectButton}
            onPress={handleSelectFile}
          >
            <Ionicons name="folder-open" size={20} color={colors.buttonText} />
            <Text style={styles.selectButtonText}>Select Backup File</Text>
          </TouchableOpacity>
        )}
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
        deviceHasAccounts={deviceAccountCount > 0}
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
      backgroundColor: theme.colors.errorLight,
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
      color: theme.colors.text,
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
      color: theme.colors.buttonText,
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
      color: theme.colors.buttonText,
      fontSize: 16,
      fontWeight: '600',
      marginLeft: theme.spacing.sm,
    },
  });
