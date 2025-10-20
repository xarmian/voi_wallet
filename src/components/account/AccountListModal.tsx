import React, { useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useThemedStyles,
  useThemeColors,
  useThemeSpacing,
} from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
} from '@gorhom/bottom-sheet';
import { BottomSheetDefaultBackdropProps } from '@gorhom/bottom-sheet/lib/typescript/components/bottomSheetBackdrop/types';
import {
  useAccounts,
  useActiveAccount,
  useWalletStore,
} from '@/store/walletStore';
import {
  useCurrentNetwork,
  useCurrentNetworkConfig,
  useNetworkStore,
  useAvailableNetworks,
  useIsNetworkSwitching,
} from '@/store/networkStore';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { AccountMetadata } from '@/types/wallet';
import AccountListItem from './AccountListItem';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface AccountListModalProps {
  isVisible: boolean;
  onClose: () => void;
  onAddAccount: () => void;
  onEditAccount?: (accountId: string) => void;
  onAccountSelect?: (accountId: string) => void;
}

export default function AccountListModal({
  isVisible,
  onClose,
  onAddAccount,
  onEditAccount,
  onAccountSelect,
}: AccountListModalProps) {
  const bottomSheetRef = useRef<BottomSheet>(null);
  const accounts = useAccounts();
  const activeAccount = useActiveAccount();
  const deleteAccount = useWalletStore((state) => state.deleteAccount);
  const refreshAllBalances = useWalletStore(
    (state) => state.refreshAllBalances
  );

  // Network state
  const currentNetwork = useCurrentNetwork();
  const currentNetworkConfig = useCurrentNetworkConfig();
  const availableNetworks = useAvailableNetworks();
  const isNetworkSwitching = useIsNetworkSwitching();
  const { switchNetwork } = useNetworkStore();

  const [searchQuery, setSearchQuery] = React.useState('');
  const insets = useSafeAreaInsets();
  const spacing = useThemeSpacing();

  // Snap points for the bottom sheet
  const snapPoints = useMemo(() => ['85%'], []);

  // Filter accounts based on search query
  const filteredAccounts = useMemo(() => {
    if (!searchQuery.trim()) return accounts;

    return accounts.filter(
      (account) =>
        account.label?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        account.address.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [accounts, searchQuery]);

  // Handle sheet changes
  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        onClose();
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
      />
    ),
    []
  );

  // Handle account selection
  const handleAccountSelect = useCallback(
    (accountId: string) => {
      onClose();
      if (onAccountSelect) {
        onAccountSelect(accountId);
      }
    },
    [onClose, onAccountSelect]
  );

  // Handle account deletion
  const handleDeleteAccount = useCallback(
    async (accountId: string) => {
      try {
        await deleteAccount(accountId);
        Alert.alert('Success', 'Account deleted successfully');
      } catch (error) {
        console.error('Failed to delete account:', error);
        Alert.alert('Error', 'Failed to delete account');
      }
    },
    [deleteAccount]
  );

  // Handle network switch
  const handleNetworkSwitch = useCallback(
    async (networkId: NetworkId) => {
      if (networkId === currentNetwork || isNetworkSwitching) {
        return;
      }

      try {
        await switchNetwork(networkId);
        // Refresh all balances after network switch since balances will be different
        await refreshAllBalances();
        // Note: Don't close modal here - let user continue account selection
      } catch (error) {
        console.error('Failed to switch network:', error);
        Alert.alert(
          'Network Switch Failed',
          error instanceof Error ? error.message : 'Failed to switch network'
        );
      }
    },
    [currentNetwork, isNetworkSwitching, switchNetwork, refreshAllBalances]
  );

  // Render account item
  const renderAccountItem = useCallback(
    ({ item }: { item: AccountMetadata }) => (
      <AccountListItem
        account={item}
        isActive={item.id === activeAccount?.id}
        // Don't pass balance prop - let AccountListItem use store balance
        onSelect={handleAccountSelect}
        onEdit={onEditAccount}
        onDelete={handleDeleteAccount}
        shouldLoadBalance={isVisible}
      />
    ),
    [
      activeAccount?.id,
      handleAccountSelect,
      onEditAccount,
      handleDeleteAccount,
      isVisible,
    ]
  );

  // Open/close the bottom sheet based on visibility
  React.useEffect(() => {
    if (isVisible) {
      bottomSheetRef.current?.expand();
      // Batch load all account balances when modal opens (single state update)
      refreshAllBalances();
    } else {
      bottomSheetRef.current?.close();
    }
  }, [isVisible, refreshAllBalances]);

  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();
  const showSearchBar = accounts.length > 5;
  const topInset = insets.top + spacing.sm;
  const footerPaddingBottom = spacing.lg + insets.bottom;

  const listHeaderComponent = useMemo(
    () => (
      <View style={styles.listHeader}>
        <View style={styles.header}>
          <View style={styles.headerTitleRow}>
            <Text style={styles.title}>Select Account</Text>
            <TouchableOpacity
              style={styles.compactAddButton}
              onPress={onAddAccount}
              accessibilityLabel="Add account"
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              <Ionicons
                name="add"
                size={18}
                color={colors.buttonText}
                style={styles.compactAddIcon}
              />
              <Text style={styles.compactAddText}>Add</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.networkSection}>
          <Text style={styles.networkSectionTitle}>Network</Text>
          <View style={styles.networkSelector}>
            {availableNetworks.map((networkId) => {
              const networkConfig = getNetworkConfig(networkId);
              const isSelected = networkId === currentNetwork;

              return (
                <TouchableOpacity
                  key={networkId}
                  style={[
                    styles.networkButton,
                    isSelected && styles.networkButtonSelected,
                  ]}
                  onPress={() => handleNetworkSwitch(networkId)}
                  disabled={isNetworkSwitching}
                >
                  <View
                    style={[
                      styles.networkDot,
                      { backgroundColor: networkConfig.color },
                    ]}
                  />
                  <Text
                    style={[
                      styles.networkButtonText,
                      isSelected && styles.networkButtonTextSelected,
                    ]}
                  >
                    {networkConfig.name}
                  </Text>
                  {isSelected && (
                    <Ionicons
                      name="checkmark"
                      size={16}
                      color={colors.primary}
                    />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
          {isNetworkSwitching && (
            <View style={styles.switchingIndicator}>
              <Text style={styles.switchingText}>Switching network...</Text>
            </View>
          )}
        </View>

        {showSearchBar ? (
          <View style={styles.searchContainer}>
            <Ionicons
              name="search"
              size={20}
              color={colors.textMuted}
              style={styles.searchIcon}
            />
            <TextInput
              style={styles.searchInput}
              placeholder="Search accounts..."
              placeholderTextColor={colors.placeholder}
              value={searchQuery}
              onChangeText={setSearchQuery}
              clearButtonMode="while-editing"
            />
          </View>
        ) : null}
      </View>
    ),
    [
      availableNetworks,
      colors,
      currentNetwork,
      handleNetworkSwitch,
      isNetworkSwitching,
      onAddAccount,
      onClose,
      searchQuery,
      showSearchBar,
      styles,
    ]
  );

  const renderEmptyComponent = useCallback(
    () => (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>
          {searchQuery ? 'No accounts found' : 'No accounts available'}
        </Text>
      </View>
    ),
    [searchQuery, styles]
  );

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      backdropComponent={renderBackdrop}
      enablePanDownToClose
      handleIndicatorStyle={styles.indicator}
      backgroundStyle={styles.bottomSheetBackground}
      topInset={topInset}
    >
      <BottomSheetFlatList
        data={filteredAccounts}
        keyExtractor={(item) => item.id}
        renderItem={renderAccountItem}
        showsVerticalScrollIndicator={false}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListHeaderComponent={listHeaderComponent}
        ListEmptyComponent={renderEmptyComponent}
        contentContainerStyle={[
          styles.listContent,
          { paddingBottom: footerPaddingBottom },
        ]}
        keyboardShouldPersistTaps="handled"
        stickyHeaderIndices={[0]}
        style={styles.list}
      />
    </BottomSheet>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    bottomSheetBackground: {
      backgroundColor: theme.colors.modalBackground,
      borderTopLeftRadius: theme.borderRadius.xl + 4,
      borderTopRightRadius: theme.borderRadius.xl + 4,
    },
    indicator: {
      backgroundColor: theme.colors.borderLight,
      width: 32,
      height: 4,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    closeButton: {
      padding: theme.spacing.xs,
    },
    headerTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.inputBackground,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.sm + 4,
      height: 44,
      borderWidth: 1,
      borderColor: theme.colors.inputBorder,
      marginHorizontal: theme.spacing.lg,
      marginTop: theme.spacing.sm + 4,
      marginBottom: theme.spacing.sm,
    },
    searchIcon: {
      marginRight: theme.spacing.sm,
    },
    searchInput: {
      flex: 1,
      fontSize: 16,
      color: theme.colors.text,
    },
    listHeader: {
      backgroundColor: theme.colors.modalBackground,
    },
    list: {
      flex: 1,
    },
    listContent: {
      flexGrow: 1,
    },
    separator: {
      height: 1,
      backgroundColor: theme.colors.borderLight,
      marginHorizontal: theme.spacing.md,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 40,
    },
    emptyText: {
      fontSize: 16,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    compactAddButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.buttonBackground,
      borderRadius: theme.borderRadius.md,
      paddingVertical: Math.max(6, theme.spacing.xs),
      paddingHorizontal: theme.spacing.md,
      marginLeft: theme.spacing.lg,
    },
    compactAddIcon: {
      marginRight: theme.spacing.xs,
    },
    compactAddText: {
      color: theme.colors.buttonText,
      fontSize: 14,
      fontWeight: '600',
    },
    networkSection: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    networkSectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textMuted,
      marginBottom: theme.spacing.sm + 4,
    },
    networkSelector: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    networkButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.sm + 4,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.borderRadius.sm + 4,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
      gap: 6,
    },
    networkButtonSelected: {
      backgroundColor: theme.mode === 'light' ? '#F0F8FF' : '#1A365D',
      borderColor: theme.colors.primary,
    },
    networkDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    networkButtonText: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.textMuted,
    },
    networkButtonTextSelected: {
      color: theme.colors.primary,
    },
    switchingIndicator: {
      marginTop: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    switchingText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      textAlign: 'center',
      fontStyle: 'italic',
    },
  });
