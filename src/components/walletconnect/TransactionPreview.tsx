import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { truncateAddress } from '@/services/walletconnect/utils';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface TransactionData {
  from: string;
  to: string;
  amount?: number;
  fee: number;
  note?: string;
  assetId?: number;
  type: string;
}

interface Props {
  transaction: TransactionData;
  index?: number;
  showDivider?: boolean;
  networkCurrency?: string;
}

export default function TransactionPreview({
  transaction,
  index,
  showDivider = true,
  networkCurrency = 'VOI',
}: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  const formatAmount = (amount: number, assetId?: number) => {
    const formatted = (amount / 1000000).toFixed(6);
    const unit = assetId ? 'ASA' : networkCurrency;
    return `${formatted} ${unit}`;
  };

  const getTransactionIcon = (type: string) => {
    switch (type.toLowerCase()) {
      case 'pay':
        return 'arrow-forward';
      case 'axfer':
        return 'swap-horizontal';
      case 'acfg':
        return 'settings';
      case 'afrz':
        return 'lock-closed';
      case 'appl':
        return 'apps';
      default:
        return 'document';
    }
  };

  const getTransactionLabel = (type: string) => {
    switch (type.toLowerCase()) {
      case 'pay':
        return 'Payment';
      case 'axfer':
        return 'Asset Transfer';
      case 'acfg':
        return 'Asset Config';
      case 'afrz':
        return 'Asset Freeze';
      case 'appl':
        return 'App Call';
      default:
        return type.toUpperCase();
    }
  };

  return (
    <View style={styles.container}>
      {typeof index === 'number' && (
        <Text style={styles.transactionIndex}>Transaction {index + 1}</Text>
      )}

      <View style={styles.header}>
        <View style={styles.typeContainer}>
          <Ionicons
            name={getTransactionIcon(transaction.type)}
            size={20}
            color={theme.colors.primary}
            style={styles.typeIcon}
          />
          <Text style={styles.typeLabel}>
            {getTransactionLabel(transaction.type)}
          </Text>
        </View>
      </View>

      <View style={styles.details}>
        <View style={styles.detailRow}>
          <View style={styles.detailLabel}>
            <Ionicons
              name="arrow-up"
              size={16}
              color={theme.colors.textMuted}
            />
            <Text style={styles.labelText}>From</Text>
          </View>
          <Text style={styles.detailValue}>
            {truncateAddress(transaction.from)}
          </Text>
        </View>

        <View style={styles.detailRow}>
          <View style={styles.detailLabel}>
            <Ionicons
              name="arrow-down"
              size={16}
              color={theme.colors.textMuted}
            />
            <Text style={styles.labelText}>To</Text>
          </View>
          <Text style={styles.detailValue}>
            {truncateAddress(transaction.to)}
          </Text>
        </View>

        {transaction.amount !== undefined && transaction.amount > 0 && (
          <View style={styles.detailRow}>
            <View style={styles.detailLabel}>
              <Ionicons name="cash" size={16} color={theme.colors.textMuted} />
              <Text style={styles.labelText}>Amount</Text>
            </View>
            <Text style={[styles.detailValue, styles.amountValue]}>
              {formatAmount(transaction.amount, transaction.assetId)}
            </Text>
          </View>
        )}

        <View style={styles.detailRow}>
          <View style={styles.detailLabel}>
            <Ionicons name="card" size={16} color={theme.colors.textMuted} />
            <Text style={styles.labelText}>Fee</Text>
          </View>
          <Text style={styles.detailValue}>
            {formatAmount(transaction.fee)}
          </Text>
        </View>

        {transaction.note && (
          <View style={styles.detailRow}>
            <View style={styles.detailLabel}>
              <Ionicons
                name="document-text"
                size={16}
                color={theme.colors.textMuted}
              />
              <Text style={styles.labelText}>Note</Text>
            </View>
            <Text
              style={[styles.detailValue, styles.noteValue]}
              numberOfLines={2}
            >
              {transaction.note}
            </Text>
          </View>
        )}

        {transaction.assetId && (
          <View style={styles.detailRow}>
            <View style={styles.detailLabel}>
              <Ionicons
                name="diamond"
                size={16}
                color={theme.colors.textMuted}
              />
              <Text style={styles.labelText}>Asset ID</Text>
            </View>
            <Text style={styles.detailValue}>{transaction.assetId}</Text>
          </View>
        )}
      </View>

      {showDivider && <View style={styles.divider} />}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      paddingVertical: 16,
    },
    transactionIndex: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 12,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    typeContainer: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    typeIcon: {
      marginRight: 8,
    },
    typeLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    details: {
      gap: 8,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      minHeight: 24,
    },
    detailLabel: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    labelText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginLeft: 6,
    },
    detailValue: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      textAlign: 'right',
      flex: 1,
    },
    amountValue: {
      fontWeight: '600',
      color: theme.colors.primary,
    },
    noteValue: {
      fontSize: 12,
      fontWeight: '400',
      lineHeight: 16,
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.border,
      marginTop: 16,
    },
  });
