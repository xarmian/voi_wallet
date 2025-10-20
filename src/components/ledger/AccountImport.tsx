import React, { ReactNode } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  FlatList,
  TouchableOpacity,
  View,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { LedgerAccountDiscoveryResult } from '@/types/wallet';
import { Theme } from '@/constants/themes';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';

interface RangeControlsProps {
  startIndex: number;
  count: number;
  onChangeStart: (next: number) => void;
  onChangeCount: (next: number) => void;
  onScan: () => void;
  isScanning: boolean;
}

interface LedgerAccountListProps {
  accounts: LedgerAccountDiscoveryResult[];
  selectedIndexes: Set<number>;
  onToggleSelect: (account: LedgerAccountDiscoveryResult) => void;
  onPreviewAccount?: (account: LedgerAccountDiscoveryResult) => void;
  isScanning: boolean;
  emptyMessage?: string;
  listHeaderComponent?: ReactNode;
  listFooterComponent?: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export interface LedgerAccountImportProps {
  range: RangeControlsProps;
  list: LedgerAccountListProps;
  headerComponent?: ReactNode;
  footerComponent?: ReactNode;
}

const RangeControls: React.FC<RangeControlsProps> = ({
  startIndex,
  count,
  onChangeStart,
  onChangeCount,
  onScan,
  isScanning,
}) => {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const handleIncrement = (
    setter: (value: number) => void,
    value: number,
    delta: number
  ) => {
    const next = Math.max(0, value + delta);
    setter(next);
  };

  return (
    <View style={styles.rangeContainer}>
      <View style={styles.rangeControl}>
        <Text style={styles.rangeLabel}>Start Index</Text>
        <View style={styles.rangeButtons}>
          <TouchableOpacity
            style={styles.rangeButton}
            onPress={() => handleIncrement(onChangeStart, startIndex, -5)}
            disabled={startIndex === 0 || isScanning}
          >
            <Ionicons name="remove" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.rangeValue}>{startIndex}</Text>
          <TouchableOpacity
            style={styles.rangeButton}
            onPress={() => handleIncrement(onChangeStart, startIndex, 5)}
            disabled={isScanning}
          >
            <Ionicons name="add" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>
      <View style={styles.rangeControl}>
        <Text style={styles.rangeLabel}>Account Count</Text>
        <View style={styles.rangeButtons}>
          <TouchableOpacity
            style={styles.rangeButton}
            onPress={() => handleIncrement(onChangeCount, count, -1)}
            disabled={count <= 1 || isScanning}
          >
            <Ionicons name="remove" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
          <Text style={styles.rangeValue}>{count}</Text>
          <TouchableOpacity
            style={styles.rangeButton}
            onPress={() => handleIncrement(onChangeCount, count, 1)}
            disabled={isScanning}
          >
            <Ionicons name="add" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>
      <TouchableOpacity
        style={[styles.scanButton, isScanning && styles.scanButtonDisabled]}
        onPress={onScan}
        disabled={isScanning}
      >
        {isScanning ? (
          <ActivityIndicator size="small" color={colors.buttonText} />
        ) : (
          <Text style={styles.scanButtonText}>Scan Accounts</Text>
        )}
      </TouchableOpacity>
    </View>
  );
};

