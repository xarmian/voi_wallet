import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Theme } from '@/constants/themes';
import { EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActiveAccount } from '@/store/walletStore';
import { NFTService } from '@/services/nft';
import { NFTToken, ARC72Collection } from '@/types/nft';
import { useTheme } from '@/contexts/ThemeContext';
import CollectionBrowser from '@/components/nft/CollectionBrowser';
import NFTGridView from '@/components/nft/NFTGridView';

interface NFTThemeSelectorProps {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
}

type TabType = 'my-nfts' | 'browse-collections';
type ViewMode = 'my-nfts' | 'browse-collections' | 'collection-tokens';

export default function NFTThemeSelector({
  visible,
  onClose,
  theme,
}: NFTThemeSelectorProps) {
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme, insets), [theme, insets]);
  const { setNFTTheme, nftThemeData } = useTheme();
  const activeAccount = useActiveAccount();

  // State management
  const [activeTab, setActiveTab] = useState<TabType>('my-nfts');
  const [viewMode, setViewMode] = useState<ViewMode>('my-nfts');

  // My NFTs data
  const [myNFTs, setMyNFTs] = useState<NFTToken[]>([]);
  const [isLoadingMyNFTs, setIsLoadingMyNFTs] = useState(true);
  const [processingNFT, setProcessingNFT] = useState<string | null>(null);

  // Collection tokens data
  const [selectedCollection, setSelectedCollection] = useState<ARC72Collection | null>(null);
  const [collectionTokens, setCollectionTokens] = useState<NFTToken[]>([]);
  const [isLoadingCollectionTokens, setIsLoadingCollectionTokens] = useState(false);
  const [ownershipMap, setOwnershipMap] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextToken, setNextToken] = useState<number | undefined>();
  const [hasMore, setHasMore] = useState(false);

  // Load my NFTs when visible and active account changes
  useEffect(() => {
    if (visible && viewMode === 'my-nfts' && activeAccount) {
      loadMyNFTs();
    }
  }, [visible, activeAccount?.address, viewMode]);

  // Reset view when tab changes
  useEffect(() => {
    if (activeTab === 'my-nfts') {
      setViewMode('my-nfts');
      setSelectedCollection(null);
    } else {
      setViewMode('browse-collections');
      setSelectedCollection(null);
    }
  }, [activeTab]);

  const loadMyNFTs = useCallback(async () => {
    if (!activeAccount) return;

    try {
      setIsLoadingMyNFTs(true);
      const response = await NFTService.fetchUserNFTs(activeAccount.address);
      const nftsWithImages = response.tokens.filter((token) =>
        NFTService.hasValidImage(token)
      );
      setMyNFTs(nftsWithImages);
    } catch (error) {
      console.error('Failed to load NFTs:', error);
      Alert.alert('Error', 'Failed to load NFTs. Please try again.');
    } finally {
      setIsLoadingMyNFTs(false);
    }
  }, [activeAccount]);

  const loadCollectionTokens = useCallback(async (reset = false) => {
    if (!selectedCollection) return;

    try {
      if (reset) {
        setIsLoadingCollectionTokens(true);
        setCollectionTokens([]);
        setNextToken(undefined);

        // Load user's NFTs for ownership check
        if (activeAccount) {
          const userNFTs = await NFTService.fetchUserNFTs(activeAccount.address);
          const ownership = NFTService.createOwnershipMap(userNFTs.tokens);
          setOwnershipMap(ownership);
        }
      } else {
        setLoadingMore(true);
      }

      const response = await NFTService.fetchTokensByCollection(
        selectedCollection.contractId,
        {
          limit: 20,
          nextToken: reset ? undefined : nextToken,
        }
      );

      if (reset) {
        setCollectionTokens(response.tokens);
      } else {
        setCollectionTokens(prev => [...prev, ...response.tokens]);
      }

      setNextToken(response.nextToken);
      setHasMore(!!response.nextToken);
    } catch (error) {
      console.error('Failed to load collection tokens:', error);
      Alert.alert('Error', 'Failed to load collection tokens. Please try again.');
    } finally {
      setIsLoadingCollectionTokens(false);
      setLoadingMore(false);
    }
  }, [selectedCollection, nextToken, activeAccount]);

  // Load collection tokens when collection is selected
  useEffect(() => {
    if (selectedCollection && viewMode === 'collection-tokens') {
      loadCollectionTokens(true);
    }
  }, [selectedCollection, viewMode]);

  const handleCollectionPress = (collection: ARC72Collection) => {
    setSelectedCollection(collection);
    setViewMode('collection-tokens');
  };

  const handleBackToCollections = () => {
    setSelectedCollection(null);
    setViewMode('browse-collections');
    setCollectionTokens([]);
    setOwnershipMap(new Set());
  };

  const handleNFTSelect = async (nft: NFTToken) => {
    if (!nft.imageUrl) {
      Alert.alert('Error', 'This NFT does not have a valid image.');
      return;
    }

    const nftKey = `${nft.contractId}:${nft.tokenId}`;
    setProcessingNFT(nftKey);

    try {
      // Pre-validate image URL
      try {
        const imageResponse = await fetch(nft.imageUrl, { method: 'HEAD' });
        if (!imageResponse.ok) {
          throw new Error('Image URL is not accessible');
        }
      } catch (fetchError) {
        console.error('Image URL validation failed:', fetchError);
        Alert.alert(
          'Error',
          'Unable to load NFT image. Please check your network connection and try another NFT.'
        );
        return;
      }

      await setNFTTheme({
        contractId: nft.contractId,
        tokenId: nft.tokenId,
        imageUrl: nft.imageUrl,
        nftName: NFTService.getDisplayName(nft),
      });
    } catch (error) {
      console.error('Failed to set NFT theme:', error);
      Alert.alert(
        'Error',
        'Failed to extract colors from NFT image. Please try another NFT.'
      );
    } finally {
      setProcessingNFT(null);
    }
  };

  const isNFTSelected = (nft: NFTToken): boolean => {
    if (!nftThemeData) return false;
    return (
      nftThemeData.contractId === nft.contractId &&
      nftThemeData.tokenId === nft.tokenId
    );
  };

  const handleLoadMore = () => {
    if (!loadingMore && hasMore && viewMode === 'collection-tokens') {
      loadCollectionTokens(false);
    }
  };

  const renderTabs = () => (
    <View style={[styles.tabContainer, { borderBottomColor: theme.colors.border }]}>
      <TouchableOpacity
        style={[
          styles.tab,
          activeTab === 'my-nfts' && [styles.activeTab, { borderBottomColor: theme.colors.primary }],
        ]}
        onPress={() => setActiveTab('my-nfts')}
      >
        <Text
          style={[
            styles.tabText,
            { color: theme.colors.text },
            activeTab === 'my-nfts' && [styles.activeTabText, { color: theme.colors.primary }],
          ]}
        >
          My NFTs
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.tab,
          activeTab === 'browse-collections' && [styles.activeTab, { borderBottomColor: theme.colors.primary }],
        ]}
        onPress={() => setActiveTab('browse-collections')}
      >
        <Text
          style={[
            styles.tabText,
            { color: theme.colors.text },
            activeTab === 'browse-collections' && [styles.activeTabText, { color: theme.colors.primary }],
          ]}
        >
          Browse Collections
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderCollectionHeader = () => {
    if (viewMode !== 'collection-tokens' || !selectedCollection) return null;

    return (
      <View style={[styles.collectionHeader, { backgroundColor: theme.colors.surface }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={handleBackToCollections}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={24} color={theme.colors.text} />
        </TouchableOpacity>
        <View style={styles.collectionHeaderInfo}>
          <Text style={[styles.collectionHeaderName, { color: theme.colors.text }]} numberOfLines={1}>
            {selectedCollection.name}
          </Text>
          <Text style={[styles.collectionHeaderSub, { color: theme.colors.textSecondary }]}>
            {selectedCollection.totalSupply.toLocaleString()} items
          </Text>
        </View>
      </View>
    );
  };

  const renderContent = () => {
    if (viewMode === 'my-nfts') {
      if (isLoadingMyNFTs) {
        return (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
              Loading NFTs...
            </Text>
          </View>
        );
      }

      // Custom rendering to show selected badge
      return (
        <NFTGridView
          nfts={myNFTs}
          onNFTPress={handleNFTSelect}
          theme={theme}
          processingNFTKey={processingNFT}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="images-outline" size={64} color={theme.colors.textMuted} />
              <Text style={[styles.emptyStateText, { color: theme.colors.textSecondary }]}>
                No NFTs with images found
              </Text>
            </View>
          }
        />
      );
    } else if (viewMode === 'browse-collections') {
      return (
        <CollectionBrowser
          theme={theme}
          onCollectionPress={handleCollectionPress}
          showSearch={true}
          searchPlaceholder="Search collections..."
        />
      );
    } else if (viewMode === 'collection-tokens') {
      if (isLoadingCollectionTokens) {
        return (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
              Loading tokens...
            </Text>
          </View>
        );
      }

      return (
        <NFTGridView
          nfts={collectionTokens}
          onNFTPress={handleNFTSelect}
          theme={theme}
          processingNFTKey={processingNFT}
          onEndReached={handleLoadMore}
          showOwnedBadge={true}
          ownershipMap={ownershipMap}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.loadingMoreContainer}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
              </View>
            ) : undefined
          }
        />
      );
    }

    return null;
  };

  return (
    <>
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={onClose}
      >
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>NFT Theme</Text>
            <View style={styles.headerActions}>
              <TouchableOpacity style={styles.closeButton} onPress={onClose}>
                <Ionicons name="close" size={24} color={theme.colors.text} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Tabs */}
          {renderTabs()}

          {/* Collection Header (Collection tokens view only) */}
          {renderCollectionHeader()}

          {/* Content */}
          {renderContent()}
        </View>
      </Modal>
    </>
  );
}

const createStyles = (theme: Theme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
      paddingTop: insets.top,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 20,
      paddingTop: 20,
      paddingBottom: 16,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    title: {
      fontSize: 24,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    closeButton: {
      padding: 4,
    },
    tabContainer: {
      flexDirection: 'row',
      marginTop: 12,
      marginHorizontal: 16,
      borderBottomWidth: 1,
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
    collectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      marginTop: 12,
    },
    backButton: {
      marginRight: 12,
    },
    collectionHeaderInfo: {
      flex: 1,
    },
    collectionHeaderName: {
      fontSize: 18,
      fontWeight: '600',
      marginBottom: 2,
    },
    collectionHeaderSub: {
      fontSize: 13,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      marginTop: 12,
      fontSize: 16,
    },
    loadingMoreContainer: {
      paddingVertical: 16,
      alignItems: 'center',
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 40,
    },
    emptyStateText: {
      fontSize: 18,
      fontWeight: '600',
      marginTop: 16,
      textAlign: 'center',
    },
  });
