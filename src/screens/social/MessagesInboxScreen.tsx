import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  Image,
  BackHandler,
  ActivityIndicator,
  ActionSheetIOS,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Swipeable } from 'react-native-gesture-handler';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useMessagesStore, useSortedThreads, useHiddenThreadsCount, useShowHiddenThreads, useRealtimeConnected } from '@/store/messagesStore';
import { useFriendsStore } from '@/store/friendsStore';
import { useActiveAccount, useAccounts } from '@/store/walletStore';
import { AccountType, RekeyedAccountMetadata } from '@/types/wallet';
import { MessageThread, MESSAGE_FEE_DISPLAY } from '@/services/messaging/types';
import type { FriendsStackParamList } from '@/navigation/AppNavigator';
import { NFTBackground } from '@/components/common/NFTBackground';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { GlassButton } from '@/components/common/GlassButton';
import AccountAvatar from '@/components/account/AccountAvatar';
import AccountListModal from '@/components/account/AccountListModal';
import { formatAddress } from '@/utils/address';
import { useIsMessagingEnabled } from '@/store/experimentalStore';

export default function MessagesInboxScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const navigation =
    useNavigation<NativeStackNavigationProp<FriendsStackParamList, 'MessagesInbox'>>();
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);

  // Experimental feature guard - redirect if messaging is not enabled
  const isMessagingEnabled = useIsMessagingEnabled();
  useEffect(() => {
    if (!isMessagingEnabled) {
      navigation.goBack();
    }
  }, [isMessagingEnabled, navigation]);

  const activeAccount = useActiveAccount();
  const allAccounts = useAccounts();
  const sortedThreads = useSortedThreads();
  const hiddenThreadsCount = useHiddenThreadsCount();
  const showHiddenThreads = useShowHiddenThreads();
  const realtimeConnected = useRealtimeConnected();
  const [isCheckingRegistration, setIsCheckingRegistration] = useState(true);
  const {
    initialize,
    isInitialized,
    isLoading,
    isKeyRegistered,
    checkKeyRegistration,
    fetchAllThreads,
    registerMessagingKey,
    startPolling,
    stopPolling,
    initializeRealtime,
    cleanupRealtime,
    hideThread,
    unhideThread,
    toggleShowHiddenThreads,
    hiddenThreads,
  } = useMessagesStore();
  const friends = useFriendsStore((state) => state.friends);
  const friendsInitialize = useFriendsStore((state) => state.initialize);
  const friendsIsInitialized = useFriendsStore((state) => state.isInitialized);

  // Initialize messages store on mount
  useEffect(() => {
    if (!isInitialized) {
      initialize();
    }
  }, [isInitialized, initialize]);

  // Initialize friends store if needed
  useEffect(() => {
    if (!friendsIsInitialized) {
      friendsInitialize();
    }
  }, [friendsIsInitialized, friendsInitialize]);

  // Helper to check if account is Ledger-backed
  const checkIsLedgerBacked = useCallback(() => {
    if (!activeAccount) return false;

    // Direct Ledger account
    if (activeAccount.type === AccountType.LEDGER || activeAccount.type === 'ledger') {
      return true;
    }

    // Rekeyed account - check if auth address belongs to a Ledger account
    if (activeAccount.type === AccountType.REKEYED || activeAccount.type === 'rekeyed') {
      const rekeyedAccount = activeAccount as RekeyedAccountMetadata;
      const authAccount = allAccounts.find(acc => acc.address === rekeyedAccount.authAddress);
      if (authAccount?.type === AccountType.LEDGER || authAccount?.type === 'ledger') {
        return true;
      }
    }

    return false;
  }, [activeAccount, allAccounts]);

  // Check registration and fetch messages when account is available
  useFocusEffect(
    useCallback(() => {
      const initializeMessaging = async () => {
        if (activeAccount?.address && isInitialized) {
          // Skip everything for Ledger-backed accounts - messaging not supported
          if (checkIsLedgerBacked()) {
            setIsCheckingRegistration(false);
            return;
          }

          setIsCheckingRegistration(true);

          // First check registration status (this is the slow part)
          const registered = await checkKeyRegistration(activeAccount.address);
          setIsCheckingRegistration(false);

          // Only fetch threads and initialize realtime if registered
          if (registered) {
            fetchAllThreads(activeAccount.address);
            // Use realtime for instant updates (falls back to polling if unavailable)
            initializeRealtime(activeAccount.address);
          }
        }
      };

      initializeMessaging();

      return () => {
        // Cleanup realtime and polling when screen loses focus
        stopPolling();
        // Note: We don't cleanup realtime here to keep receiving updates
        // Realtime is cleaned up when the user logs out or changes accounts
      };
    }, [activeAccount?.address, isInitialized, checkIsLedgerBacked, checkKeyRegistration, fetchAllThreads, initializeRealtime, stopPolling])
  );

  // Handle back button for modals
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (isAccountModalVisible) {
        setIsAccountModalVisible(false);
        return true;
      }
      return false;
    });

    return () => backHandler.remove();
  }, [isAccountModalVisible]);

  // Account modal handlers
  const handleAccountSelectorPress = useCallback(() => {
    setIsAccountModalVisible(true);
  }, []);

  const handleAccountModalClose = useCallback(() => {
    setIsAccountModalVisible(false);
  }, []);

  // Filter threads based on search
  const filteredThreads = searchQuery.trim()
    ? sortedThreads.filter((thread) => {
        const friend = friends.find((f) => f.address === thread.friendAddress);
        const query = searchQuery.toLowerCase();
        return (
          thread.friendAddress.toLowerCase().includes(query) ||
          thread.friendEnvoiName?.toLowerCase().includes(query) ||
          friend?.envoiName.toLowerCase().includes(query)
        );
      })
    : sortedThreads;

  // Handle thread press
  const handleThreadPress = useCallback(
    (thread: MessageThread) => {
      navigation.navigate('Chat', {
        friendAddress: thread.friendAddress,
        friendEnvoiName: thread.friendEnvoiName,
      });
    },
    [navigation]
  );

  // Handle new message
  const handleNewMessage = useCallback(() => {
    navigation.navigate('NewMessage');
  }, [navigation]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    if (!activeAccount?.address) return;
    setIsRefreshing(true);
    await fetchAllThreads(activeAccount.address);
    setIsRefreshing(false);
  }, [activeAccount?.address, fetchAllThreads]);

  // Handle key registration
  const handleRegisterKey = useCallback(async () => {
    if (!activeAccount?.address || isRegistering) return;

    setIsRegistering(true);
    try {
      await registerMessagingKey(activeAccount.address);
      // After registration, fetch threads
      await fetchAllThreads(activeAccount.address);
    } catch (error) {
      console.error('Failed to register messaging key:', error);
    } finally {
      setIsRegistering(false);
    }
  }, [activeAccount?.address, isRegistering, registerMessagingKey, fetchAllThreads]);

  // Handle hiding/unhiding a thread
  const handleHideThread = useCallback(
    (friendAddress: string, friendName: string) => {
      const isHidden = hiddenThreads.has(friendAddress);
      const action = isHidden ? 'Unhide' : 'Hide';
      const actionLower = isHidden ? 'unhide' : 'hide';

      if (Platform.OS === 'ios') {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options: ['Cancel', `${action} Conversation`],
            cancelButtonIndex: 0,
            destructiveButtonIndex: isHidden ? undefined : 1,
            title: friendName,
            message: `Do you want to ${actionLower} this conversation?`,
          },
          (buttonIndex) => {
            if (buttonIndex === 1) {
              if (isHidden) {
                unhideThread(friendAddress);
              } else {
                hideThread(friendAddress);
              }
            }
          }
        );
      } else {
        Alert.alert(
          friendName,
          `Do you want to ${actionLower} this conversation?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: `${action} Conversation`,
              style: isHidden ? 'default' : 'destructive',
              onPress: () => {
                if (isHidden) {
                  unhideThread(friendAddress);
                } else {
                  hideThread(friendAddress);
                }
              },
            },
          ]
        );
      }
    },
    [hiddenThreads, hideThread, unhideThread]
  );

  // Format timestamp
  const formatTimestamp = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return 'Now';
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    if (days < 7) return `${days}d`;
    return new Date(timestamp).toLocaleDateString();
  };

  // Get friend info for a thread
  const getFriendInfo = useCallback(
    (thread: MessageThread) => {
      const friend = friends.find((f) => f.address === thread.friendAddress);
      return {
        name: friend?.envoiName || thread.friendEnvoiName || formatAddress(thread.friendAddress),
        avatar: friend?.avatar,
        address: thread.friendAddress,
      };
    },
    [friends]
  );

  // Handle long press on thread
  const handleThreadLongPress = useCallback(
    (thread: MessageThread) => {
      const friendInfo = getFriendInfo(thread);
      handleHideThread(thread.friendAddress, friendInfo.name);
    },
    [getFriendInfo, handleHideThread]
  );

  // Render swipe action for hide/unhide
  const renderRightActions = useCallback(
    (friendAddress: string) => {
      const isHidden = hiddenThreads.has(friendAddress);
      return (
        <TouchableOpacity
          style={[
            styles.swipeAction,
            { backgroundColor: isHidden ? theme.colors.primary : '#DC2626' },
          ]}
          onPress={() => {
            if (isHidden) {
              unhideThread(friendAddress);
            } else {
              hideThread(friendAddress);
            }
          }}
        >
          <Ionicons
            name={isHidden ? 'eye-outline' : 'eye-off-outline'}
            size={24}
            color="white"
          />
          <Text style={styles.swipeActionText}>
            {isHidden ? 'Unhide' : 'Hide'}
          </Text>
        </TouchableOpacity>
      );
    },
    [hiddenThreads, hideThread, unhideThread, styles, theme.colors.primary]
  );

  // Render thread item
  const renderThreadItem = (thread: MessageThread) => {
    const friendInfo = getFriendInfo(thread);
    const hasUnread = thread.unreadCount > 0;
    const isHidden = hiddenThreads.has(thread.friendAddress);

    return (
      <Swipeable
        key={thread.friendAddress}
        renderRightActions={() => renderRightActions(thread.friendAddress)}
        overshootRight={false}
      >
        <BlurredContainer
          style={[styles.threadItem, isHidden && showHiddenThreads && styles.threadItemHidden]}
          borderRadius={theme.borderRadius.lg}
        >
          <TouchableOpacity
            style={styles.threadTouchable}
            onPress={() => handleThreadPress(thread)}
            onLongPress={() => handleThreadLongPress(thread)}
            activeOpacity={0.7}
            delayLongPress={500}
          >
            <View style={styles.avatarContainer}>
              {friendInfo.avatar ? (
                <Image source={{ uri: friendInfo.avatar }} style={styles.avatar} />
              ) : (
                <AccountAvatar
                  address={friendInfo.address}
                  size={48}
                  useEnvoiAvatar={false}
                  fallbackToGenerated
                  showActiveIndicator={false}
                  showRekeyIndicator={false}
                />
              )}
              {isHidden && showHiddenThreads && (
                <View style={styles.hiddenIndicator}>
                  <Ionicons name="eye-off" size={12} color="white" />
                </View>
              )}
            </View>

            <View style={styles.threadContent}>
              <View style={styles.threadHeader}>
                <Text
                  style={[styles.threadName, hasUnread && styles.threadNameUnread]}
                  numberOfLines={1}
                >
                  {friendInfo.name}
                </Text>
                <Text style={styles.threadTime}>
                  {thread.lastMessageTimestamp
                    ? formatTimestamp(thread.lastMessageTimestamp)
                    : ''}
                </Text>
              </View>
              <View style={styles.threadPreview}>
                <Text
                  style={[styles.threadMessage, hasUnread && styles.threadMessageUnread]}
                  numberOfLines={1}
                >
                  {thread.lastMessage?.direction === 'sent' ? 'You: ' : ''}
                  {thread.lastMessage?.content || 'No messages yet'}
                </Text>
                {hasUnread && (
                  <View style={[styles.unreadBadge, { backgroundColor: theme.colors.primary }]}>
                    <Text style={styles.unreadBadgeText}>
                      {thread.unreadCount > 99 ? '99+' : thread.unreadCount}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </TouchableOpacity>
        </BlurredContainer>
      </Swipeable>
    );
  };

  // Check if current account is backed by a Ledger (either directly or via rekey)
  const isLedgerBacked = (() => {
    if (!activeAccount) return false;

    // Direct Ledger account
    if (activeAccount.type === AccountType.LEDGER || activeAccount.type === 'ledger') {
      return true;
    }

    // Rekeyed account - check if auth address belongs to a Ledger account
    if (activeAccount.type === AccountType.REKEYED || activeAccount.type === 'rekeyed') {
      const rekeyedAccount = activeAccount as RekeyedAccountMetadata;
      const authAccount = allAccounts.find(acc => acc.address === rekeyedAccount.authAddress);
      if (authAccount?.type === AccountType.LEDGER || authAccount?.type === 'ledger') {
        return true;
      }
    }

    return false;
  })();

  // Render unsupported message for Ledger accounts
  const renderLedgerUnsupported = () => {
    return (
      <View style={styles.emptyState}>
        <Ionicons name="hardware-chip-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyTitle}>Ledger Not Supported</Text>
        <Text style={styles.emptyText}>
          Encrypted messaging requires signing a challenge message, which the Ledger Algorand app
          doesn't support. Please switch to a standard account to use messaging.
        </Text>
      </View>
    );
  };

  // Render key registration prompt
  const renderKeyRegistrationPrompt = () => {
    return (
      <View style={styles.emptyState}>
        <Ionicons name="key-outline" size={64} color={theme.colors.primary} />
        <Text style={styles.emptyTitle}>Enable Encrypted Messaging</Text>
        <Text style={styles.emptyText}>
          To receive encrypted messages, you need to publish your messaging key to the blockchain.
          This is a one-time setup.
        </Text>
        <Text style={styles.feeText}>
          Transaction fee: {MESSAGE_FEE_DISPLAY}
        </Text>
        <GlassButton
          variant="primary"
          size="lg"
          label={isRegistering ? 'Registering...' : 'Enable Messaging'}
          icon={isRegistering ? undefined : 'shield-checkmark-outline'}
          onPress={handleRegisterKey}
          disabled={isRegistering}
          style={{ marginTop: theme.spacing.lg }}
        />
        {isRegistering && (
          <ActivityIndicator
            size="small"
            color={theme.colors.primary}
            style={{ marginTop: theme.spacing.md }}
          />
        )}
      </View>
    );
  };

  // Render empty state
  const renderEmptyState = () => {
    // Show unsupported message for Ledger accounts
    if (isLedgerBacked) {
      return renderLedgerUnsupported();
    }

    // Show loading while checking registration status
    if (isCheckingRegistration) {
      return (
        <View style={styles.emptyState}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.emptyText}>Checking messaging status...</Text>
        </View>
      );
    }

    // Show registration prompt if key not registered
    if (!isKeyRegistered) {
      return renderKeyRegistrationPrompt();
    }

    if (searchQuery.trim()) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="search-outline" size={64} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>No conversations found</Text>
          <Text style={styles.emptyText}>Try a different search term</Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyState}>
        <Ionicons name="chatbubbles-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyTitle}>No messages yet</Text>
        <Text style={styles.emptyText}>
          Start a conversation with someone on the Voi Network
        </Text>
        <GlassButton
          variant="primary"
          size="md"
          label="New Message"
          icon="create-outline"
          onPress={handleNewMessage}
          style={{ marginTop: theme.spacing.lg }}
        />
      </View>
    );
  };

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title={showHiddenThreads ? 'Hidden Messages' : 'Messages'}
          showAccountSelector
          onAccountSelectorPress={handleAccountSelectorPress}
          rightAction={
            !isLedgerBacked && isKeyRegistered ? (
              <View style={styles.headerActions}>
                {/* Hidden conversations toggle - only show if there are hidden threads */}
                {hiddenThreadsCount > 0 && (
                  <TouchableOpacity
                    style={styles.headerActionButton}
                    onPress={toggleShowHiddenThreads}
                  >
                    <Ionicons
                      name={showHiddenThreads ? 'eye-outline' : 'eye-off-outline'}
                      size={22}
                      color={showHiddenThreads ? theme.colors.primary : theme.colors.textMuted}
                    />
                    {!showHiddenThreads && (
                      <View style={[styles.hiddenCountBadge, { backgroundColor: theme.colors.textMuted }]}>
                        <Text style={styles.hiddenCountText}>{hiddenThreadsCount}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.headerActionButton} onPress={handleNewMessage}>
                  <Ionicons name="create-outline" size={24} color={theme.colors.primary} />
                </TouchableOpacity>
              </View>
            ) : undefined
          }
        />

        {/* Search Bar - only show when registered and not Ledger */}
        {!isLedgerBacked && isKeyRegistered && (
          <BlurredContainer style={styles.searchContainer} borderRadius={0}>
            <View style={styles.searchInputContainer}>
              <Ionicons name="search" size={20} color={theme.colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search conversations"
                placeholderTextColor={theme.colors.textMuted}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')}>
                  <Ionicons name="close-circle" size={20} color={theme.colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </BlurredContainer>
        )}

        {/* Messages List */}
        <ScrollView
          contentContainerStyle={
            isLedgerBacked || isCheckingRegistration || filteredThreads.length === 0 || !isKeyRegistered
              ? styles.emptyListContent
              : styles.listContent
          }
          refreshControl={
            !isLedgerBacked && isKeyRegistered && !isCheckingRegistration ? (
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={handleRefresh}
                tintColor={theme.colors.primary}
              />
            ) : undefined
          }
        >
          {isLedgerBacked || isCheckingRegistration || !isKeyRegistered || filteredThreads.length === 0
            ? renderEmptyState()
            : filteredThreads.map(renderThreadItem)}
        </ScrollView>

        {/* Account List Modal */}
        <AccountListModal
          isVisible={isAccountModalVisible}
          onClose={handleAccountModalClose}
        />
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    newMessageButton: {
      padding: theme.spacing.sm,
    },
    searchContainer: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface + '80',
      borderRadius: theme.borderRadius.md,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      gap: theme.spacing.sm,
    },
    searchInput: {
      flex: 1,
      fontSize: 16,
      color: theme.colors.text,
    },
    listContent: {
      padding: theme.spacing.md,
      paddingBottom: 100,
      gap: theme.spacing.sm,
    },
    emptyListContent: {
      flex: 1,
      padding: theme.spacing.md,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.xl,
    },
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
    },
    feeText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.md,
    },
    threadItem: {
      marginBottom: theme.spacing.xs,
    },
    threadTouchable: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: theme.spacing.md,
      gap: theme.spacing.md,
    },
    avatarContainer: {
      width: 48,
      height: 48,
    },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
    },
    threadContent: {
      flex: 1,
    },
    threadHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 4,
    },
    threadName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
      flex: 1,
    },
    threadNameUnread: {
      fontWeight: '700',
    },
    threadTime: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.sm,
    },
    threadPreview: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    threadMessage: {
      fontSize: 14,
      color: theme.colors.textMuted,
      flex: 1,
    },
    threadMessageUnread: {
      color: theme.colors.text,
      fontWeight: '500',
    },
    unreadBadge: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 6,
      marginLeft: theme.spacing.sm,
    },
    unreadBadgeText: {
      color: 'white',
      fontSize: 11,
      fontWeight: '700',
    },
    // Header action styles
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    headerActionButton: {
      padding: theme.spacing.sm,
      position: 'relative',
    },
    hiddenCountBadge: {
      position: 'absolute',
      top: 4,
      right: 4,
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 4,
    },
    hiddenCountText: {
      color: 'white',
      fontSize: 10,
      fontWeight: '700',
    },
    // Swipe action styles
    swipeAction: {
      justifyContent: 'center',
      alignItems: 'center',
      width: 80,
      marginBottom: theme.spacing.xs,
      borderTopRightRadius: theme.borderRadius.lg,
      borderBottomRightRadius: theme.borderRadius.lg,
    },
    swipeActionText: {
      color: 'white',
      fontSize: 12,
      fontWeight: '600',
      marginTop: 4,
    },
    // Hidden thread styles
    threadItemHidden: {
      opacity: 0.7,
    },
    hiddenIndicator: {
      position: 'absolute',
      bottom: -2,
      right: -2,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
      borderRadius: 10,
      width: 20,
      height: 20,
      justifyContent: 'center',
      alignItems: 'center',
    },
  });
