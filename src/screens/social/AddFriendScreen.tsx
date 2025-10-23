import React, { useState, useEffect, useCallback } from 'react';
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
  Alert,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RouteProp } from '@react-navigation/native';
import algosdk from 'algosdk';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import EnvoiService, { EnvoiSearchResult } from '@/services/envoi';
import { useFriendsStore } from '@/store/friendsStore';
import { formatAddress } from '@/utils/address';
import AccountAvatar from '@/components/account/AccountAvatar';
import type { FriendsStackParamList } from '@/navigation/AppNavigator';

interface SearchResultWithStatus extends EnvoiSearchResult {
  isAlreadyFriend: boolean;
}

export default function AddFriendScreen() {
  const styles = useThemedStyles(createStyles);
  const navigation =
    useNavigation<NativeStackNavigationProp<FriendsStackParamList, 'AddFriend'>>();
  const route = useRoute<RouteProp<FriendsStackParamList, 'AddFriend'>>();
  const [searchQuery, setSearchQuery] = useState(() => route.params?.initialQuery ?? '');
  const [searchResults, setSearchResults] = useState<SearchResultWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  const addFriend = useFriendsStore((state) => state.addFriend);
  const getFriend = useFriendsStore((state) => state.getFriend);

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

    // Don't search if it's a full address
    if (algosdk.isValidAddress(trimmedQuery)) {
      setSearchResults([]);
      setHasSearched(true);
      return;
    }

    // Debounce the search
    const timeoutId = setTimeout(() => {
      handleSearch(trimmedQuery);
    }, 400);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [searchQuery]);

  const handleSearch = useCallback(async (query: string) => {
    setIsLoading(true);
    setHasSearched(true);

    try {
      const envoiService = EnvoiService.getInstance();
      const wasEnabled = envoiService.isServiceEnabled();
      envoiService.setEnabled(true);

      const results = await envoiService.searchNames(query);

      envoiService.setEnabled(wasEnabled);

      if (results && results.length > 0) {
        // Deduplicate by name
        const uniqueResults = results.filter(
          (result, index, arr) =>
            arr.findIndex((item) => item.name === result.name) === index
        );

        // Check which ones are already friends
        const resultsWithStatus = uniqueResults.slice(0, 10).map((result) => ({
          ...result,
          isAlreadyFriend: getFriend(result.name) !== null,
        }));

        setSearchResults(resultsWithStatus);
      } else {
        setSearchResults([]);
      }
    } catch (error) {
      console.error('Search error:', error);
      setSearchResults([]);
    } finally {
      setIsLoading(false);
    }
  }, [getFriend]);

  const handleAddFriend = useCallback(async (result: SearchResultWithStatus) => {
    try {
      const newFriend = await addFriend(result.name);

      Alert.alert(
        'Friend Added',
        `${result.name} has been added to your friends!`,
        [
          {
            text: 'View Profile',
            onPress: () => {
              navigation.navigate('FriendProfile', {
                envoiName: newFriend.envoiName,
              });
            },
          },
          { text: 'OK' },
        ]
      );

      // Update the search results to reflect the change
      setSearchResults(prev =>
        prev.map(r =>
          r.name === result.name ? { ...r, isAlreadyFriend: true } : r
        )
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to add friend';
      Alert.alert('Error', errorMessage);
    }
  }, [addFriend, navigation]);

  // Update search term if navigation provides an initial query (e.g., from Friends screen)
  useEffect(() => {
    const nextQuery = route.params?.initialQuery;
    if (nextQuery && nextQuery !== searchQuery) {
      setSearchQuery(nextQuery);
    }
  }, [route.params?.initialQuery, searchQuery]);

  const renderSearchResult = useCallback(({ item }: { item: SearchResultWithStatus }) => (
    <View style={styles.resultItem}>
      <View style={styles.resultContent}>
        {item.avatar ? (
          <Image source={{ uri: item.avatar }} style={styles.avatar} />
        ) : (
          <AccountAvatar
            address={item.address}
            size={48}
            useEnvoiAvatar={false}
            fallbackToGenerated={true}
            showActiveIndicator={false}
            showRekeyIndicator={false}
          />
        )}
        <View style={styles.resultInfo}>
          <Text style={styles.resultName}>{item.name}</Text>
          <Text style={styles.resultAddress}>{formatAddress(item.address)}</Text>
        </View>
      </View>

      {item.isAlreadyFriend ? (
        <View style={styles.alreadyFriendBadge}>
          <Ionicons name="checkmark-circle" size={20} color={styles.alreadyFriendIcon.color} />
          <Text style={styles.alreadyFriendText}>Friend</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => handleAddFriend(item)}
          activeOpacity={0.7}
        >
          <Ionicons name="person-add" size={20} color="#FFFFFF" />
          <Text style={styles.addButtonText}>Add</Text>
        </TouchableOpacity>
      )}
    </View>
  ), [styles, handleAddFriend]);

  const renderEmptyState = () => {
    if (isLoading) {
      return null;
    }

    if (!hasSearched) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="search" size={64} color={styles.emptyIcon.color} />
          <Text style={styles.emptyTitle}>Search for Friends</Text>
          <Text style={styles.emptyText}>
            Enter an Envoi name to find users and add them as friends
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
            No Envoi names match your search. Make sure the name is spelled correctly.
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
          <Text style={styles.headerTitle}>Add Friend</Text>
          <View style={styles.headerSpacer} />
        </View>

        {/* Search Input */}
        <View style={styles.searchContainer}>
          <View style={styles.searchInputContainer}>
            <Ionicons name="search" size={20} color={styles.searchIcon.color} />
            <TextInput
              style={styles.searchInput}
              placeholder="Enter Envoi name"
              placeholderTextColor={styles.searchPlaceholder.color}
              value={searchQuery}
              onChangeText={setSearchQuery}
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
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    searchInputContainer: {
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
    resultItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.card,
      marginHorizontal: theme.spacing.md,
      marginVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.md,
    },
    resultContent: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      gap: theme.spacing.md,
    },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.background,
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
    },
    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.primary,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      gap: theme.spacing.xs,
    },
    addButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    alreadyFriendBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
    },
    alreadyFriendIcon: {
      color: theme.colors.success,
    },
    alreadyFriendText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.success,
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
  });
