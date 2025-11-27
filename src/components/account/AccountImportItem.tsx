import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ScannedAccount } from '@/utils/accountQRParser';
import AccountAvatar from '@/components/account/AccountAvatar';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { useTheme } from '@/contexts/ThemeContext';
import { Theme } from '@/constants/themes';

interface AccountImportItemProps {
  account: ScannedAccount;
  isSelected: boolean;
  onToggleSelection: (accountId: string) => void;
  onNameChange: (accountId: string, name: string) => void;
}

export default function AccountImportItem({
  account,
  isSelected,
  onToggleSelection,
  onNameChange,
}: AccountImportItemProps) {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const [name, setName] = useState(account.name || '');

  const handleNameChange = (newName: string) => {
    setName(newName);
    onNameChange(account.id, newName);
  };

  const formatAddress = (address: string) => {
    if (!address) return 'Invalid Address';
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const getStatusColor = () => {
    if (!account.isValid) return styles.errorColor;
    if (account.isDuplicate) return styles.warningColor;
    if (account.isUpgrade) return styles.infoColor;
    return styles.successColor;
  };

  const getStatusIcon = () => {
    if (!account.isValid) return 'close-circle';
    if (account.isDuplicate) return 'warning';
    if (account.isUpgrade) return 'arrow-up-circle';
    return 'checkmark-circle';
  };

  const getStatusText = () => {
    if (!account.isValid) return account.errorMessage || 'Invalid';
    if (account.isDuplicate) return 'Already exists';
    if (account.isUpgrade) return 'Upgrade watch account';
    return 'Ready to import';
  };

  const getTypeIcon = () => {
    return account.type === 'standard' ? 'key' : 'eye';
  };

  const getTypeText = () => {
    return account.type === 'standard' ? 'Full Account' : 'Watch Account';
  };

  const canBeSelected = account.isValid && (!account.isDuplicate || account.isUpgrade);

  return (
    <View
      style={[styles.container, !canBeSelected && styles.disabledContainer]}
    >
      {/* Main content row */}
      <View style={styles.mainRow}>
        {/* Avatar and basic info */}
        <View style={styles.accountInfo}>
          <AccountAvatar
            address={account.address}
            size={48}
            style={!canBeSelected ? styles.disabledAvatar : undefined}
          />
          <View style={styles.accountDetails}>
            <View style={styles.addressRow}>
              <Text
                style={[styles.address, !canBeSelected && styles.disabledText]}
              >
                {formatAddress(account.address)}
              </Text>
              <View
                style={[
                  styles.typeBadge,
                  {
                    backgroundColor:
                      account.type === 'standard' ? '#EBF4FF' : '#F0FDF4',
                  },
                ]}
              >
                <Ionicons
                  name={getTypeIcon()}
                  size={12}
                  color={account.type === 'standard' ? '#3B82F6' : '#10B981'}
                />
                <Text
                  style={[
                    styles.typeText,
                    {
                      color:
                        account.type === 'standard' ? '#3B82F6' : '#10B981',
                    },
                  ]}
                >
                  {getTypeText()}
                </Text>
              </View>
            </View>

            {/* Status row */}
            <View style={styles.statusRow}>
              <Ionicons
                name={getStatusIcon()}
                size={14}
                color={getStatusColor()}
              />
              <Text style={[styles.statusText, { color: getStatusColor() }]}>
                {getStatusText()}
              </Text>
            </View>
          </View>
        </View>

        {/* Selection toggle */}
        <Switch
          value={isSelected}
          onValueChange={() => onToggleSelection(account.id)}
          disabled={!canBeSelected}
          trackColor={{
            false: theme.colors.border,
            true: canBeSelected
              ? `${theme.colors.primary}80`
              : theme.colors.border,
          }}
          thumbColor={
            isSelected && canBeSelected
              ? theme.colors.primary
              : theme.colors.surface
          }
        />
      </View>

      {/* Name input (only show if selected and valid) */}
      {isSelected && canBeSelected && (
        <View style={styles.nameInputContainer}>
          <Text style={styles.nameLabel}>Account Name:</Text>
          <TextInput
            style={styles.nameInput}
            value={name}
            onChangeText={handleNameChange}
            placeholder="Enter account name"
            placeholderTextColor={styles.placeholderColor}
            maxLength={50}
          />
        </View>
      )}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    disabledContainer: {
      backgroundColor: theme.colors.surface,
      opacity: 0.7,
    },
    mainRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    accountInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      marginRight: theme.spacing.md,
    },
    disabledAvatar: {
      opacity: 0.5,
    },
    accountDetails: {
      marginLeft: theme.spacing.lg,
      flex: 1,
    },
    addressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 6,
    },
    address: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      fontFamily: 'monospace',
      marginRight: theme.spacing.sm,
    },
    disabledText: {
      color: theme.colors.textMuted,
    },
    typeBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
      borderRadius: theme.borderRadius.lg,
    },
    typeText: {
      fontSize: 11,
      fontWeight: '600',
      marginLeft: theme.spacing.xs,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    statusText: {
      fontSize: 13,
      marginLeft: theme.spacing.xs,
      fontWeight: '500',
    },
    nameInputContainer: {
      marginTop: theme.spacing.md,
      paddingTop: theme.spacing.md,
      borderTopWidth: 1,
      borderTopColor: theme.colors.borderLight,
    },
    nameLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.sm,
    },
    nameInput: {
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      borderRadius: theme.borderRadius.md,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 10,
      fontSize: 16,
      color: theme.colors.text,
      backgroundColor: theme.colors.inputBackground,
    },
    placeholderColor: theme.colors.placeholder,
    errorColor: theme.colors.error,
    warningColor: theme.colors.warning,
    successColor: theme.colors.success,
    infoColor: theme.colors.info,
  });
