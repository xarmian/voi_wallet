import React from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import type { BackupReport } from '@/services/backup/backupReport';

export function BackupReportBlocks({ report }: { report: BackupReport }) {
  const styles = useThemedStyles(createStyles);
  return (
    <>
      {[report.withoutKey, report.otherKey].map(
        (block, index) =>
          block && (
            <View key={index} style={styles.block}>
              <Text style={styles.text}>{block.text}</Text>
              {block.rows.map((row, i) => (
                <View key={i} style={styles.row}>
                  <Text style={styles.label}>
                    {row.label} ({row.shortAddress})
                  </Text>
                  <Text style={styles.text}>{row.reason}</Text>
                </View>
              ))}
              {block.advice && <Text style={styles.text}>{block.advice}</Text>}
            </View>
          )
      )}
    </>
  );
}

export default function KeysNotInBackupModal({
  visible,
  report,
  onAcknowledge,
}: {
  visible: boolean;
  report: BackupReport;
  onAcknowledge: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  if (!report.incomplete) return null;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {}}
    >
      <View style={styles.overlay}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title}>{report.title}</Text>
          <ScrollView style={styles.scroll}>
            <BackupReportBlocks report={report} />
          </ScrollView>
          <TouchableOpacity
            style={styles.button}
            accessibilityRole="button"
            accessibilityLabel={report.acknowledgeText}
            onPress={onAcknowledge}
          >
            <Text style={styles.buttonText}>{report.acknowledgeText}</Text>
          </TouchableOpacity>
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
      padding: theme.spacing.lg,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      maxHeight: '85%',
      backgroundColor: theme.colors.modalBackground,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      ...theme.shadows.lg,
    },
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    scroll: { maxHeight: 400, flexShrink: 1 },
    block: { marginBottom: theme.spacing.md },
    row: { marginVertical: theme.spacing.sm },
    label: { fontSize: 14, fontWeight: '600', color: theme.colors.text },
    text: { fontSize: 14, lineHeight: 20, color: theme.colors.textSecondary },
    button: {
      backgroundColor: theme.colors.primary,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginTop: theme.spacing.md,
      alignItems: 'center',
    },
    buttonText: {
      color: theme.colors.buttonText,
      fontSize: 16,
      fontWeight: '600',
    },
  });
