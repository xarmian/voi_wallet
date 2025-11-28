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
import { NFTBackground } from '@/components/common/NFTBackground';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { GlassButton } from '@/components/common/GlassButton';

interface SearchResultWithStatus extends EnvoiSearchResult {
  isAlreadyFriend: boolean;
}

export default function AddFriendScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
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

  // Update search term if navigation provides an initial query
  useEffect(() => {
    const nextQuery = route.params?.initialQuery;
    if (nextQuery && nextQuery !== searchQuery) {
      setSearchQuery(nextQuery);
    }
  }, [route.params?.initialQuery, searchQuery]);

  const renderSearchResult = (item: SearchResultWithStatus) => (
    <BlurredContainer
      key={item.name || item.address}
      style={styles.resultItem}
      borderRadius={theme.borderRadius.lg}
    >
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
          <Ionicons name="checkmark-circle" size={20} color={theme.colors.success} />
          <Text style={styles.alreadyFriendText}>Friend</Text>
        </View>
      ) : (
        <GlassButton
          variant="primary"
          size="sm"
          label="Add"
          icon="person-add"
          onPress={() => handleAddFriend(item)}
        />
      )}
    </BlurredContainer>
  );

  const renderEmptyState = () => {
    if (isLoading) {
      return null;
    }

    if (!hasSearched) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="search" size={64} color={theme.colors.textMuted} />
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
          <Ionicons name="alert-circle-outline" size={64} color={theme.colors.textMuted} />
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
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <KeyboardAvoidingView
          style={styles.keyboardAvoid}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <UniversalHeader
            title="Add Friend"
            showBackButton
            onBackPress={() => navigation.goBack()}
            showAccountSelector={false}
            onAccountSelectorPress={() => {}}
          />

          {/* Search Input */}
          <BlurredContainer
            style={styles.searchContainer}
            borderRadius={0}
          >
            <View style={styles.searchInputContainer}>
              <Ionicons name="search" size={20} color={theme.colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                placeholder="Enter Envoi name"
                placeholderTextColor={theme.colors.textMuted}
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
                  <Ionicons name="close-circle" size={20} color={theme.colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </BlurredContainer>

          {/* Results */}
          {isLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={theme.colors.primary} />
              <Text style={styles.loadingText}>Searching...</Text>
            </View>
          ) : (
            <ScrollView
              contentContainerStyle={styles.resultsList}
              keyboardShouldPersistTaps="handled"
            >
              {searchResults.length === 0 ? (
                renderEmptyState()
              ) : (
                searchResults.map(renderSearchResult)
              )}
            </ScrollView>
          )}
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
    keyboardAvoid: {
      flex: 1,
    },
    searchContainer: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.glassBackground,
      borderRadius: theme.borderRadius.sm,
      paddingHorizontal: theme.spacing.sm,
      gap: theme.spacing.sm,
    },
    searchInput: {
      flex: 1,
      height: 44,
      fontSize: 16,
      color: theme.colors.text,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    resultsList: {
      flexGrow: 1,
      padding: theme.spacing.sm,
    },
    resultItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
    },
    resultContent: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      gap: theme.spacing.sm,
    },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.glassBackground,
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
    alreadyFriendBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
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
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.lg,
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
