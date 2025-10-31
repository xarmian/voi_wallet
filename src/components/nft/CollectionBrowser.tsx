import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ARC72Collection } from '@/types/nft';
import { NFTService } from '@/services/nft';
import { Theme } from '@/constants/themes';
import CollectionListItem from '@/components/common/CollectionListItem';

interface CollectionBrowserProps {
  theme: Theme;
  onCollectionPress: (collection: ARC72Collection) => void;
  showSearch?: boolean;
  searchPlaceholder?: string;
}

export default function CollectionBrowser({
  theme,
  onCollectionPress,
  showSearch = true,
  searchPlaceholder = 'Search collections...',
}: CollectionBrowserProps) {
  const [collections, setCollections] = useState<ARC72Collection[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Load collections when search changes
  useEffect(() => {
    loadCollections(true);
  }, [debouncedSearchQuery]);

  const loadCollections = useCallback(
    async (reset = false) => {
      try {
        if (reset) {
          setIsLoading(true);
          setCollections([]);
          setNextToken(undefined);
          setHasMore(false);
        } else {
          setLoadingMore(true);
        }

        const response = await NFTService.fetchCollections({
          name: debouncedSearchQuery || undefined,
          blacklisted: false,
          limit: 20,
          nextToken: reset ? undefined : nextToken,
        });

        // Filter out collections with zero items or no name
        const nonEmptyCollections = response.collections.filter(
          (collection) => collection.totalSupply > 0 && collection.name !== null
        );

        if (reset) {
          setCollections(nonEmptyCollections);
        } else {
          // Use a Set to prevent duplicates when paginating
          setCollections((prev) => {
            const existingIds = new Set(prev.map((c) => c.contractId));
            const newCollections = nonEmptyCollections.filter(
              (c) => !existingIds.has(c.contractId)
            );
            return [...prev, ...newCollections];
          });
        }

        setNextToken(response.nextToken);
        setHasMore(!!response.nextToken);
      } catch (error) {
        console.error('Failed to load collections:', error);
      } finally {
        setIsLoading(false);
        setLoadingMore(false);
      }
    },
    [debouncedSearchQuery, nextToken]
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadCollections(true);
    setRefreshing(false);
  };

  const handleLoadMore = () => {
    if (!loadingMore && hasMore) {
      loadCollections(false);
    }
  };

  const renderSearchBar = () => {
    if (!showSearch) return null;

    return (
      <View style={[styles.searchContainer, { backgroundColor: theme.colors.card }]}>
        <Ionicons name="search" size={20} color={theme.colors.textMuted} />
        <TextInput
          style={[styles.searchInput, { color: theme.colors.text }]}
          placeholder={searchPlaceholder}
          placeholderTextColor={theme.colors.placeholder}
          value={searchQuery}
          onChangeText={setSearchQuery}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <Ionicons
        name={searchQuery ? 'search-outline' : 'images-outline'}
        size={64}
        color={theme.colors.textSecondary}
      />
      <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
        {searchQuery ? 'No collections found' : 'Search Collections'}
      </Text>
      <Text style={[styles.emptySubtitle, { color: theme.colors.textSecondary }]}>
        {searchQuery
          ? 'Try a different search term'
          : 'Search to discover verified NFT collections on Voi Network'}
      </Text>
    </View>
  );

  if (isLoading) {
    return (
      <>
        {renderSearchBar()}
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
            Loading collections...
          </Text>
        </View>
      </>
    );
  }

  return (
    <>
      {renderSearchBar()}
      <FlatList
        key="collections-browser"
        data={collections}
        renderItem={({ item }) => (
          <CollectionListItem collection={item} onPress={onCollectionPress} />
        )}
        keyExtractor={(item) => item.contractId.toString()}
        contentContainerStyle={
          collections.length === 0 ? styles.emptyListContainer : styles.listContainer
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        }
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={renderEmptyState}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.loadingMoreContainer}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
          ) : null
        }
        showsVerticalScrollIndicator={false}
      />
    </>
  );
}

const styles = StyleSheet.create({
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    padding: 0,
  },
  listContainer: {
    paddingTop: 8,
    paddingBottom: 20,
  },
  emptyListContainer: {
    flexGrow: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingTop: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 16,
    marginTop: 16,
  },
  loadingMoreContainer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
});
