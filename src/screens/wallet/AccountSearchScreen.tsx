import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import algosdk from 'algosdk';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { EnvoiService, EnvoiNameInfo } from '@/services/envoi';
import { formatAddress } from '@/utils/address';
import AccountAvatar from '@/components/account/AccountAvatar';
import { useFriendsStore } from '@/store/friendsStore';

interface SearchResult {
  address: string;
  name?: string;
  avatar?: string;
  bio?: string;
}

export default function AccountSearchScreen() {
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const handleSearch = useCallback(async (query: string) => {
    const trimmedQuery = query.trim();

    if (trimmedQuery.length === 0) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }

    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }

    setIsLoading(true);
    setHasSearched(true);

    try {
      const envoiService = EnvoiService.getInstance();

      // Check if it's a valid Algorand address (58 characters)
      if (algosdk.isValidAddress(trimmedQuery)) {
        // Search by exact address
        const nameInfo = await envoiService.getName(trimmedQuery);

        if (nameInfo) {
          setSearchResults([{
            address: nameInfo.address,
            name: nameInfo.name,
            avatar: nameInfo.avatar,
            bio: nameInfo.bio,
          }]);
        } else {
          // Valid address but no Envoi name
          setSearchResults([{
            address: trimmedQuery,
          }]);
        }
      } else {
        // Use search pattern endpoint for partial name matches
        const searchResults = await envoiService.searchNames(trimmedQuery);

        if (searchResults && searchResults.length > 0) {
          // Deduplicate by name
          const uniqueResults = searchResults.filter(
            (result, index, arr) =>
              arr.findIndex((item) => item.name === result.name) === index
          );

          // Fetch full profile info for each search result to get bio
          const resultsWithBio = await Promise.all(
            uniqueResults.slice(0, 10).map(async (result) => {
              const fullInfo = await envoiService.getName(result.address);
              return {
                address: result.address,
                name: result.name,
                avatar: result.avatar || fullInfo?.avatar,
                bio: fullInfo?.bio,
              };
            })
          );
          setSearchResults(resultsWithBio);
        } else {
          setSearchResults([]);
        }
      }
    } catch (error) {
      console.error('Search error:', error);
      setSearchResults([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Auto-search as user types (debounced)
  useEffect(() => {
    const trimmedQuery = searchQuery.trim();

    if (trimmedQuery.length === 0) {
      setSearchResults([]);
      setHasSearched(false);
      return;
    }

    if (trimmedQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    // Debounce the search
    const timeoutId = setTimeout(() => {
      handleSearch(trimmedQuery);
    }, 400);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [searchQuery, handleSearch]);

  const handleSearchSubmit = useCallback(() => {
    handleSearch(searchQuery);
  }, [searchQuery, handleSearch]);

  const addFriend = useFriendsStore((state) => state.addFriend);
  const removeFriend = useFriendsStore((state) => state.removeFriend);
  const getFriend = useFriendsStore((state) => state.getFriend);

  const handleResultPress = useCallback((result: SearchResult) => {
    // Navigate to the account profile with the selected address
    navigation.navigate('AccountInfo' as any, { address: result.address });
  }, [navigation]);

  const handleToggleFriend = useCallback(async (result: SearchResult) => {
    if (!result.name) {
      Alert.alert('Cannot Add Friend', 'This account does not have an Envoi name.');
      return;
    }

    const friend = getFriend(result.name);
    const isCurrentlyFriend = friend !== null;

    try {
      if (isCurrentlyFriend) {
        await removeFriend(result.name);
        Alert.alert('Friend Removed', `${result.name} has been removed from your friends.`);
      } else {
        await addFriend(result.name);
        Alert.alert('Friend Added', `${result.name} has been added to your friends!`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Operation failed';
      Alert.alert('Error', errorMessage);
    }
  }, [addFriend, removeFriend, getFriend]);

  const renderAvatar = (item: SearchResult) => {
    if (item.avatar) {
      return (
        <Image
          source={{ uri: item.avatar }}
          style={styles.avatar}
        />
      );
    }

    // Fallback to AccountAvatar for generated avatars
    return (
      <AccountAvatar
        address={item.address}
        size={48}
        useEnvoiAvatar={false}
        fallbackToGenerated={true}
        showActiveIndicator={false}
        showRekeyIndicator={false}
      />
    );
  };

  const renderSearchResult = useCallback(({ item }: { item: SearchResult }) => {
    const friend = item.name ? getFriend(item.name) : null;
    const isCurrentlyFriend = friend !== null;

    return (
      <View style={styles.resultCard}>
        <TouchableOpacity
          style={styles.resultItem}
          onPress={() => handleResultPress(item)}
          activeOpacity={0.7}
        >
          {renderAvatar(item)}
          <View style={styles.resultInfo}>
            {item.name && (
              <Text style={styles.resultName}>{item.name}</Text>
            )}
            <Text style={styles.resultAddress}>{formatAddress(item.address)}</Text>
            {item.bio && (
              <Text style={styles.resultBio} numberOfLines={2}>
                {item.bio}
              </Text>
            )}
          </View>
          <Ionicons name="chevron-forward" size={20} color={styles.chevron.color} />
        </TouchableOpacity>

        {item.name && (
          <TouchableOpacity
            style={[styles.friendButton, isCurrentlyFriend && styles.friendButtonRemove]}
            onPress={() => handleToggleFriend(item)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isCurrentlyFriend ? 'person-remove' : 'person-add'}
              size={18}
              color={isCurrentlyFriend ? styles.friendButtonRemoveText.color : '#FFFFFF'}
            />
            <Text
              style={[
                styles.friendButtonText,
                isCurrentlyFriend && styles.friendButtonRemoveText
              ]}
            >
              {isCurrentlyFriend ? 'Remove Friend' : 'Add to Friends'}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }, [styles, handleResultPress, handleToggleFriend, getFriend, renderAvatar]);

  const renderEmptyState = () => {
    if (isLoading) {
      return null;
    }

    if (!hasSearched) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="search" size={64} color={styles.emptyIcon.color} />
          <Text style={styles.emptyTitle}>Search for Accounts</Text>
          <Text style={styles.emptyText}>
            Enter an Algorand address or Envoi name to find users and view their profiles
          </Text>
        </View>
      );
    }

    if (searchResults.length === 0) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="alert-circle-outline" size={64} color={styles.emptyIcon.color} />
          <Text style={styles.emptyTitle}>No Results Found</Text>
          <Text style={styles.emptyText}>
            We couldn't find any accounts matching your search
          </Text>
        </View>
      );
    }

    return null;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
          >
            <Ionicons name="chevron-back" size={24} color={styles.headerText.color} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Search Accounts</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* Search Input */}
        <View style={styles.searchContainer}>
          <View style={styles.searchInputContainer}>
            <Ionicons name="search" size={20} color={styles.searchIcon.color} />
            <TextInput
              style={styles.searchInput}
              placeholder="Address or Envoi name"
              placeholderTextColor={styles.searchPlaceholder.color}
              value={searchQuery}
              onChangeText={setSearchQuery}
              onSubmitEditing={handleSearchSubmit}
              returnKeyType="search"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  setSearchQuery('');
                  setSearchResults([]);
                  setHasSearched(false);
                }}
              >
                <Ionicons name="close-circle" size={20} color={styles.searchIcon.color} />
              </TouchableOpacity>
            )}
          </View>
          <TouchableOpacity
            style={styles.searchButton}
            onPress={handleSearchSubmit}
            disabled={isLoading || searchQuery.trim().length === 0}
          >
            <Text style={styles.searchButtonText}>Search</Text>
          </TouchableOpacity>
        </View>

        {/* Results */}
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={styles.loader.color} />
            <Text style={styles.loadingText}>Searching...</Text>
          </View>
        ) : (
          <FlatList
            data={searchResults}
            renderItem={renderSearchResult}
            keyExtractor={(item) => item.name || item.address}
            contentContainerStyle={styles.resultsList}
            ListEmptyComponent={renderEmptyState}
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    keyboardAvoid: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    backButton: {
      padding: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
      textAlign: 'center',
    },
    headerSpacer: {
      width: 32,
    },
    headerText: {
      color: theme.colors.text,
    },
    searchContainer: {
      flexDirection: 'row',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    searchInputContainer: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.background,
      borderRadius: theme.borderRadius.md,
      paddingHorizontal: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    searchIcon: {
      color: theme.colors.textMuted,
    },
    searchInput: {
      flex: 1,
      height: 44,
      fontSize: 16,
      color: theme.colors.text,
    },
    searchPlaceholder: {
      color: theme.colors.textMuted,
    },
    searchButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.md,
      paddingHorizontal: theme.spacing.lg,
      justifyContent: 'center',
      alignItems: 'center',
    },
    searchButtonText: {
      color: '#FFFFFF',
      fontSize: 16,
      fontWeight: '600',
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: theme.spacing.md,
    },
    loader: {
      color: theme.colors.primary,
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    resultsList: {
      flexGrow: 1,
      paddingVertical: theme.spacing.sm,
    },
    resultCard: {
      backgroundColor: theme.colors.card,
      marginHorizontal: theme.spacing.md,
      marginVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.md,
      overflow: 'hidden',
    },
    resultItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.md,
    },
    resultInfo: {
      flex: 1,
    },
    resultName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 2,
    },
    resultAddress: {
      fontSize: 14,
      color: theme.colors.textMuted,
      fontFamily: 'monospace',
      marginBottom: 4,
    },
    resultBio: {
      fontSize: 13,
      color: theme.colors.textMuted,
      lineHeight: 18,
    },
    chevron: {
      color: theme.colors.textMuted,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.xl,
      paddingVertical: theme.spacing.xxl,
    },
    emptyIcon: {
      color: theme.colors.textMuted,
      marginBottom: theme.spacing.lg,
    },
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
    },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.background,
    },
    friendButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      marginHorizontal: theme.spacing.md,
      marginBottom: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      gap: theme.spacing.xs,
    },
    friendButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    friendButtonRemove: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: theme.colors.error,
    },
    friendButtonRemoveText: {
      color: theme.colors.error,
    },
  });
