import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { formatVoiBalance } from '@/utils/bigint';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface TransactionConfirmationCardProps {
  amount: string;
  assetSymbol: string;
  recipient: string;
  recipientName: string;
  estimatedFee: number;
  note?: string;
  total: string;
  isVoiTransaction: boolean;
}

export default function TransactionConfirmationCard({
  amount,
  assetSymbol,
  recipient,
  recipientName,
  estimatedFee,
  note,
  total,
  isVoiTransaction,
}: TransactionConfirmationCardProps) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Transaction Details</Text>

      {/* Amount Section */}
      <View style={styles.amountSection}>
        <Text style={styles.amountLabel}>You're sending</Text>
        <Text style={styles.amountValue}>
          {amount} {assetSymbol}
        </Text>
      </View>

      {/* Details */}
      <View style={styles.detailsSection}>
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>To:</Text>
          <Text style={styles.detailValue}>{recipientName}</Text>
        </View>

        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Network Fee:</Text>
          <Text style={styles.detailValue}>
            {formatVoiBalance(estimatedFee)} VOI
          </Text>
        </View>

        {note && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Note:</Text>
            <Text style={styles.noteValue}>{note}</Text>
          </View>
        )}

        {/* Total for VOI transactions */}
        {isVoiTransaction && (
          <View style={[styles.detailRow, styles.totalRow]}>
            <Text style={styles.totalLabel}>Total:</Text>
            <Text style={styles.totalValue}>{total} VOI</Text>
          </View>
        )}

        {/* For non-VOI transactions, show amount + separate fee */}
        {!isVoiTransaction && (
          <>
            <View style={styles.separatorLine} />
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Amount:</Text>
              <Text style={styles.detailValue}>
                {amount} {assetSymbol}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>+ Fee:</Text>
              <Text style={styles.detailValue}>
                {formatVoiBalance(estimatedFee)} VOI
              </Text>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      marginTop: theme.spacing.md,
      ...theme.shadows.md,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.lg,
    },
    amountSection: {
      alignItems: 'center',
      paddingVertical: theme.spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      marginBottom: theme.spacing.md,
    },
    amountLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
    },
    amountValue: {
      fontSize: 32,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    detailsSection: {
      gap: theme.spacing.sm,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    detailLabel: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    detailValue: {
      fontSize: 16,
      color: theme.colors.text,
      fontWeight: '500',
      textAlign: 'right',
      flex: 2,
    },
    noteValue: {
      fontSize: 14,
      color: theme.colors.text,
      textAlign: 'right',
      flex: 2,
      fontStyle: 'italic',
    },
    totalRow: {
      paddingTop: theme.spacing.sm,
      marginTop: theme.spacing.xs,
      borderTopWidth: 2,
      borderTopColor: theme.colors.border,
    },
    totalLabel: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    totalValue: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.colors.primary,
      textAlign: 'right',
      flex: 2,
    },
    separatorLine: {
      height: 1,
      backgroundColor: theme.colors.border,
      marginVertical: theme.spacing.xs,
    },
  });
