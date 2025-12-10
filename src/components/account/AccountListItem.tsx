import React, { useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import * as Clipboard from 'expo-clipboard';
import {
  AccountMetadata,
  AccountType,
  RekeyedAccountMetadata,
} from '@/types/wallet';
import {
  useWalletStore,
  useAccountBalance,
  useAccountEnvoiName,
} from '@/store/walletStore';
import AccountAvatar from './AccountAvatar';
import { formatNativeBalance } from '@/utils/bigint';
import { formatAddressSync } from '@/utils/address';
import { useCurrentNetworkConfig } from '@/store/networkStore';

interface AccountListItemProps {
  account: AccountMetadata;
  isActive: boolean;
  balance?: string | number | bigint;
  onSelect: (accountId: string) => void;
  onEdit?: (accountId: string) => void;
  onDelete?: (accountId: string) => void;
  shouldLoadBalance?: boolean;
}

export default function AccountListItem({
  account,
  isActive,
  balance,
  onSelect,
  onEdit,
  onDelete,
  shouldLoadBalance = true,
}: AccountListItemProps) {
  const setActiveAccount = useWalletStore((state) => state.setActiveAccount);
  const walletAccounts = useWalletStore((state) => state.wallet?.accounts);
  const accountBalanceData = useAccountBalance(account.id);
  const currentNetworkConfig = useCurrentNetworkConfig();

  // Extract values without destructuring to avoid infinite loops
  const centralizedBalance = accountBalanceData.balance;
  const isBalanceLoading = accountBalanceData.isLoading;
  const reloadAccountBalance = accountBalanceData.reload;

  // Don't load individual balances - the modal will batch load all balances
  // This prevents each item from triggering separate state updates

  // Use provided balance, or fall back to centralized balance
  const displayBalance =
    balance !== undefined ? balance : centralizedBalance?.amount;

  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const formatBalance = (amount: string | number | bigint | undefined) => {
    if (amount === undefined) return null; // Only return null if undefined (not loaded)
    if (typeof amount === 'string') return amount;
    return formatNativeBalance(amount, currentNetworkConfig.nativeToken);
  };

  const getAccountTypeLabel = (account: AccountMetadata) => {
    switch (account.type) {
      case AccountType.STANDARD:
        return '';
      case AccountType.WATCH:
        return 'Watch Only';
      case AccountType.LEDGER:
        return 'Ledger';
      case AccountType.REMOTE_SIGNER:
        return 'Remote';
      case AccountType.REKEYED:
        const rekeyedAccount = account as RekeyedAccountMetadata;
        const hasLedgerSigner =
          walletAccounts?.some(
            (candidate) =>
              candidate.type === AccountType.LEDGER &&
              candidate.address === rekeyedAccount.authAddress
          ) ?? false;

        if (hasLedgerSigner) {
          return 'Ledger';
        }

        // Check if rekeyed to a remote signer account
        const hasRemoteSignerAuth =
          walletAccounts?.some(
            (candidate) =>
              candidate.type === AccountType.REMOTE_SIGNER &&
              candidate.address === rekeyedAccount.authAddress
          ) ?? false;

        if (hasRemoteSignerAuth) {
          return 'Remote';
        }

        if (rekeyedAccount.canSign) {
          return 'Rekeyed';
        }

        return 'Rekeyed (No Key)';
      default:
        return '';
    }
  };

  const getRekeyStatusIcon = (account: AccountMetadata) => {
    if (account.type !== AccountType.REKEYED) {
      return null;
    }

    const rekeyedAccount = account as RekeyedAccountMetadata;
    if (rekeyedAccount.canSign) {
      return {
        name: 'key' as const,
        color: '#10B981', // Green - we can sign
        tooltip: 'Rekeyed account - you have signing authority',
      };
    } else {
      return {
        name: 'lock-closed' as const,
        color: '#F59E0B', // Amber - we cannot sign
        tooltip: 'Rekeyed account - you do not have signing authority',
      };
    }
  };

  const handleSelect = async () => {
    try {
      if (!isActive) {
        await setActiveAccount(account.id);
      }
      onSelect(account.id);
    } catch (error) {
      console.error('Failed to switch account:', error);
      Alert.alert('Error', 'Failed to switch account');
    }
  };

  const handleCopyAddress = async () => {
    try {
      await Clipboard.setStringAsync(account.address);
      Alert.alert('Copied', 'Address copied to clipboard');
    } catch (error) {
      console.error('Failed to copy address:', error);
      Alert.alert('Error', 'Failed to copy address');
    }
  };

  const handleEdit = () => {
    if (onEdit) {
      onEdit(account.id);
    }
  };

  const handleDelete = () => {
    if (onDelete && account.type !== AccountType.STANDARD) {
      Alert.alert(
        'Delete Account',
        `Are you sure you want to delete "${account.label || 'this account'}"?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => onDelete(account.id),
          },
        ]
      );
    }
  };

  const typeLabel = getAccountTypeLabel(account);
  const rekeyIcon = getRekeyStatusIcon(account);
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  return (
    <TouchableOpacity
      style={[styles.container, isActive && styles.activeContainer]}
      onPress={handleSelect}
      activeOpacity={0.7}
    >
      <View style={styles.content}>
        <AccountAvatar
          address={account.address}
          size={40}
          showActiveIndicator={isActive}
          account={account}
          showRekeyIndicator={true}
        />

        <View style={styles.accountInfo}>
          <View style={styles.nameRow}>
            <Text
              style={[styles.accountName, isActive && styles.activeText]}
              numberOfLines={1}
            >
              {account.label || 'Account'}
            </Text>
            {typeLabel && <Text style={styles.typeLabel}>{typeLabel}</Text>}
          </View>
          <Text
            style={[
              styles.accountAddress,
              isActive && styles.activeAddressText,
            ]}
            numberOfLines={1}
          >
            {formatAddress(account.address)}
          </Text>
        </View>

        <View style={styles.balanceContainer}>
          <Text style={[styles.balance, isActive && styles.activeText]}>
            {isBalanceLoading || formatBalance(displayBalance) === null
              ? 'Loading...'
              : `${formatBalance(displayBalance)} ${currentNetworkConfig.nativeToken}`}
          </Text>

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleCopyAddress}
            >
              <Ionicons
                name="copy-outline"
                size={16}
                color={colors.textMuted}
              />
            </TouchableOpacity>

            {onEdit && (
              <TouchableOpacity
                style={styles.actionButton}
                onPress={handleEdit}
              >
                <Ionicons
                  name="pencil-outline"
                  size={16}
                  color={colors.textMuted}
                />
              </TouchableOpacity>
            )}

            {onDelete && account.type !== AccountType.STANDARD && (
              <TouchableOpacity
                style={styles.actionButton}
                onPress={handleDelete}
              >
                <Ionicons name="trash-outline" size={16} color={colors.error} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm + 4,
      borderRadius: theme.borderRadius.lg,
      marginHorizontal: theme.spacing.md,
      marginVertical: theme.spacing.xs,
    },
    activeContainer: {
      backgroundColor:
        theme.mode === 'light'
          ? 'rgba(59, 130, 246, 0.1)'
          : 'rgba(10, 132, 255, 0.15)',
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.primary,
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    accountInfo: {
      flex: 1,
      marginLeft: theme.spacing.sm + 4,
      marginRight: theme.spacing.sm,
    },
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: theme.spacing.xs,
    },
    accountName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      flex: 1,
    },
    activeText: {
      fontWeight: '600',
      color: theme.colors.primaryDark,
    },
    typeLabel: {
      fontSize: 11,
      fontWeight: '500',
      color: theme.colors.textMuted,
      backgroundColor: theme.colors.surface,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: theme.borderRadius.xs,
      marginLeft: theme.spacing.sm,
    },
    rekeyIconContainer: {
      marginLeft: 6,
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 2,
    },
    rekeyIcon: {
      opacity: 0.8,
    },
    accountAddress: {
      fontSize: 12,
      fontFamily: 'monospace',
      color: theme.colors.textMuted,
    },
    activeAddressText: {
      color: theme.colors.primary,
    },
    balanceContainer: {
      alignItems: 'flex-end',
    },
    balance: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.success,
      marginBottom: theme.spacing.xs,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    actionButton: {
      padding: theme.spacing.xs,
      marginLeft: theme.spacing.xs,
    },
    envoiName: {
      fontSize: 13,
      fontWeight: '500',
      color: theme.colors.primary,
      marginBottom: 2,
    },
    activeEnvoiName: {
      color: theme.colors.primaryDark,
    },
  });
