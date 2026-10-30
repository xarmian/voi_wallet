import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { ImageBackground } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  useNavigation,
  useRoute,
  useFocusEffect,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { BlurView } from 'expo-blur';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  PENDING_PLACEHOLDER_PREFIX,
  useMessagesStore,
  useThread,
} from '@/store/messagesStore';
import { useFriendsStore } from '@/store/friendsStore';
import { useActiveAccount } from '@/store/walletStore';
import { useMessagingSigner } from './useMessagingSigner';
import { MessagingSignerNotice } from './MessagingSignerNotice';
import { Message, MESSAGE_FEE_MICRO } from '@/services/messaging/types';
import MessagingService, {
  isMessagingKeyRegistered,
} from '@/services/messaging';
import type { FriendsStackParamList } from '@/navigation/AppNavigator';
import { ListFooterSpinner } from '@/components/common/ListFooterSpinner';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { formatAddress } from '@/utils/address';
import MessageBubble from '@/components/social/MessageBubble';
import MessageInput from '@/components/social/MessageInput';
import MessagingInfoModal from '@/components/social/MessagingInfoModal';
import { useIsMessagingEnabled } from '@/store/experimentalStore';
import { toUnsettledTransactionAlert } from '@/utils/errorMapping';

// How often an open chat re-checks an unsettled placeholder (TASK-454).
const UNSETTLED_REFRESH_MS = 30000;

