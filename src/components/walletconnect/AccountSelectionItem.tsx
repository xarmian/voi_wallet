import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch } from 'react-native';
import { AccountMetadata } from '@/types/wallet';
import { truncateAddress } from '@/services/walletconnect/utils';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface AccountSelectionItemProps {
  account: AccountMetadata;
  isSelected: boolean;
  onToggleSelection: (accountId: string) => void;
}

export default function AccountSelectionItem({
  account,
  isSelected,
  onToggleSelection,
}: AccountSelectionItemProps) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  const handlePress = () => {
    onToggleSelection(account.id);
  };

  return (
    <TouchableOpacity
      style={[styles.container, isSelected && styles.selectedContainer]}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <View style={styles.accountInfo}>
        <View
          style={[styles.accountColor, { backgroundColor: account.color }]}
        />
        <View style={styles.accountDetails}>
          <Text style={styles.accountLabel}>{account.label}</Text>
          <Text style={styles.accountAddress}>
            {truncateAddress(account.address)}
          </Text>
        </View>
        <Text style={styles.accountType}>{account.type}</Text>
      </View>

      <Switch
        value={isSelected}
        onValueChange={() => onToggleSelection(account.id)}
        trackColor={{
          false: theme.colors.border,
          true: theme.colors.primary,
        }}
        thumbColor={isSelected ? theme.colors.buttonText : theme.colors.surface}
      />
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
    },
    selectedContainer: {
      backgroundColor: theme.colors.surface,
    },
    accountInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      marginRight: 16,
    },
    accountColor: {
      width: 12,
      height: 12,
      borderRadius: 6,
      marginRight: 12,
    },
    accountDetails: {
      flex: 1,
    },
    accountLabel: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 2,
    },
    accountAddress: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    accountType: {
      fontSize: 11,
      color: theme.colors.primary,
      textTransform: 'uppercase',
      marginRight: 12,
    },
  });
