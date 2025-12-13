import React from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { BackupInfo } from '@/services/backup';

interface RestoreConfirmationModalProps {
  visible: boolean;
  backupInfo: BackupInfo | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function RestoreConfirmationModal({
  visible,
  backupInfo,
  onCancel,
  onConfirm,
}: RestoreConfirmationModalProps) {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  if (!backupInfo) return null;

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const hasLedgerAccounts = backupInfo.accountTypes.ledger > 0;

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.modal}>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.title}>Restore Backup</Text>
            <Text style={styles.subtitle}>
              You are about to restore the following backup:
            </Text>

            {/* Backup Info */}
            <View style={styles.infoCard}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Created</Text>
                <Text style={styles.infoValue}>
                  {formatDate(backupInfo.createdAt)}
                </Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>App Version</Text>
                <Text style={styles.infoValue}>{backupInfo.appVersion}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Total Accounts</Text>
                <Text style={styles.infoValue}>{backupInfo.accountCount}</Text>
              </View>
            </View>

            {/* Account Breakdown */}
            <Text style={styles.sectionTitle}>Accounts to Restore</Text>
            <View style={styles.accountsCard}>
              {backupInfo.accountTypes.standard > 0 && (
                <View style={styles.accountRow}>
                  <Ionicons name="wallet" size={18} color={colors.primary} />
                  <Text style={styles.accountLabel}>Standard Accounts</Text>
                  <Text style={styles.accountCount}>
                    {backupInfo.accountTypes.standard}
                  </Text>
                </View>
              )}
              {backupInfo.accountTypes.watch > 0 && (
                <View style={styles.accountRow}>
                  <Ionicons name="eye" size={18} color={colors.primary} />
                  <Text style={styles.accountLabel}>Watch Accounts</Text>
                  <Text style={styles.accountCount}>
                    {backupInfo.accountTypes.watch}
                  </Text>
                </View>
              )}
              {backupInfo.accountTypes.rekeyed > 0 && (
                <View style={styles.accountRow}>
                  <Ionicons name="key" size={18} color={colors.primary} />
                  <Text style={styles.accountLabel}>Rekeyed Accounts</Text>
                  <Text style={styles.accountCount}>
                    {backupInfo.accountTypes.rekeyed}
                  </Text>
                </View>
              )}
              {backupInfo.accountTypes.ledger > 0 && (
                <View style={styles.accountRow}>
                  <Ionicons
                    name="hardware-chip"
                    size={18}
                    color={colors.primary}
                  />
                  <Text style={styles.accountLabel}>Ledger Accounts</Text>
                  <Text style={styles.accountCount}>
                    {backupInfo.accountTypes.ledger}
                  </Text>
                </View>
              )}
              {backupInfo.hasFriends && (
                <View style={styles.accountRow}>
                  <Ionicons name="people" size={18} color={colors.primary} />
                  <Text style={styles.accountLabel}>Friends</Text>
                  <Text style={styles.accountCount}>
                    {backupInfo.friendsCount}
                  </Text>
                </View>
              )}
            </View>

            {/* Warnings */}
            <View style={styles.warningContainer}>
              <Ionicons name="alert-circle" size={18} color={colors.error} />
              <Text style={styles.warningText}>
                This will replace ALL existing accounts and settings. This
                action cannot be undone.
              </Text>
            </View>

            {hasLedgerAccounts && (
              <View style={styles.ledgerWarningContainer}>
                <Ionicons
                  name="hardware-chip"
                  size={18}
                  color={colors.warning}
                />
                <Text style={styles.ledgerWarningText}>
                  Ledger accounts will need to be re-paired with your device
                  after restore.
                </Text>
              </View>
            )}
          </ScrollView>

          {/* Buttons */}
          <View style={styles.buttons}>
            <TouchableOpacity
              style={[styles.button, styles.cancelButton]}
              onPress={onCancel}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.confirmButton]}
              onPress={onConfirm}
            >
              <Ionicons name="cloud-download" size={18} color="#FFFFFF" />
              <Text style={styles.confirmButtonText}>Restore</Text>
            </TouchableOpacity>
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
      maxWidth: 420,
      maxHeight: '85%',
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 24,
      ...theme.shadows.lg,
    },
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.lg,
    },
    infoCard: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
    },
    infoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: theme.spacing.sm,
    },
    infoLabel: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
    infoValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    accountsCard: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
    },
    accountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
    },
    accountLabel: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.text,
      marginLeft: theme.spacing.md,
    },
    accountCount: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(239, 68, 68, 0.1)' : '#FEE2E2',
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.md,
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
    ledgerWarningContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(255, 159, 10, 0.1)' : '#FFF3CD',
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginBottom: theme.spacing.lg,
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.warning,
    },
    ledgerWarningText: {
      flex: 1,
      marginLeft: theme.spacing.sm,
      fontSize: 13,
      color: theme.mode === 'dark' ? theme.colors.warning : '#856404',
      lineHeight: 18,
    },
    buttons: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: theme.spacing.md,
      paddingTop: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: theme.colors.borderLight,
    },
    button: {
      minWidth: 100,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelButton: {
      backgroundColor: theme.colors.surface,
      marginRight: theme.spacing.md,
    },
    cancelButtonText: {
      color: theme.colors.textSecondary,
      fontSize: 15,
      fontWeight: '500',
    },
    confirmButton: {
      backgroundColor: theme.colors.primary,
    },
    confirmButtonText: {
      color: '#FFFFFF',
      fontSize: 15,
      fontWeight: '600',
      marginLeft: theme.spacing.sm,
    },
  });
