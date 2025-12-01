import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ImageBackground,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import { BlurView } from 'expo-blur';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useMessagesStore, useThread } from '@/store/messagesStore';
import { useFriendsStore } from '@/store/friendsStore';
import { useActiveAccount, useAccounts } from '@/store/walletStore';
import { AccountType, RekeyedAccountMetadata } from '@/types/wallet';
import { Message, MESSAGE_FEE_MICRO } from '@/services/messaging/types';
import MessagingService, { isMessagingKeyRegistered } from '@/services/messaging';
import type { FriendsStackParamList } from '@/navigation/AppNavigator';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { formatAddress } from '@/utils/address';
import MessageBubble from '@/components/social/MessageBubble';
import MessageInput from '@/components/social/MessageInput';
import MessagingInfoModal from '@/components/social/MessagingInfoModal';

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
  const flatListRef = useRef<FlatList>(null);

  const activeAccount = useActiveAccount();
  const allAccounts = useAccounts();
  const thread = useThread(friendAddress);
  const {
    fetchThreadMessages,
    markThreadAsRead,
    addPendingMessage,
    updateMessageStatus,
    isInitialized,
  } = useMessagesStore();
  const friends = useFriendsStore((state) => state.friends);

  // Get friend info
  const friend = friends.find((f) => f.address === friendAddress);
  const displayName = friend?.envoiName || friendEnvoiName || formatAddress(friendAddress);

  // Messages sorted newest first for inverted FlatList
  const messages = thread?.messages.slice().reverse() || [];

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

  // Check if recipient can receive messages on mount
  useFocusEffect(
    useCallback(() => {
      const initializeChat = async () => {
        if (activeAccount?.address) {
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

          // Only fetch messages and mark as read if not a Ledger account and store is initialized
          if (!isLedgerBacked && isInitialized) {
            fetchThreadMessages(activeAccount.address, friendAddress);
            markThreadAsRead(friendAddress);
          }
        }
      };

      initializeChat();
    }, [activeAccount?.address, isLedgerBacked, friendAddress, isInitialized, fetchThreadMessages, markThreadAsRead])
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

      const isRetry = !!existingMessageId;
      const tempId = existingMessageId || `pending-${Date.now()}`;

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
        updateMessageStatus(tempId, 'failed');
        if (!isRetry) {
          // Only show alert for first-time sends, not retries
          Alert.alert(
            'Message Failed',
            error instanceof Error ? error.message : 'Failed to send message. Tap the retry button to try again.'
          );
        }
      } finally {
        if (!isRetry) {
          setIsSending(false);
        }
      }
    },
    [activeAccount?.address, friendAddress, addPendingMessage, updateMessageStatus]
  );

  // Handle sending a new message
  const handleSend = useCallback(
    async (content: string) => {
      await sendMessageAsync(content);
    },
    [sendMessageAsync]
  );

  // Handle retrying a failed message
  const handleRetry = useCallback(
    (message: Message) => {
      sendMessageAsync(message.content, message.id);
    },
    [sendMessageAsync]
  );

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

      {/* Warning banner when using Ledger-backed account */}
      {isLedgerBacked && (
        <View style={styles.warningBanner}>
          <Ionicons name="hardware-chip-outline" size={16} color="white" />
          <Text style={styles.warningText}>
            Ledger accounts cannot use encrypted messaging
          </Text>
        </View>
      )}

      {/* Warning banner when recipient hasn't enabled messaging */}
      {!isCheckingRecipient && !recipientCanReceive && (
        <View style={styles.warningBanner}>
          <Ionicons name="warning" size={16} color="white" />
          <Text style={styles.warningText}>
            {displayName} hasn't enabled encrypted messaging yet
          </Text>
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

        {/* Message Input - disabled if Ledger account or recipient hasn't enabled messaging */}
        <MessageInput
          onSend={handleSend}
          isSending={isSending}
          disabled={!activeAccount?.address || isLedgerBacked || isCheckingRecipient || !recipientCanReceive}
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
        resizeMode="cover"
      >
        <BlurView
          intensity={80}
          tint={theme.mode === 'dark' ? 'dark' : 'light'}
          style={StyleSheet.absoluteFill}
        />
        <View style={[styles.backgroundOverlay, { backgroundColor: theme.colors.background + 'CC' }]} />
        {chatContent}
      </ImageBackground>
    );
  }

  // Otherwise, use plain background
  return (
    <View style={[styles.plainBackground, { backgroundColor: theme.colors.background }]}>
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
      ...StyleSheet.absoluteFillObject,
    },
    container: {
      flex: 1,
    },
    warningBanner: {
      backgroundColor: '#DC2626',
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
  });
