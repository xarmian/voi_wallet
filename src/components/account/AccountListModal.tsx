import React, { useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  useThemedStyles,
  useThemeColors,
  useThemeSpacing,
} from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  BottomSheetModal,
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
  const bottomSheetRef = useRef<BottomSheetModal>(null);
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
      bottomSheetRef.current?.present();
      // Batch load all account balances when modal opens (single state update)
      refreshAllBalances();
    } else {
      bottomSheetRef.current?.dismiss();
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
    <BottomSheetModal
      ref={bottomSheetRef}
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
    </BottomSheetModal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    bottomSheetBackground: {
      backgroundColor: theme.colors.modalBackground,
      borderTopLeftRadius: theme.borderRadius.xxl,
      borderTopRightRadius: theme.borderRadius.xxl,
      borderTopWidth: 1,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      borderColor: theme.colors.glassBorder,
    },
    indicator: {
      backgroundColor: theme.colors.textMuted,
      width: 36,
      height: 4,
      borderRadius: 2,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.glassBorder,
    },
    title: {
      fontSize: theme.typography.heading3.fontSize,
      fontWeight: '600',
      color: theme.colors.text,
    },
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.glass.light.backgroundColor,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.glass.light.backgroundColor,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.md,
      height: 48,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
      marginHorizontal: theme.spacing.lg,
      marginTop: theme.spacing.md,
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
      paddingHorizontal: theme.spacing.sm,
    },
    separator: {
      height: 1,
      backgroundColor: theme.colors.glassBorder,
      marginHorizontal: theme.spacing.md,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: theme.spacing.xxl,
    },
    emptyText: {
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    compactAddButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.pill,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    compactAddIcon: {
      // No extra margin needed with gap
    },
    compactAddText: {
      color: '#FFFFFF',
      fontSize: 14,
      fontWeight: '600',
    },
    networkSection: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.glassBorder,
    },
    networkSectionTitle: {
      fontSize: theme.typography.caption.fontSize,
      fontWeight: '600',
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: theme.spacing.sm,
    },
    networkSelector: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    networkButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm + 2,
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
      backgroundColor: theme.glass.light.backgroundColor,
      gap: theme.spacing.xs,
    },
    networkButtonSelected: {
      backgroundColor: `${theme.colors.primary}15`,
      borderColor: theme.colors.primary,
    },
    networkDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    networkButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textSecondary,
    },
    networkButtonTextSelected: {
      color: theme.colors.primary,
    },
    switchingIndicator: {
      marginTop: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    switchingText: {
      fontSize: theme.typography.caption.fontSize,
      color: theme.colors.textMuted,
      textAlign: 'center',
      fontStyle: 'italic',
    },
  });
