import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { NetworkAuthAccount } from '@/types/wallet';
import { Theme } from '@/constants/themes';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import NetworkBadge from '@/components/NetworkBadge';

interface AuthAccountListProps {
  accounts: NetworkAuthAccount[];
  selectedAddresses: Set<string>;
  onToggleSelect: (account: NetworkAuthAccount) => void;
  onPreviewAccount?: (account: NetworkAuthAccount) => void;
  isLoading?: boolean;
  emptyMessage?: string;
}

const AuthAccountList: React.FC<AuthAccountListProps> = ({
  accounts,
  selectedAddresses,
  onToggleSelect,
  onPreviewAccount,
  isLoading = false,
  emptyMessage = 'No auth accounts found for the selected Ledger accounts.',
}) => {
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const formatBalance = (balance?: number | bigint) => {
    if (balance === undefined) return 'N/A';
    const balanceNum = typeof balance === 'bigint' ? Number(balance) : balance;
    const normalizedBalance = balanceNum / 1000000; // Convert microunits to base units
    if (normalizedBalance < 0.001) return '< 0.001';
    return normalizedBalance.toFixed(3);
  };

  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  if (!isLoading && accounts.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Ionicons
          name="search-outline"
          size={48}
          color={colors.textMuted}
          style={styles.emptyIcon}
        />
        <Text style={styles.emptyTitle}>No Rekeyed Accounts Found</Text>
        <Text style={styles.emptyDescription}>{emptyMessage}</Text>
      </View>
    );
  }

  const renderAccountItem = ({ item }: { item: NetworkAuthAccount }) => {
    const isSelected = selectedAddresses.has(item.address);

    return (
      <TouchableOpacity
        style={[
          styles.accountRow,
          isSelected && styles.accountRowSelected,
        ]}
        onPress={() => onPreviewAccount?.(item)}
        activeOpacity={0.8}
      >
        <View style={styles.accountRowLeft}>
          <TouchableOpacity
            style={[
              styles.checkbox,
              isSelected && styles.checkboxChecked,
            ]}
            onPress={(e) => {
              e.stopPropagation(); // Prevent row tap
              onToggleSelect(item);
            }}
          >
            {isSelected ? (
              <Ionicons name="checkmark" size={14} color={colors.buttonText} />
            ) : null}
          </TouchableOpacity>

          <View style={styles.accountInfo}>
            <View style={styles.accountHeader}>
              <Text style={styles.accountAddress}>
                {formatAddress(item.address)}
              </Text>
              <NetworkBadge networkId={item.networkId} size="small" />
            </View>

            <View style={styles.accountDetails}>
              <Text style={styles.accountBalance}>
                {formatBalance(item.balance)} {item.networkName === 'Voi Network' ? 'VOI' : 'ALGO'}
              </Text>
              {item.assetCount !== undefined && item.assetCount > 0 && (
                <Text style={styles.assetCount}>
                  • {item.assetCount} asset{item.assetCount === 1 ? '' : 's'}
                </Text>
              )}
            </View>

            <Text style={styles.authInfo}>
              Rekeyed to: {formatAddress(item.authAddress)}
            </Text>
          </View>
        </View>

        <View style={styles.accountRowRight}>
          <Ionicons
            name="chevron-forward"
            size={18}
            color={colors.textMuted}
          />
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {accounts.map((item) => (
        <View key={`${item.networkId}-${item.address}`}>
          {renderAccountItem({ item })}
          <View style={styles.separator} />
        </View>
      ))}

      {isLoading && (
        <View style={styles.listFooter}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.loadingText}>
            Searching for accounts rekeyed to your Ledger...
          </Text>
          <Text style={styles.loadingSubtext}>
            Checking both Voi and Algorand networks
          </Text>
        </View>
      )}
    </View>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    emptyContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xl,
      paddingHorizontal: theme.spacing.lg,
    },
    emptyIcon: {
      marginBottom: theme.spacing.md,
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
    accountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      minHeight: 80,
    },
    accountRowSelected: {
      borderWidth: 1,
      borderColor: theme.colors.primary,
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
    accountInfo: {
      flex: 1,
      gap: 4,
    },
    accountHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    accountAddress: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
      fontFamily: 'Menlo',
    },
    accountDetails: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    accountBalance: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      fontWeight: '500',
    },
    assetCount: {
      fontSize: 13,
      color: theme.colors.textMuted,
    },
    authInfo: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontFamily: 'Menlo',
    },
    accountRowRight: {
      marginLeft: theme.spacing.md,
      alignItems: 'center',
    },
    separator: {
      height: theme.spacing.sm,
    },
    listFooter: {
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    loadingText: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    loadingSubtext: {
      fontSize: 12,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.xs,
    },
  });

export default AuthAccountList;