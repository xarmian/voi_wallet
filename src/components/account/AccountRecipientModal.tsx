import React, { useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Image,
  ListRenderItem,
} from 'react-native';
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
import { useAccounts, useActiveAccount } from '@/store/walletStore';
import { AccountMetadata } from '@/types/wallet';
import AccountAvatar from './AccountAvatar';
import { formatAddress } from '@/utils/address';
import { useSortedFriends, useFriendsStore } from '@/store/friendsStore';
import { Friend } from '@/types/social';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type TabType = 'accounts' | 'friends';

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
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const accounts = useAccounts();
  const activeAccount = useActiveAccount();
  const friends = useSortedFriends();
  const friendsStore = useFriendsStore();
  const insets = useSafeAreaInsets();
  const { lg: spacingLg } = useThemeSpacing();

  const [searchQuery, setSearchQuery] = React.useState('');
  const [activeTab, setActiveTab] = React.useState<TabType>('accounts');

  // Initialize friends store on mount
  React.useEffect(() => {
    if (!friendsStore.isInitialized) {
      friendsStore.initialize();
    }
  }, [friendsStore.isInitialized]);

  // Use percentage-based snap point for better compatibility with BottomSheetModal
  const snapPoints = useMemo(() => ['90%'], []);

  const listContentStyle = useMemo(
    () => [styles.listContent, { paddingBottom: spacingLg + insets.bottom + 100 }],
    [styles.listContent, spacingLg, insets.bottom]
  );

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

  // Filter friends by search query
  const filteredFriends = useMemo(() => {
    if (!searchQuery.trim()) return friends;

    const lowerQuery = searchQuery.toLowerCase();
    return friends.filter(
      (friend) =>
        friend.envoiName.toLowerCase().includes(lowerQuery) ||
        friend.address.toLowerCase().includes(lowerQuery) ||
        friend.bio?.toLowerCase().includes(lowerQuery) ||
        friend.notes?.toLowerCase().includes(lowerQuery)
    );
  }, [friends, searchQuery]);

  // Handle sheet changes
  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        onClose();
        setSearchQuery(''); // Clear search when closing
        setActiveTab('accounts'); // Reset to accounts tab when closing
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

  // Handle friend selection
  const handleFriendSelect = useCallback(
    (friend: Friend) => {
      onAccountSelect(friend.address, friend.envoiName);
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

  // Render friend item
  const renderFriendItem = useCallback(
    ({ item }: { item: Friend }) => (
      <TouchableOpacity
        style={styles.accountItem}
        onPress={() => handleFriendSelect(item)}
        activeOpacity={0.7}
      >
        {item.avatar ? (
          <Image
            source={{ uri: item.avatar }}
            style={styles.friendAvatar}
          />
        ) : (
          <View style={styles.friendAvatarFallback}>
            <Text style={styles.friendAvatarText}>
              {item.envoiName.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.accountInfo}>
          <View style={styles.friendNameRow}>
            <Text style={styles.accountLabel}>
              {item.envoiName}
            </Text>
            {item.isFavorite && (
              <Ionicons name="star" size={16} color={themeColors.warning} />
            )}
          </View>
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
    [styles, themeColors, handleFriendSelect]
  );

  // Open/close the bottom sheet based on visibility
  React.useEffect(() => {
    if (isVisible) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [isVisible]);

  const isAccountsTab = activeTab === 'accounts';
  const listData = (isAccountsTab
    ? filteredAccounts
    : filteredFriends) as Array<AccountMetadata | Friend>;

  const renderListItem = useCallback<ListRenderItem<AccountMetadata | Friend>>(
    ({ item }) =>
      isAccountsTab
        ? renderAccountItem({ item: item as AccountMetadata })
        : renderFriendItem({ item: item as Friend }),
    [isAccountsTab, renderAccountItem, renderFriendItem]
  );

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={snapPoints}
      onChange={handleSheetChanges}
      backdropComponent={renderBackdrop}
      enablePanDownToClose={false}
      enableHandlePanningGesture={false}
      enableContentPanningGesture={false}
      backgroundStyle={styles.bottomSheetBackground}
      handleIndicatorStyle={styles.bottomSheetIndicator}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetFlatList<AccountMetadata | Friend>
        data={listData}
        renderItem={renderListItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={listContentStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <View style={styles.header}>
              <Text style={styles.title}>Select Recipient</Text>
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

            <View style={styles.tabContainer}>
              <TouchableOpacity
                style={[styles.tab, isAccountsTab && styles.tabActive]}
                onPress={() => setActiveTab('accounts')}
                activeOpacity={0.7}
              >
                <Ionicons
                  name="wallet-outline"
                  size={20}
                  color={isAccountsTab ? themeColors.primary : themeColors.textSecondary}
                  style={styles.tabIcon}
                />
                <Text
                  style={[styles.tabText, isAccountsTab && styles.tabTextActive]}
                >
                  Accounts
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.tab, !isAccountsTab && styles.tabActive]}
                onPress={() => setActiveTab('friends')}
                activeOpacity={0.7}
              >
                <Ionicons
                  name="people-outline"
                  size={20}
                  color={!isAccountsTab ? themeColors.primary : themeColors.textSecondary}
                  style={styles.tabIcon}
                />
                <Text
                  style={[styles.tabText, !isAccountsTab && styles.tabTextActive]}
                >
                  Friends
                </Text>
              </TouchableOpacity>
            </View>

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
                  placeholder="Search..."
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
          </View>
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons
              name={isAccountsTab ? 'wallet-outline' : 'people-outline'}
              size={48}
              color={themeColors.textMuted}
              style={styles.emptyIcon}
            />
            <Text style={styles.emptyTitle}>
              {isAccountsTab
                ? searchQuery
                  ? 'No accounts found'
                  : 'No other accounts'
                : searchQuery
                  ? 'No friends found'
                  : 'No friends yet'}
            </Text>
            <Text style={styles.emptyMessage}>
              {isAccountsTab
                ? searchQuery
                  ? 'Try adjusting your search query.'
                  : 'You only have one account in your wallet.'
                : searchQuery
                  ? 'Try adjusting your search query.'
                  : 'Add friends by their Envoi name in the Friends screen.'}
            </Text>
          </View>
        }
        stickyHeaderIndices={[0]}
        style={styles.list}
      />
    </BottomSheetModal>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    bottomSheetBackground: {
      backgroundColor: theme.colors.card,
    },
    bottomSheetIndicator: {
      backgroundColor: theme.colors.border,
    },
    list: {
      flex: 1,
    },
    listContent: {
      flexGrow: 1,
      paddingBottom: theme.spacing.lg,
    },
    listHeader: {
      backgroundColor: theme.colors.card,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      marginBottom: theme.spacing.sm,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingBottom: theme.spacing.md,
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
      paddingHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
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
    accountItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      marginBottom: theme.spacing.xs,
      backgroundColor: theme.colors.surface,
      marginHorizontal: theme.spacing.lg,
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
      paddingHorizontal: theme.spacing.lg,
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
    tabContainer: {
      flexDirection: 'row',
      paddingHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.md,
    },
    tab: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.md,
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    tabActive: {
      borderBottomColor: theme.colors.primary,
    },
    tabIcon: {
      marginRight: theme.spacing.xs,
    },
    tabText: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.textSecondary,
    },
    tabTextActive: {
      color: theme.colors.primary,
      fontWeight: '600',
    },
    friendAvatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      overflow: 'hidden',
    },
    friendAvatarFallback: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
    },
    friendAvatarText: {
      fontSize: 18,
      fontWeight: '600',
      color: 'white',
    },
    friendNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
  });