const LedgerAccountList: React.FC<LedgerAccountListProps> = ({
  accounts,
  selectedIndexes,
  onToggleSelect,
  onPreviewAccount,
  isScanning,
  emptyMessage,
  listHeaderComponent,
  listFooterComponent,
  contentContainerStyle,
}) => {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const isEmpty = !isScanning && accounts.length === 0;
  const header = listHeaderComponent ? (
    <View style={styles.listHeader}>{listHeaderComponent}</View>
  ) : null;
  const footer = listFooterComponent ? (
    <View style={styles.listFooterContainer}>{listFooterComponent}</View>
  ) : null;

  return (
    <FlatList
      data={accounts}
      keyExtractor={(item) => `${item.derivationIndex}-${item.address}`}
      extraData={selectedIndexes}
      renderItem={({ item }) => {
        const isSelected = selectedIndexes.has(item.derivationIndex);
        const isImported = item.existsInWallet;
        return (
          <TouchableOpacity
            style={[
              styles.accountRow,
              isSelected && styles.accountRowSelected,
              isImported && styles.accountRowImported,
            ]}
            onPress={() => {
              if (isImported) {
                onPreviewAccount?.(item);
                return;
              }
              onToggleSelect(item);
              onPreviewAccount?.(item);
            }}
            activeOpacity={0.8}
          >
            <View style={styles.accountRowLeft}>
              <View
                style={[
                  styles.checkbox,
                  isSelected && styles.checkboxChecked,
                  isImported && styles.checkboxDisabled,
                ]}
              >
                {isSelected && !isImported ? (
                  <Ionicons name="checkmark" size={14} color={colors.buttonText} />
                ) : null}
                {isImported ? (
                  <Ionicons
                    name="lock-closed"
                    size={14}
                    color={colors.textMuted}
                  />
                ) : null}
              </View>
              <View style={styles.accountInfo}>
                <Text style={styles.accountLabel}>
                  Account #{item.derivationIndex}
                </Text>
                <Text style={styles.accountAddress} numberOfLines={1}>
                  {item.address}
                </Text>
                <Text style={styles.accountPath}>{item.derivationPath}</Text>
              </View>
            </View>
            <View style={styles.accountRowRight}>
              {isImported ? (
                <Text style={styles.importedBadge}>Imported</Text>
              ) : (
                <Ionicons
                  name="chevron-forward"
                  size={18}
                  color={colors.textMuted}
                />
              )}
            </View>
          </TouchableOpacity>
        );
      }}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      ListHeaderComponent={header}
      ListEmptyComponent={
        isEmpty ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>No accounts detected</Text>
            <Text style={styles.emptyDescription}>
              {emptyMessage || 'Adjust the derivation range and scan again.'}
            </Text>
          </View>
        ) : null
      }
      ListFooterComponent={
        <>
          {isScanning ? (
            <View style={styles.listFooter}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : null}
          {footer}
        </>
      }
      style={styles.list}
      contentContainerStyle={[
        styles.listContent,
        isEmpty ? styles.listContentEmpty : null,
        contentContainerStyle,
      ]}
      keyboardShouldPersistTaps="handled"
    />
  );
};

export const LedgerAccountImport: React.FC<LedgerAccountImportProps> = ({
  range,
  list,
  headerComponent,
  footerComponent,
}) => {
  const styles = useThemedStyles(createStyles);

  const listHeader = (
    <View style={styles.importHeader}>
      {headerComponent}
      <RangeControls
        {...range}
      />
    </View>
  );

  return (
    <View style={styles.importContainer}>
      <LedgerAccountList
        {...list}
        emptyMessage="No Ledger accounts found in this range. Verify the device is unlocked and the Algorand app is open."
        listHeaderComponent={listHeader}
        listFooterComponent={footerComponent}
        contentContainerStyle={styles.listWrapper}
      />
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    importContainer: {
      flex: 1,
    },
    importHeader: {
      gap: theme.spacing.lg,
    },
    rangeContainer: {
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      backgroundColor: theme.colors.card,
      gap: theme.spacing.md,
    },
    rangeControl: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    rangeLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    rangeButtons: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    rangeButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
    },
    rangeValue: {
      width: 36,
      textAlign: 'center',
      fontWeight: '600',
      color: theme.colors.text,
    },
    scanButton: {
      borderRadius: theme.borderRadius.lg,
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
    },
    scanButtonDisabled: {
      opacity: 0.6,
    },
    scanButtonText: {
      color: theme.colors.buttonText,
      fontWeight: '600',
    },
    emptyContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xl,
      paddingHorizontal: theme.spacing.lg,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    emptyDescription: {
      textAlign: 'center',
      color: theme.colors.textSecondary,
      fontSize: 14,
      lineHeight: 20,
    },
    list: {
      flex: 1,
    },
    listWrapper: {
      paddingBottom: theme.spacing.xl,
      gap: theme.spacing.lg,
    },
    listHeader: {
      gap: theme.spacing.lg,
    },
    listContent: {
      flexGrow: 1,
      gap: theme.spacing.lg,
    },
    listContentEmpty: {
      flexGrow: 1,
      justifyContent: 'flex-start',
    },
    accountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
    },
    accountRowSelected: {
      borderWidth: 1,
      borderColor: theme.colors.primary,
    },
    accountRowImported: {
      opacity: 0.6,
    },
    accountRowLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
    },
    checkbox: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: theme.spacing.md,
      backgroundColor: theme.colors.card,
    },
    checkboxChecked: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    checkboxDisabled: {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.borderLight,
    },
    accountInfo: {
      flex: 1,
      gap: 2,
    },
    accountLabel: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    accountAddress: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    accountPath: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    accountRowRight: {
      marginLeft: theme.spacing.md,
    },
    importedBadge: {
      fontSize: 12,
      color: theme.colors.textSecondary,
    },
    separator: {
      height: theme.spacing.sm,
    },
    listFooter: {
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
    },
    listFooterContainer: {
      gap: theme.spacing.lg,
    },
  });

export default LedgerAccountImport;
