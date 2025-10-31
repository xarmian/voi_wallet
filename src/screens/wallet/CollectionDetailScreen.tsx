import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Image,
  Dimensions,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useActiveAccount } from '@/store/walletStore';
import { NFTService } from '@/services/nft';
import { NFTToken, ARC72Collection } from '@/types/nft';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';

const { width } = Dimensions.get('window');
const itemSize = (width - 60) / 2; // 2 columns with padding

type TabType = 'my-nfts' | 'all-nfts';

interface CollectionDetailRouteParams {
  collection: ARC72Collection;
}

export default function CollectionDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation<StackNavigationProp<any>>();
  const { collection } = route.params as CollectionDetailRouteParams;
  const activeAccount = useActiveAccount();
  const { theme, setNFTTheme } = useTheme();

  // State
  const [activeTab, setActiveTab] = useState<TabType>('my-nfts');
  const [allTokens, setAllTokens] = useState<NFTToken[]>([]);
  const [myTokens, setMyTokens] = useState<NFTToken[]>([]);
  const [ownershipMap, setOwnershipMap] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [hasMore, setHasMore] = useState(false);
  const [settingThemeNFT, setSettingThemeNFT] = useState<string | null>(null);
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    setIsLoading(true);
    await Promise.all([loadUserNFTs(), loadCollectionTokens(true)]);
    setIsLoading(false);
  };

  const loadUserNFTs = useCallback(async () => {
    if (!activeAccount) {
      setMyTokens([]);
      setOwnershipMap(new Set());
      return;
    }

    try {
      const response = await NFTService.fetchUserNFTs(activeAccount.address);
      // Filter to only NFTs from this collection
      const collectionNFTs = response.tokens.filter(
        (token) => token.contractId === collection.contractId
      );
      setMyTokens(collectionNFTs);

      // Create ownership map for all user's NFTs
      const ownership = NFTService.createOwnershipMap(response.tokens);
      setOwnershipMap(ownership);
    } catch (error) {
      console.error('Failed to load user NFTs:', error);
    }
  }, [activeAccount, collection.contractId]);

  const loadCollectionTokens = useCallback(
    async (reset = false) => {
      try {
        if (reset) {
          setNextToken(undefined);
          setAllTokens([]);
        } else {
          setLoadingMore(true);
        }

        const response = await NFTService.fetchTokensByCollection(
          collection.contractId,
          {
            limit: 50,
            nextToken: reset ? undefined : nextToken,
          }
        );

        if (reset) {
          setAllTokens(response.tokens);
        } else {
          setAllTokens((prev) => [...prev, ...response.tokens]);
        }

        setNextToken(response.nextToken);
        setHasMore(!!response.nextToken);
      } catch (error) {
        console.error('Failed to load collection tokens:', error);
        Alert.alert('Error', 'Failed to load collection tokens. Please try again.');
      } finally {
        setLoadingMore(false);
      }
    },
    [collection.contractId, nextToken]
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadInitialData();
    setRefreshing(false);
  };

  const handleLoadMore = () => {
    if (!loadingMore && hasMore && activeTab === 'all-nfts') {
      loadCollectionTokens(false);
    }
  };

  const handleNFTPress = (nft: NFTToken) => {
    navigation.navigate('NFTDetail', { nft });
  };

  const handleNFTPressLong = async (nft: NFTToken) => {
    if (!NFTService.hasValidImage(nft) || !nft.imageUrl) {
      Alert.alert('Cannot Set Theme', 'This NFT does not have a valid image.');
      return;
    }

    const nftKey = `${nft.contractId}:${nft.tokenId}`;
    setSettingThemeNFT(nftKey);

    try {
      await setNFTTheme({
        contractId: nft.contractId,
        tokenId: nft.tokenId,
        imageUrl: nft.imageUrl,
        nftName: NFTService.getDisplayName(nft),
      });
      Alert.alert('Success', 'Theme has been set successfully!');
    } catch (error) {
      console.error('Failed to set NFT theme:', error);
      Alert.alert(
        'Error',
        'Failed to extract colors from NFT image. Please try another NFT.'
      );
    } finally {
      setSettingThemeNFT(null);
    }
  };

  const handleImageError = (contractId: number, tokenId: string) => {
    const key = `${contractId}:${tokenId}`;
    setImageErrors((prev) => new Set(prev).add(key));
  };

  const hasImageError = (contractId: number, tokenId: string) => {
    const key = `${contractId}:${tokenId}`;
    return imageErrors.has(key);
  };

  const isTokenOwned = (nft: NFTToken): boolean => {
    return NFTService.isTokenOwned(nft.contractId, nft.tokenId, ownershipMap);
  };

  const displayTokens = activeTab === 'my-nfts' ? myTokens : allTokens;

  const renderTabs = () => (
    <View style={styles.tabContainer}>
      <TouchableOpacity
        style={[
          styles.tab,
          activeTab === 'my-nfts' && [
            styles.activeTab,
            { borderBottomColor: theme.colors.primary },
          ],
        ]}
        onPress={() => setActiveTab('my-nfts')}
      >
        <Text
          style={[
            styles.tabText,
            { color: theme.colors.text },
            activeTab === 'my-nfts' && [
              styles.activeTabText,
              { color: theme.colors.primary },
            ],
          ]}
        >
          My NFTs ({myTokens.length})
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.tab,
          activeTab === 'all-nfts' && [
            styles.activeTab,
            { borderBottomColor: theme.colors.primary },
          ],
        ]}
        onPress={() => setActiveTab('all-nfts')}
      >
        <Text
          style={[
            styles.tabText,
            { color: theme.colors.text },
            activeTab === 'all-nfts' && [
              styles.activeTabText,
              { color: theme.colors.primary },
            ],
          ]}
        >
          All NFTs ({collection.totalSupply.toLocaleString()})
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderNFTItem = ({ item }: { item: NFTToken }) => {
    const hasError = hasImageError(item.contractId, item.tokenId);
    const showImage = NFTService.hasValidImage(item) && !hasError;
    const nftKey = `${item.contractId}:${item.tokenId}`;
    const isSettingTheme = settingThemeNFT === nftKey;
    const owned = isTokenOwned(item);

    return (
      <TouchableOpacity
        style={[styles.nftItem, { backgroundColor: theme.colors.card }]}
        onPress={() => handleNFTPress(item)}
        onLongPress={() => handleNFTPressLong(item)}
        activeOpacity={0.8}
        disabled={isSettingTheme}
      >
        <View style={styles.nftImageContainer}>
          {isSettingTheme && (
            <View style={styles.settingThemeOverlay}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
          )}
          {showImage ? (
            <Image
              source={{ uri: item.imageUrl! }}
              style={styles.nftImage}
              onError={() => handleImageError(item.contractId, item.tokenId)}
            />
          ) : (
            <View
              style={[
                styles.placeholderImage,
                { backgroundColor: theme.colors.background },
              ]}
            >
              <Ionicons
                name="image-outline"
                size={32}
                color={theme.colors.textSecondary}
              />
            </View>
          )}
          {owned && activeTab === 'all-nfts' && (
            <View style={[styles.ownedBadge, { backgroundColor: theme.colors.background }]}>
              <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
            </View>
          )}
        </View>
        <View style={styles.nftInfo}>
          <Text
            style={[styles.nftName, { color: theme.colors.text }]}
            numberOfLines={2}
          >
            {NFTService.getDisplayName(item)}
          </Text>
          <Text
            style={[styles.nftContract, { color: theme.colors.textSecondary }]}
            numberOfLines={1}
          >
            #{item.tokenId}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderEmptyState = () => {
    const isMyNFTs = activeTab === 'my-nfts';
    return (
      <View style={styles.emptyContainer}>
        <Ionicons
          name="images-outline"
          size={64}
          color={theme.colors.textSecondary}
        />
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
          {isMyNFTs ? 'No NFTs Owned' : 'No NFTs Found'}
        </Text>
        <Text style={[styles.emptySubtitle, { color: theme.colors.textSecondary }]}>
          {isMyNFTs
            ? 'You don\'t own any NFTs from this collection yet'
            : 'This collection appears to be empty'}
        </Text>
      </View>
    );
  };

  const renderLoadingState = () => (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
        Loading NFTs...
      </Text>
    </View>
  );

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top']}
    >
      <UniversalHeader
        title={collection.name}
        subtitle={`${collection.totalSupply.toLocaleString()} items • ${collection.uniqueOwners.toLocaleString()} owners`}
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
        showBackButton={true}
        onBackPress={() => navigation.goBack()}
      />

      {renderTabs()}

      {isLoading ? (
        renderLoadingState()
      ) : (
        <FlatList
          data={displayTokens}
          renderItem={renderNFTItem}
          keyExtractor={(item) => `${item.contractId}-${item.tokenId}`}
          numColumns={2}
          contentContainerStyle={styles.listContainer}
          columnWrapperStyle={styles.row}
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
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  tabContainer: {
    flexDirection: 'row',
    marginTop: 12,
    marginHorizontal: 16,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomWidth: 2,
  },
  tabText: {
    fontSize: 16,
    fontWeight: '500',
  },
  activeTabText: {
    fontWeight: '600',
  },
  listContainer: {
    flexGrow: 1,
    padding: 20,
  },
  row: {
    justifyContent: 'space-between',
  },
  nftItem: {
    borderRadius: 12,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    width: itemSize,
  },
  nftImageContainer: {
    width: '100%',
    height: itemSize,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  nftImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  placeholderImage: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  settingThemeOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  ownedBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    borderRadius: 10,
    padding: 2,
  },
  nftInfo: {
    padding: 12,
  },
  nftName: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
    lineHeight: 18,
  },
  nftContract: {
    fontSize: 12,
    fontFamily: 'monospace',
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
