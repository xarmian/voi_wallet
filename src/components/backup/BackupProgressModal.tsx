import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { BackupProgress, RestoreProgress } from '@/services/backup';

interface BackupProgressModalProps {
  visible: boolean;
  progress: BackupProgress | RestoreProgress | null;
  mode: 'backup' | 'restore';
}

export default function BackupProgressModal({
  visible,
  progress,
  mode,
}: BackupProgressModalProps) {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const steps =
    mode === 'backup'
      ? ['collecting', 'encrypting', 'saving']
      : ['reading', 'decrypting', 'validating', 'clearing', 'restoring'];

  const stepLabels =
    mode === 'backup'
      ? {
          collecting: 'Collecting data',
          encrypting: 'Encrypting',
          saving: 'Saving file',
        }
      : {
          reading: 'Reading file',
          decrypting: 'Decrypting',
          validating: 'Validating',
          clearing: 'Clearing data',
          restoring: 'Restoring',
        };

  const currentStepIndex = progress ? steps.indexOf(progress.step) : -1;

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <Text style={styles.title}>
            {mode === 'backup' ? 'Creating Backup' : 'Restoring Wallet'}
          </Text>

          {/* Progress indicator */}
          <View style={styles.progressContainer}>
            <ActivityIndicator size="large" color={colors.primary} />
            {progress && (
              <Text style={styles.progressText}>{progress.message}</Text>
            )}
          </View>

          {/* Steps */}
          <View style={styles.stepsContainer}>
            {steps.map((step, index) => {
              const isCompleted = index < currentStepIndex;
              const isCurrent = index === currentStepIndex;
              const isPending = index > currentStepIndex;

              return (
                <View key={step} style={styles.stepRow}>
                  <View
                    style={[
                      styles.stepIndicator,
                      isCompleted && styles.stepCompleted,
                      isCurrent && styles.stepCurrent,
                      isPending && styles.stepPending,
                    ]}
                  >
                    {isCompleted ? (
                      <Ionicons name="checkmark" size={14} color="#FFFFFF" />
                    ) : isCurrent ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <Text style={styles.stepNumber}>{index + 1}</Text>
                    )}
                  </View>
                  <Text
                    style={[
                      styles.stepLabel,
                      isCompleted && styles.stepLabelCompleted,
                      isCurrent && styles.stepLabelCurrent,
                      isPending && styles.stepLabelPending,
                    ]}
                  >
                    {stepLabels[step as keyof typeof stepLabels]}
                  </Text>
                </View>
              );
            })}
          </View>

          {/* Warning */}
          <View style={styles.warningContainer}>
            <Ionicons name="warning" size={16} color={colors.warning} />
            <Text style={styles.warningText}>
              Please do not close the app or navigate away.
            </Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: theme.colors.overlay,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
    },
    modal: {
      width: '100%',
      maxWidth: 380,
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 28,
      ...theme.shadows.lg,
    },
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
      marginBottom: theme.spacing.lg,
    },
    progressContainer: {
      alignItems: 'center',
      marginBottom: theme.spacing.xl,
    },
    progressText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.md,
      textAlign: 'center',
    },
    stepsContainer: {
      marginBottom: theme.spacing.lg,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    stepIndicator: {
      width: 28,
      height: 28,
      borderRadius: 14,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: theme.spacing.md,
    },
    stepCompleted: {
      backgroundColor: theme.colors.success,
    },
    stepCurrent: {
      backgroundColor: theme.colors.primary,
    },
    stepPending: {
      backgroundColor: theme.colors.borderLight,
    },
    stepNumber: {
      fontSize: 12,
      fontWeight: '600',
      color: theme.colors.textMuted,
    },
    stepLabel: {
      fontSize: 14,
      flex: 1,
    },
    stepLabelCompleted: {
      color: theme.colors.success,
    },
    stepLabelCurrent: {
      color: theme.colors.text,
      fontWeight: '600',
    },
    stepLabelPending: {
      color: theme.colors.textMuted,
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: theme.colors.borderLight,
    },
    warningText: {
      fontSize: 13,
      color: theme.colors.warning,
      marginLeft: theme.spacing.sm,
    },
  });