export default function ChatScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const navigation =
    useNavigation<NativeStackNavigationProp<FriendsStackParamList, 'Chat'>>();
  const route = useRoute<RouteProp<FriendsStackParamList, 'Chat'>>();
  const { friendAddress, friendEnvoiName } = route.params;

  const [isSending, setIsSending] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [isCheckingRecipient, setIsCheckingRecipient] = useState(true);
  const [recipientCanReceive, setRecipientCanReceive] = useState(false);
  const [isCheckingSender, setIsCheckingSender] = useState(true);
  const [isSenderRegistered, setIsSenderRegistered] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const flatListRef = useRef<FlatList>(null);
  // Placeholder ids with a send in flight (TASK-454).
  const inFlightRef = useRef(new Set<string>());

  // Experimental feature guard - redirect if messaging is not enabled
  const isMessagingEnabled = useIsMessagingEnabled();
  useEffect(() => {
    if (!isMessagingEnabled) {
      navigation.goBack();
    }
  }, [isMessagingEnabled, navigation]);

  const activeAccount = useActiveAccount();
  const signer = useMessagingSigner(activeAccount);
  const { canUseMessaging } = signer;
  const thread = useThread(friendAddress);
  const {
    fetchThreadMessages,
    fetchOlderMessages,
    markThreadAsRead,
    addPendingMessage,
    updateMessageStatus,
    isInitialized,
    registerMessagingKey,
    checkKeyRegistration,
  } = useMessagesStore();
  const friends = useFriendsStore((state) => state.friends);

  // Get friend info
  const friend = friends.find((f) => f.address === friendAddress);
  const displayName =
    friend?.envoiName || friendEnvoiName || formatAddress(friendAddress);

  // Messages sorted newest first for inverted FlatList
  const messages = thread?.messages.slice().reverse() || [];

  // Check if sender and recipient can use messaging on mount
  useFocusEffect(
    useCallback(() => {
      const initializeChat = async () => {
        if (activeAccount?.address) {
          // Check if sender (current user) has registered their messaging key
          setIsCheckingSender(true);
          try {
            const senderRegistered = await checkKeyRegistration(
              activeAccount.address
            );
            setIsSenderRegistered(senderRegistered);
          } catch (error) {
            console.error('Failed to check sender registration:', error);
            setIsSenderRegistered(false);
          } finally {
            setIsCheckingSender(false);
          }

          // Always check if recipient has registered their messaging key
          setIsCheckingRecipient(true);
          try {
            const canReceive = await isMessagingKeyRegistered(friendAddress);
            setRecipientCanReceive(canReceive);
          } catch (error) {
            console.error('Failed to check recipient registration:', error);
            setRecipientCanReceive(false);
          } finally {
            setIsCheckingRecipient(false);
          }

          // Only fetch messages and mark as read if account can use messaging and store is initialized
          if (canUseMessaging && isInitialized) {
            fetchThreadMessages(activeAccount.address, friendAddress);
            markThreadAsRead(friendAddress);
          }
        }
      };

      initializeChat();
    }, [
      activeAccount?.address,
      canUseMessaging,
      friendAddress,
      isInitialized,
      fetchThreadMessages,
      markThreadAsRead,
      checkKeyRegistration,
    ])
  );

  // While this chat is open with an unsettled placeholder, age it out locally:
  // nothing else polls an open chat, so without this it could spin forever.
  // No network call: if the send landed, its chain record arrives on the next
  // load as usual (TASK-454).
  const hasUnsettled = !!thread?.messages.some(
    (m) => m.unsettled && m.status === 'pending'
  );
  useFocusEffect(
    useCallback(() => {
      if (!hasUnsettled) return undefined;
      const timer = setInterval(() => {
        useMessagesStore.getState().expireUnsettledPlaceholders(friendAddress);
      }, UNSETTLED_REFRESH_MS);
      return () => clearInterval(timer);
    }, [hasUnsettled, friendAddress])
  );

  // Mark as read when messages change
  useEffect(() => {
    if (thread?.unreadCount && thread.unreadCount > 0) {
      markThreadAsRead(friendAddress);
    }
  }, [thread?.unreadCount, friendAddress, markThreadAsRead]);

  // Scroll to bottom when new message arrives
  useEffect(() => {
    if (messages.length > 0) {
      // Small delay to ensure FlatList has rendered
      setTimeout(() => {
        flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
      }, 100);
    }
  }, [messages.length]);

  // Send a message (used for both new messages and retries)
  const sendMessageAsync = useCallback(
    async (content: string, existingMessageId?: string) => {
      if (!activeAccount?.address) {
        Alert.alert('Error', 'No active account');
        return;
      }

      if (!canUseMessaging) return;

      const isRetry = !!existingMessageId;
      const attemptedAt = Date.now();
      const tempId =
        existingMessageId || `${PENDING_PLACEHOLDER_PREFIX}${Date.now()}`;

      // One attempt per row at a time, and only a row that is still failed can
      // be retried: a second tap must never race the first (TASK-454).
      const currentThread =
        useMessagesStore.getState().threads[friendAddress]?.messages ?? [];
      if (isRetry) {
        const row = currentThread.find((m) => m.id === tempId);
        if (inFlightRef.current.has(tempId) || row?.status !== 'failed') {
          return;
        }
      }
      inFlightRef.current.add(tempId);

      // If not a retry, create and add optimistic message
      if (!isRetry) {
        setIsSending(true);
        const pendingMessage: Message = {
          id: tempId,
          threadId: friendAddress,
          direction: 'sent',
          content,
          timestamp: Date.now(),
          status: 'pending',
          fee: MESSAGE_FEE_MICRO,
        };
        addPendingMessage(pendingMessage);
      } else {
        // For retry, update status back to pending
        updateMessageStatus(tempId, 'pending');
      }

      try {
        const result = await MessagingService.sendMessage(
          {
            senderAddress: activeAccount.address,
            recipientAddress: friendAddress,
            content,
          },
          undefined // No PIN needed after wallet unlock
        );

        // Remove the pending message and add the confirmed one with real transaction ID
        useMessagesStore.getState().removePendingMessage(tempId);
        useMessagesStore.getState().addMessage(result.message);
      } catch (error) {
        console.error('Failed to send message:', error);
        // It may already be on chain: a 'failed' bubble's retry button would
        // send it twice. Keep the placeholder pending, with no retry: with a
        // txid the chain load confirms it, without one it ages out (TASK-454).
        if (toUnsettledTransactionAlert(error)) {
          const txId = (error as { txId?: unknown }).txId;
          useMessagesStore
            .getState()
            .settlePendingMessage(
              tempId,
              typeof txId === 'string' && txId ? txId : undefined,
              attemptedAt
            );
          return;
        }
        useMessagesStore.getState().failPendingMessage(tempId);
        if (!isRetry) {
          // Only show alert for first-time sends, not retries
          Alert.alert(
            'Message Failed',
            error instanceof Error
              ? error.message
              : 'Failed to send message. Tap the retry button to try again.'
          );
        }
      } finally {
        inFlightRef.current.delete(tempId);
        if (!isRetry) {
          setIsSending(false);
        }
      }
    },
    [
      canUseMessaging,
      activeAccount?.address,
      friendAddress,
      addPendingMessage,
      updateMessageStatus,
    ]
  );

  // Handle sending a new message
  const handleSend = useCallback(
    async (content: string) => {
      await sendMessageAsync(content);
    },
    [sendMessageAsync]
  );

  // Handle key registration
  const handleRegisterKey = useCallback(async () => {
    if (!activeAccount?.address || isRegistering || !canUseMessaging) return;

    setIsRegistering(true);
    try {
      await registerMessagingKey(activeAccount.address);
      setIsSenderRegistered(true);
    } catch (error) {
      console.error('Failed to register messaging key:', error);
      // Submitted but not confirmed is not a failure (TASK-447).
      const unsettled = toUnsettledTransactionAlert(error);
      if (unsettled) {
        Alert.alert(unsettled.title, unsettled.message);
        return;
      }
      Alert.alert(
        'Registration Failed',
        'Failed to enable messaging. Please try again.'
      );
    } finally {
      setIsRegistering(false);
    }
  }, [
    activeAccount?.address,
    isRegistering,
    registerMessagingKey,
    canUseMessaging,
  ]);

  // Handle retrying a failed message
  const handleRetry = useCallback(
    (message: Message) => {
      sendMessageAsync(message.content, message.id);
    },
    [sendMessageAsync]
  );

  // Handle loading older messages when scrolling up (inverted list - onEndReached = top)
  const handleLoadMore = useCallback(async () => {
    if (!activeAccount?.address || isLoadingMore || !hasMoreMessages) {
      return;
    }

    // Get the oldest message's round to fetch messages before it
    const oldestMessage = thread?.messages[0];
    if (!oldestMessage?.confirmedRound) {
      // No confirmed messages yet or no round info
      setHasMoreMessages(false);
      return;
    }

    setIsLoadingMore(true);
    try {
      const result = await fetchOlderMessages(
        activeAccount.address,
        friendAddress,
        oldestMessage.confirmedRound
      );
      setHasMoreMessages(result.hasMore);
    } finally {
      setIsLoadingMore(false);
    }
  }, [
    activeAccount?.address,
    isLoadingMore,
    hasMoreMessages,
    thread?.messages,
    fetchOlderMessages,
    friendAddress,
  ]);

  // Render message item
  const renderMessage = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble
        message={item}
        isOwn={item.direction === 'sent'}
        onRetry={handleRetry}
      />
    ),
    [handleRetry]
  );

  // Key extractor
  const keyExtractor = useCallback((item: Message) => item.id, []);

  // Handle back press
  const handleBackPress = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  // Get friend's avatar for background
  const friendAvatar = friend?.avatar;

  const chatContent = (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title={displayName}
        subtitle={friend?.envoiName ? formatAddress(friendAddress) : undefined}
        showBackButton
        onBackPress={handleBackPress}
        showAccountSelector={false}
        onAccountSelectorPress={() => {}}
      />

      <MessagingSignerNotice signer={signer} />

      {/* Warning banner when recipient hasn't enabled messaging */}
      {!isCheckingRecipient && !recipientCanReceive && (
        <View style={styles.warningBanner}>
          <Ionicons name="warning" size={16} color="white" />
          <Text style={styles.warningText}>
            {displayName} hasn&apos;t enabled encrypted messaging yet
          </Text>
        </View>
      )}

      {/* Registration prompt when sender hasn't enabled messaging */}
      {!isCheckingSender && !isSenderRegistered && canUseMessaging && (
        <View style={styles.registrationBanner}>
          <View style={styles.registrationContent}>
            <Ionicons
              name="key-outline"
              size={20}
              color={theme.colors.primary}
            />
            <View style={styles.registrationTextContainer}>
              <Text style={styles.registrationTitle}>Enable Messaging</Text>
              <Text style={styles.registrationText}>
                Register your key to send and receive messages
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={styles.registrationButton}
            onPress={handleRegisterKey}
            disabled={isRegistering}
          >
            {isRegistering ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Text style={styles.registrationButtonText}>Enable</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      <KeyboardAvoidingView
        style={styles.content}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        {/* Messages List */}
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={keyExtractor}
          inverted
          contentContainerStyle={[
            styles.messagesContent,
            messages.length === 0 && styles.emptyListContent,
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          ListFooterComponent={<ListFooterSpinner visible={isLoadingMore} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyStateInner}>
                <Ionicons
                  name="chatbubble-ellipses-outline"
                  size={48}
                  color={theme.colors.textMuted}
                />
                <Text style={styles.emptyTitle}>No messages yet</Text>
                <Text style={styles.emptyText}>
                  Start the conversation with {displayName}
                </Text>
              </View>
            </View>
          }
        />

        {/* Message Input - disabled if account can't use messaging, sender not registered, or recipient hasn't enabled messaging */}
        <MessageInput
          onSend={handleSend}
          isSending={isSending}
          disabled={
            !activeAccount?.address ||
            !canUseMessaging ||
            isCheckingRecipient ||
            !recipientCanReceive ||
            isCheckingSender ||
            !isSenderRegistered
          }
          onInfoPress={() => setShowInfoModal(true)}
        />
      </KeyboardAvoidingView>

      {/* Info Modal */}
      <MessagingInfoModal
        visible={showInfoModal}
        onClose={() => setShowInfoModal(false)}
      />
    </SafeAreaView>
  );

  // If friend has an avatar, show it as blurred background
  if (friendAvatar) {
    return (
      <ImageBackground
        source={{ uri: friendAvatar }}
        style={styles.backgroundImage}
        contentFit="cover"
        cachePolicy="memory-disk"
      >
        <BlurView
          intensity={80}
          tint={theme.mode === 'dark' ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
        <View
          style={[
            styles.backgroundOverlay,
            { backgroundColor: theme.colors.background + 'CC' },
          ]}
        />
        {chatContent}
      </ImageBackground>
    );
  }

  // Otherwise, use plain background
  return (
    <View
      style={[
        styles.plainBackground,
        { backgroundColor: theme.colors.background },
      ]}
    >
      {chatContent}
    </View>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    plainBackground: {
      flex: 1,
    },
    backgroundImage: {
      flex: 1,
    },
    backgroundOverlay: {
      ...StyleSheet.absoluteFill,
    },
    container: {
      flex: 1,
    },
    warningBanner: {
      backgroundColor: theme.colors.error,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    warningText: {
      color: 'white',
      fontSize: 13,
      fontWeight: '500',
    },
    content: {
      flex: 1,
    },
    messagesContent: {
      paddingVertical: theme.spacing.md,
    },
    emptyListContent: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    emptyStateInner: {
      alignItems: 'center',
      padding: theme.spacing.xl,
    },
    emptyTitle: {
      fontSize: 18,
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
    registrationBanner: {
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
    },
    registrationContent: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      gap: theme.spacing.sm,
    },
    registrationTextContainer: {
      flex: 1,
    },
    registrationTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    registrationText: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    registrationButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
      minWidth: 70,
      alignItems: 'center',
    },
    registrationButtonText: {
      color: 'white',
      fontSize: 13,
      fontWeight: '600',
    },
  });
