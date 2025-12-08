import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import algosdk from 'algosdk';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import EnvoiService from '@/services/envoi';
import { useFriendsStore } from '@/store/friendsStore';
import { useMessagesStore } from '@/store/messagesStore';
import { useActiveAccount, useAccounts } from '@/store/walletStore';
import { AccountType, RekeyedAccountMetadata } from '@/types/wallet';
import { formatAddress } from '@/utils/address';
import AccountAvatar from '@/components/account/AccountAvatar';
import type { FriendsStackParamList } from '@/navigation/AppNavigator';
import { NFTBackground } from '@/components/common/NFTBackground';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { Friend } from '@/types/social';
import { useIsMessagingEnabled } from '@/store/experimentalStore';

interface RecipientOption {
  address: string;
  name?: string;
  avatar?: string;
  isFriend: boolean;
}

export default function NewMessageScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const navigation =
    useNavigation<NativeStackNavigationProp<FriendsStackParamList, 'NewMessage'>>();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RecipientOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isValidAddress, setIsValidAddress] = useState(false);

  // Experimental feature guard - redirect if messaging is not enabled
  const isMessagingEnabled = useIsMessagingEnabled();
  useEffect(() => {
    if (!isMessagingEnabled) {
      navigation.goBack();
    }
  }, [isMessagingEnabled, navigation]);

  const activeAccount = useActiveAccount();
  const allAccounts = useAccounts();
  const { isKeyRegistered, checkKeyRegistration } = useMessagesStore();
  const friends = useFriendsStore((state) => state.friends);
  const friendsInitialize = useFriendsStore((state) => state.initialize);
  const friendsIsInitialized = useFriendsStore((state) => state.isInitialized);

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

  // Check key registration on focus - redirect if not registered or Ledger
  useFocusEffect(
    useCallback(() => {
      const checkRegistration = async () => {
        if (activeAccount?.address) {
          // Ledger-backed accounts can't use messaging
          if (isLedgerBacked) {
            Alert.alert(
              'Ledger Not Supported',
              'Encrypted messaging is not available for Ledger accounts. Please switch to a standard account.',
              [
                {
                  text: 'OK',
                  onPress: () => navigation.goBack(),
                },
              ]
            );
            return;
          }

          const registered = await checkKeyRegistration(activeAccount.address);
          if (!registered) {
            Alert.alert(
              'Messaging Not Enabled',
              'You need to enable encrypted messaging before you can send messages.',
              [
                {
                  text: 'OK',
                  onPress: () => navigation.goBack(),
                },
              ]
            );
          }
        }
      };
      checkRegistration();
    }, [activeAccount?.address, isLedgerBacked, checkKeyRegistration, navigation])
  );

  // Initialize friends store if needed
  useEffect(() => {
    if (!friendsIsInitialized) {
      friendsInitialize();
    }
  }, [friendsIsInitialized, friendsInitialize]);

  // Check if input is a valid address
  useEffect(() => {
    const trimmedQuery = searchQuery.trim();
    setIsValidAddress(algosdk.isValidAddress(trimmedQuery));
  }, [searchQuery]);

  // Auto-search as user types (debounced)
  useEffect(() => {
    const trimmedQuery = searchQuery.trim();

    if (trimmedQuery.length === 0) {
      // Show all friends as suggestions when no query
      setSearchResults(
        friends.map((f) => ({
          address: f.address,
          name: f.envoiName,
          avatar: f.avatar,
          isFriend: true,
        }))
      );
      return;
    }

    // If it's a valid address, don't search Envoi
    if (algosdk.isValidAddress(trimmedQuery)) {
      // Check if this address is a friend
      const friend = friends.find((f) => f.address === trimmedQuery);
      setSearchResults([
        {
          address: trimmedQuery,
          name: friend?.envoiName,
          avatar: friend?.avatar,
          isFriend: !!friend,
        },
      ]);
      return;
    }

    // Filter friends first
    const filteredFriends = friends.filter(
      (f) =>
        f.envoiName.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
        f.address.toLowerCase().includes(trimmedQuery.toLowerCase())
    );

    if (filteredFriends.length > 0) {
      setSearchResults(
        filteredFriends.slice(0, 5).map((f) => ({
          address: f.address,
          name: f.envoiName,
          avatar: f.avatar,
          isFriend: true,
        }))
      );
    }

    // Debounce Envoi search
    if (trimmedQuery.length >= 2) {
      const timeoutId = setTimeout(() => {
        handleEnvoiSearch(trimmedQuery, filteredFriends);
      }, 400);

      return () => clearTimeout(timeoutId);
    }
  }, [searchQuery, friends]);

  const handleEnvoiSearch = useCallback(
    async (query: string, existingFriends: Friend[]) => {
      setIsLoading(true);

      try {
        const envoiService = EnvoiService.getInstance();
        const wasEnabled = envoiService.isServiceEnabled();
        envoiService.setEnabled(true);

        const results = await envoiService.searchNames(query);

        envoiService.setEnabled(wasEnabled);

        if (results && results.length > 0) {
          // Map to recipient options
          const envoiResults: RecipientOption[] = results
            .filter(
              (result, index, arr) =>
                arr.findIndex((r) => r.name === result.name) === index
            )
            .slice(0, 10)
            .map((result) => {
              const friend = friends.find((f) => f.address === result.address);
              return {
                address: result.address,
                name: result.name,
                avatar: result.avatar,
                isFriend: !!friend,
              };
            });

          // Combine friends at top, then Envoi results
          const friendResults = existingFriends.slice(0, 3).map((f) => ({
            address: f.address,
            name: f.envoiName,
            avatar: f.avatar,
            isFriend: true,
          }));

          // Deduplicate
          const allResults = [...friendResults];
          for (const result of envoiResults) {
            if (!allResults.some((r) => r.address === result.address)) {
              allResults.push(result);
            }
          }

          setSearchResults(allResults.slice(0, 10));
        }
      } catch (error) {
        console.error('Envoi search failed:', error);
      } finally {
        setIsLoading(false);
      }
    },
    [friends]
  );

  // Handle selecting a recipient
  const handleSelectRecipient = useCallback(
    (recipient: RecipientOption) => {
      navigation.replace('Chat', {
        friendAddress: recipient.address,
        friendEnvoiName: recipient.name,
      });
    },
    [navigation]
  );

  // Handle starting chat with address
  const handleStartChatWithAddress = useCallback(() => {
    const trimmedQuery = searchQuery.trim();
    if (algosdk.isValidAddress(trimmedQuery)) {
      const friend = friends.find((f) => f.address === trimmedQuery);
      navigation.replace('Chat', {
        friendAddress: trimmedQuery,
        friendEnvoiName: friend?.envoiName,
      });
    }
  }, [searchQuery, friends, navigation]);

  // Render recipient option
  const renderRecipientOption = (recipient: RecipientOption) => (
    <BlurredContainer
      key={recipient.address}
      style={styles.recipientItem}
      borderRadius={theme.borderRadius.lg}
    >
      <TouchableOpacity
        style={styles.recipientTouchable}
        onPress={() => handleSelectRecipient(recipient)}
        activeOpacity={0.7}
      >
        <View style={styles.avatarContainer}>
          {recipient.avatar ? (
            <Image source={{ uri: recipient.avatar }} style={styles.avatar} />
          ) : (
            <AccountAvatar
              address={recipient.address}
              size={44}
              useEnvoiAvatar={false}
              fallbackToGenerated
              showActiveIndicator={false}
              showRekeyIndicator={false}
            />
          )}
        </View>

        <View style={styles.recipientInfo}>
          <Text style={styles.recipientName} numberOfLines={1}>
            {recipient.name || formatAddress(recipient.address)}
          </Text>
          {recipient.name && (
            <Text style={styles.recipientAddress} numberOfLines={1}>
              {formatAddress(recipient.address)}
            </Text>
          )}
        </View>

        {recipient.isFriend && (
          <View style={[styles.friendBadge, { backgroundColor: theme.colors.primary + '20' }]}>
            <Text style={[styles.friendBadgeText, { color: theme.colors.primary }]}>
              Friend
            </Text>
          </View>
        )}

        <Ionicons
          name="chevron-forward"
          size={20}
          color={theme.colors.textMuted}
        />
      </TouchableOpacity>
    </BlurredContainer>
  );

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="New Message"
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />

        <KeyboardAvoidingView
          style={styles.content}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={100}
        >
          {/* Recipient Input */}
          <BlurredContainer style={styles.inputContainer} borderRadius={0}>
            <Text style={styles.inputLabel}>To:</Text>
            <TextInput
              style={styles.input}
              placeholder="Address or Envoi name"
              placeholderTextColor={theme.colors.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            {isLoading && (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            )}
            {searchQuery.length > 0 && !isLoading && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={20} color={theme.colors.textMuted} />
              </TouchableOpacity>
            )}
          </BlurredContainer>

          {/* Valid address action */}
          {isValidAddress && (
            <BlurredContainer style={styles.addressAction} borderRadius={0}>
              <TouchableOpacity
                style={styles.addressActionTouchable}
                onPress={handleStartChatWithAddress}
              >
                <Ionicons
                  name="chatbubble-outline"
                  size={20}
                  color={theme.colors.primary}
                />
                <Text style={styles.addressActionText}>
                  Start conversation with{' '}
                  <Text style={styles.addressActionAddress}>
                    {formatAddress(searchQuery.trim())}
                  </Text>
                </Text>
              </TouchableOpacity>
            </BlurredContainer>
          )}

          {/* Recipients List */}
          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
          >
            {!searchQuery.trim() && friends.length > 0 && (
              <Text style={styles.sectionTitle}>Friends</Text>
            )}
            {searchResults.map(renderRecipientOption)}

            {searchQuery.trim().length > 0 &&
              searchResults.length === 0 &&
              !isLoading &&
              !isValidAddress && (
                <View style={styles.emptyState}>
                  <Ionicons
                    name="search-outline"
                    size={48}
                    color={theme.colors.textMuted}
                  />
                  <Text style={styles.emptyText}>
                    No results found. Try an address or Envoi name.
                  </Text>
                </View>
              )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    content: {
      flex: 1,
    },
    inputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    inputLabel: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.textMuted,
    },
    input: {
      flex: 1,
      fontSize: 16,
      color: theme.colors.text,
    },
    addressAction: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    addressActionTouchable: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    addressActionText: {
      fontSize: 14,
      color: theme.colors.text,
    },
    addressActionAddress: {
      color: theme.colors.primary,
      fontWeight: '500',
    },
    scrollView: {
      flex: 1,
    },
    listContent: {
      padding: theme.spacing.md,
      paddingBottom: 100,
    },
    sectionTitle: {
      fontSize: 12,
      fontWeight: '600',
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      marginBottom: theme.spacing.sm,
      marginLeft: theme.spacing.xs,
    },
    recipientItem: {
      marginBottom: theme.spacing.sm,
    },
    recipientTouchable: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: theme.spacing.md,
      gap: theme.spacing.md,
    },
    avatarContainer: {
      width: 44,
      height: 44,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
    },
    recipientInfo: {
      flex: 1,
    },
    recipientName: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
    },
    recipientAddress: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 2,
    },
    friendBadge: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 2,
      borderRadius: theme.borderRadius.sm,
    },
    friendBadgeText: {
      fontSize: 11,
      fontWeight: '600',
    },
    emptyState: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xl,
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.md,
    },
  });
