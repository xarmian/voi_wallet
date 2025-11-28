import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useActiveAccount,
  useAccounts,
  useActiveAccountBalance,
} from '@/store/walletStore';
import { useCurrentNetworkConfig } from '@/store/networkStore';
import AccountAvatar from './AccountAvatar';
import {
  formatVoiBalance,
  formatNativeBalance,
  getCurrencySymbol,
} from '@/utils/bigint';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

// Constants for address formatting
const ADDRESS_PREFIX_LENGTH = 6;
const ADDRESS_SUFFIX_LENGTH = 4;

interface AccountSelectorProps {
  onPress: () => void;
  showBalance?: boolean;
  balance?: string | number | bigint;
  compact?: boolean;
}

export default function AccountSelector({
  onPress,
  showBalance = false,
  balance,
  compact = false,
}: AccountSelectorProps) {
  const styles = useThemedStyles(createStyles);
  const activeAccount = useActiveAccount();
  const allAccounts = useAccounts();
  const { balance: centralizedBalance, isLoading: isBalanceLoading } =
    useActiveAccountBalance();
  const currentNetworkConfig = useCurrentNetworkConfig();

  // Use provided balance, or fall back to centralized balance if showBalance is true
  const displayBalance =
    balance !== undefined
      ? balance
      : showBalance
        ? centralizedBalance?.amount
        : undefined;

  if (!activeAccount) {
    return (
      <TouchableOpacity style={styles.container} onPress={onPress}>
        <View style={styles.content}>
          <Text style={styles.noAccountText}>No Account</Text>
          <Ionicons name="chevron-down" size={20} color={styles.chevronColor} />
        </View>
      </TouchableOpacity>
    );
  }

  const formatAddress = (address: string) => {
    return `${address.slice(0, ADDRESS_PREFIX_LENGTH)}...${address.slice(-ADDRESS_SUFFIX_LENGTH)}`;
  };

  const formatBalance = (amount: string | number | bigint) => {
    if (typeof amount === 'string') {
      return amount;
    }
    return formatVoiBalance(amount);
  };

  const hasMultipleAccounts = allAccounts.length > 1;

  return (
    <TouchableOpacity
      style={[
        styles.container,
        compact ? styles.compactContainer : { flex: 1 },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
      accessible={true}
      accessibilityRole="button"
      accessibilityLabel={`Account selector. Current account: ${activeAccount.label || 'Account 1'}`}
      accessibilityHint="Tap to switch accounts"
    >
      <View style={styles.content}>
        <AccountAvatar
          address={activeAccount.address}
          size={compact ? 24 : 28}
          showActiveIndicator={false}
          account={activeAccount}
          showRekeyIndicator={true}
        />

        <View
          style={[styles.accountInfo, compact && styles.compactAccountInfo]}
        >
          <Text
            style={[styles.accountName, compact && styles.compactAccountName]}
            numberOfLines={1}
          >
            {activeAccount.label || 'Account 1'}
          </Text>
          <Text
            style={[
              styles.accountAddress,
              compact && styles.compactAccountAddress,
            ]}
            numberOfLines={1}
          >
            {formatAddress(activeAccount.address)}
          </Text>
          {showBalance && displayBalance !== undefined && !compact && (
            <Text style={styles.balance} numberOfLines={1}>
              {isBalanceLoading
                ? 'Loading...'
                : `${formatBalance(displayBalance)} ${getCurrencySymbol(currentNetworkConfig.currency)}`}
            </Text>
          )}
        </View>

        <Ionicons
          name="chevron-down"
          size={compact ? 14 : 16}
          color={styles.chevronColor}
        />
      </View>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      backgroundColor: 'transparent',
      borderRadius: theme.borderRadius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      minHeight: 44,
      justifyContent: 'center',
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    accountInfo: {
      flex: 1,
      marginLeft: theme.spacing.md,
      marginRight: theme.spacing.sm,
    },
    accountName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    accountAddress: {
      fontSize: 12,
      fontFamily: 'monospace',
      color: theme.colors.textSecondary,
    },
    balance: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.primary,
      marginTop: 2,
    },
    noAccountText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    compactContainer: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      minHeight: 36,
    },
    compactAccountInfo: {
      marginLeft: theme.spacing.sm,
      marginRight: theme.spacing.xs,
    },
    compactAccountName: {
      fontSize: 14,
      fontWeight: '500',
    },
    compactAccountAddress: {
      fontSize: 11,
    },
    chevronColor: theme.colors.textSecondary,
  });
