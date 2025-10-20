import React, { useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { BottomSheetDefaultBackdropProps } from '@gorhom/bottom-sheet/lib/typescript/components/bottomSheetBackdrop/types';
import { useAccounts, useActiveAccount } from '@/store/walletStore';
import { AccountMetadata } from '@/types/wallet';
import AccountAvatar from './AccountAvatar';
import { formatAddress } from '@/utils/address';

interface AccountRecipientModalProps {
  isVisible: boolean;
  onClose: () => void;
  onAccountSelect: (address: string, accountLabel?: string) => void;
}

export default function AccountRecipientModal({
  isVisible,
  onClose,
  onAccountSelect,
}: AccountRecipientModalProps) {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const bottomSheetRef = useRef<BottomSheet>(null);
  const accounts = useAccounts();
  const activeAccount = useActiveAccount();

  const [searchQuery, setSearchQuery] = React.useState('');

  // Snap points for the bottom sheet
  const snapPoints = useMemo(() => ['60%'], []);

  // Filter accounts to exclude the active account and apply search
  const filteredAccounts = useMemo(() => {
    // First, exclude the active account
    const otherAccounts = accounts.filter(
      (account) => account.id !== activeAccount?.id
    );

    if (!searchQuery.trim()) return otherAccounts;

    return otherAccounts.filter(
      (account) =>
        account.label?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        account.address.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [accounts, activeAccount?.id, searchQuery]);

  // Handle sheet changes
  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        onClose();
        setSearchQuery(''); // Clear search when closing
      }
    },
    [onClose]
  );

  // Render backdrop
  const renderBackdrop = useCallback(
    (props: BottomSheetDefaultBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        onPress={onClose}
      />
    ),
    [onClose]
  );

  // Handle account selection
  const handleAccountSelect = useCallback(
    (account: AccountMetadata) => {
      onAccountSelect(account.address, account.label);
      onClose();
      setSearchQuery(''); // Clear search after selection
    },
    [onAccountSelect, onClose]
  );

  // Render account item
  const renderAccountItem = useCallback(
    ({ item }: { item: AccountMetadata }) => (
      <TouchableOpacity
        style={styles.accountItem}
        onPress={() => handleAccountSelect(item)}
        activeOpacity={0.7}
      >
        <AccountAvatar address={item.address} account={item} size={40} />
        <View style={styles.accountInfo}>
          <Text style={styles.accountLabel}>
            {item.label || `Account ${item.address.slice(0, 6)}...`}
          </Text>
          <Text style={styles.accountAddress}>
            {formatAddress(item.address)}
          </Text>
        </View>
        <Ionicons
          name="chevron-forward"
          size={20}
          color={themeColors.textSecondary}
        />
      </TouchableOpacity>
    ),
    [styles, themeColors, handleAccountSelect]
  );

  // Open/close the bottom sheet based on visibility
  React.useEffect(() => {
    if (isVisible) {
      bottomSheetRef.current?.expand();
    } else {
      bottomSheetRef.current?.close();
    }
  }, [isVisible]);

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      backdropComponent={renderBackdrop}
      enablePanDownToClose
      backgroundStyle={styles.bottomSheetBackground}
      handleIndicatorStyle={styles.bottomSheetIndicator}
    >
      <BottomSheetView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Select Recipient Account</Text>
          <TouchableOpacity
            onPress={onClose}
            style={styles.closeButton}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons
              name="close"
              size={24}
              color={themeColors.textSecondary}
            />
          </TouchableOpacity>
        </View>

        {/* Search Input */}
        <View style={styles.searchContainer}>
          <View style={styles.searchInputContainer}>
            <Ionicons
              name="search"
              size={20}
              color={themeColors.textSecondary}
              style={styles.searchIcon}
            />
            <TextInput
              style={styles.searchInput}
              placeholder="Search accounts..."
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholderTextColor={themeColors.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => setSearchQuery('')}
                style={styles.clearButton}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons
                  name="close-circle"
                  size={20}
                  color={themeColors.textSecondary}
                />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Account List */}
        {filteredAccounts.length > 0 ? (
          <FlatList
            data={filteredAccounts}
            renderItem={renderAccountItem}
            keyExtractor={(item) => item.id}
            style={styles.accountList}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.accountListContent}
          />
        ) : (
          <View style={styles.emptyState}>
            <Ionicons
              name="wallet-outline"
              size={48}
              color={themeColors.textMuted}
              style={styles.emptyIcon}
            />
            <Text style={styles.emptyTitle}>
              {searchQuery ? 'No accounts found' : 'No other accounts'}
            </Text>
            <Text style={styles.emptyMessage}>
              {searchQuery
                ? 'Try adjusting your search query.'
                : 'You only have one account in your wallet.'}
            </Text>
          </View>
        )}
      </BottomSheetView>
    </BottomSheet>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: theme.spacing.lg,
    },
    bottomSheetBackground: {
      backgroundColor: theme.colors.card,
    },
    bottomSheetIndicator: {
      backgroundColor: theme.colors.border,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      marginBottom: theme.spacing.md,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    closeButton: {
      padding: theme.spacing.xs,
    },
    searchContainer: {
      marginBottom: theme.spacing.md,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    searchIcon: {
      marginRight: theme.spacing.sm,
    },
    searchInput: {
      flex: 1,
      fontSize: 16,
      color: theme.colors.text,
      paddingVertical: 0,
    },
    clearButton: {
      marginLeft: theme.spacing.sm,
    },
    accountList: {
      flex: 1,
    },
    accountListContent: {
      paddingBottom: theme.spacing.lg,
    },
    accountItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      marginBottom: theme.spacing.xs,
      backgroundColor: theme.colors.surface,
    },
    accountInfo: {
      flex: 1,
      marginLeft: theme.spacing.md,
    },
    accountLabel: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 2,
    },
    accountAddress: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      fontFamily: 'monospace',
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
    },
    emptyIcon: {
      marginBottom: theme.spacing.md,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    emptyMessage: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
      maxWidth: 280,
    },
  });
