import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, CommonActions } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useActiveAccount } from '@/store/walletStore';
import { NFTService } from '@/services/nft';
import { ARC72Collection, NFTToken } from '@/types/nft';
import { NFT_CONSTANTS } from '@/constants/nft';
import UniversalHeader from '@/components/common/UniversalHeader';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import NFTGridView from '@/components/nft/NFTGridView';
import CollectionBrowser from '@/components/nft/CollectionBrowser';
import { useTheme } from '@/contexts/ThemeContext';
import { NetworkId } from '@/types/network';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import { springConfigs } from '@/utils/animations';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type TabType = 'my-nfts' | 'browse-collections';
type ViewMode = 'my-nfts' | 'browse-collections' | 'collection-tokens';

export default function NFTScreen() {
  const navigation = useNavigation<StackNavigationProp<any>>();
  const activeAccount = useActiveAccount();
  const { theme, setNFTTheme } = useTheme();

  // Tab and view state
  const [activeTab, setActiveTab] = useState<TabType>('my-nfts');
  const [viewMode, setViewMode] = useState<ViewMode>('my-nfts');

  // My NFTs state
  const [myNFTs, setMyNFTs] = useState<NFTToken[]>([]);
  const [isLoadingMyNFTs, setIsLoadingMyNFTs] = useState(true);
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());
  const [settingThemeNFT, setSettingThemeNFT] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Collection tokens state
  const [selectedCollection, setSelectedCollection] = useState<ARC72Collection | null>(null);
  const [collectionTokens, setCollectionTokens] = useState<NFTToken[]>([]);
  const [isLoadingCollectionTokens, setIsLoadingCollectionTokens] = useState(false);
  const [ownershipMap, setOwnershipMap] = useState<Set<string>>(new Set());
  const [loadingMoreTokens, setLoadingMoreTokens] = useState(false);
  const [nextTokensToken, setNextTokensToken] = useState<number | undefined>();
  const [hasMoreTokens, setHasMoreTokens] = useState(false);

  // Modals
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);
  const [isAddAccountModalVisible, setIsAddAccountModalVisible] = useState(false);

  // Load my NFTs on mount
  useEffect(() => {
    if (activeAccount && viewMode === 'my-nfts') {
      loadMyNFTs();
    }
  }, [activeAccount?.address, viewMode]);

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

  // Load collection tokens when collection is selected
  useEffect(() => {
    if (selectedCollection && viewMode === 'collection-tokens') {
      loadCollectionTokens(true);
    }
  }, [selectedCollection, viewMode]);

  const loadMyNFTs = useCallback(async () => {
    if (!activeAccount) return;

    try {
      setIsLoadingMyNFTs(true);
      const response = await NFTService.fetchUserNFTs(activeAccount.address);
      const tokensWithNetwork = response.tokens.map((token) => ({
        ...token,
        networkId: NetworkId.VOI_MAINNET,
      }));
      setMyNFTs(tokensWithNetwork);
    } catch (error) {
      console.error('Failed to load NFTs:', error);
      Alert.alert('Error', 'Failed to load your NFTs. Please try again.');
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
        setNextTokensToken(undefined);

        // Load user's NFTs for ownership check
        if (activeAccount) {
          const userNFTs = await NFTService.fetchUserNFTs(activeAccount.address);
          const ownership = NFTService.createOwnershipMap(userNFTs.tokens);
          setOwnershipMap(ownership);
        }
      } else {
        setLoadingMoreTokens(true);
      }

      const response = await NFTService.fetchTokensByCollection(
        selectedCollection.contractId,
        {
          limit: 20,
          nextToken: reset ? undefined : nextTokensToken,
        }
      );

      if (reset) {
        setCollectionTokens(response.tokens);
      } else {
        setCollectionTokens(prev => [...prev, ...response.tokens]);
      }

      setNextTokensToken(response.nextToken);
      setHasMoreTokens(!!response.nextToken);
    } catch (error) {
      console.error('Failed to load collection tokens:', error);
      Alert.alert('Error', 'Failed to load collection tokens. Please try again.');
    } finally {
      setIsLoadingCollectionTokens(false);
      setLoadingMoreTokens(false);
    }
  }, [selectedCollection, nextTokensToken, activeAccount]);

  const onRefresh = async () => {
    setRefreshing(true);
    if (viewMode === 'my-nfts') {
      await loadMyNFTs();
    } else if (viewMode === 'collection-tokens') {
      await loadCollectionTokens(true);
    }
    setRefreshing(false);
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

  const handleLoadMoreTokens = () => {
    if (!loadingMoreTokens && hasMoreTokens && viewMode === 'collection-tokens') {
      loadCollectionTokens(false);
    }
  };

  const handleImageError = (contractId: number, tokenId: string) => {
    const key = `${contractId}:${tokenId}`;
    setImageErrors((prev) => {
      const newSet = new Set(prev);
      newSet.add(key);
      if (newSet.size > NFT_CONSTANTS.MAX_IMAGE_CACHE_SIZE) {
        const iterator = newSet.values();
        iterator.next();
        newSet.delete(iterator.next().value);
      }
      return newSet;
    });
  };

  const renderTabs = () => (
    <View style={styles.tabContainer}>
      <GlassCard variant="light" style={styles.tabCard} padding="none">
        <View style={styles.tabInner}>
          <Pressable
            style={[
              styles.tab,
              activeTab === 'my-nfts' && {
                backgroundColor: `${theme.colors.primary}20`,
              },
            ]}
            onPress={() => setActiveTab('my-nfts')}
          >
            <Ionicons
              name="wallet-outline"
              size={18}
              color={activeTab === 'my-nfts' ? theme.colors.primary : theme.colors.textMuted}
              style={{ marginRight: 6 }}
            />
            <Text
              style={[
                styles.tabText,
                { color: activeTab === 'my-nfts' ? theme.colors.primary : theme.colors.text },
                activeTab === 'my-nfts' && styles.activeTabText,
              ]}
            >
              My NFTs
            </Text>
          </Pressable>
          <Pressable
            style={[
              styles.tab,
              activeTab === 'browse-collections' && {
                backgroundColor: `${theme.colors.primary}20`,
              },
            ]}
            onPress={() => setActiveTab('browse-collections')}
          >
            <Ionicons
              name="grid-outline"
              size={18}
              color={activeTab === 'browse-collections' ? theme.colors.primary : theme.colors.textMuted}
              style={{ marginRight: 6 }}
            />
            <Text
              style={[
                styles.tabText,
                { color: activeTab === 'browse-collections' ? theme.colors.primary : theme.colors.text },
                activeTab === 'browse-collections' && styles.activeTabText,
              ]}
            >
              Collections
            </Text>
          </Pressable>
        </View>
      </GlassCard>
    </View>
  );

  const renderCollectionHeader = () => {
    if (viewMode !== 'collection-tokens' || !selectedCollection) return null;

    return (
      <View style={styles.collectionHeaderContainer}>
        <GlassCard variant="medium" style={styles.collectionHeader} padding="none">
          <View style={styles.collectionHeaderContent}>
            <Pressable
              style={[
                styles.backButton,
                { backgroundColor: theme.colors.glassBackground },
              ]}
              onPress={handleBackToCollections}
            >
              <Ionicons name="chevron-back" size={20} color={theme.colors.text} />
            </Pressable>
            <View style={styles.collectionHeaderInfo}>
              <Text style={[styles.collectionHeaderName, { color: theme.colors.text }]} numberOfLines={1}>
                {selectedCollection.name}
              </Text>
              <Text style={[styles.collectionHeaderSub, { color: theme.colors.textSecondary }]}>
                {selectedCollection.totalSupply.toLocaleString()} items
              </Text>
            </View>
          </View>
        </GlassCard>
      </View>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <GlassCard variant="light" style={styles.emptyCard}>
        <View
          style={[
            styles.emptyIconContainer,
            { backgroundColor: `${theme.colors.primary}15` },
          ]}
        >
          <Ionicons
            name="images-outline"
            size={48}
            color={theme.colors.primary}
          />
        </View>
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
          No NFTs Found
        </Text>
        <Text style={[styles.emptySubtitle, { color: theme.colors.textSecondary }]}>
          Your NFT collection will appear here when you have ARC-72 tokens
        </Text>
      </GlassCard>
    </View>
  );

  const renderContent = () => {
    if (viewMode === 'my-nfts') {
      if (isLoadingMyNFTs) {
        return (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
              Loading your NFTs...
            </Text>
          </View>
        );
      }

      return (
        <NFTGridView
          nfts={myNFTs}
          onNFTPress={handleNFTPress}
          onNFTLongPress={handleNFTPressLong}
          theme={theme}
          refreshing={refreshing}
          onRefresh={onRefresh}
          ListEmptyComponent={renderEmptyState()}
          processingNFTKey={settingThemeNFT}
          imageErrors={imageErrors}
          onImageError={handleImageError}
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
          onNFTPress={handleNFTPress}
          onNFTLongPress={handleNFTPressLong}
          theme={theme}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onEndReached={handleLoadMoreTokens}
          processingNFTKey={settingThemeNFT}
          imageErrors={imageErrors}
          onImageError={handleImageError}
          showOwnedBadge={true}
          ownershipMap={ownershipMap}
          ListFooterComponent={
            loadingMoreTokens ? (
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
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="NFTs"
          subtitle={
            viewMode === 'my-nfts'
              ? `${myNFTs.length} NFT${myNFTs.length !== 1 ? 's' : ''}`
              : viewMode === 'collection-tokens' && selectedCollection
              ? selectedCollection.name
              : 'Browse Collections'
          }
          onAccountSelectorPress={() => setIsAccountModalVisible(true)}
          showAccountSelector={activeTab === 'my-nfts'}
        />

        {renderTabs()}
        {renderCollectionHeader()}
        {renderContent()}

        <AccountListModal
          isVisible={isAccountModalVisible}
          onClose={() => setIsAccountModalVisible(false)}
          onAddAccount={() => {
            setIsAccountModalVisible(false);
            setIsAddAccountModalVisible(true);
          }}
        />

        <AddAccountModal
          isVisible={isAddAccountModalVisible}
          onClose={() => setIsAddAccountModalVisible(false)}
          onCreateAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.dispatch(
              CommonActions.navigate({
                name: 'Settings',
                params: { screen: 'CreateAccount' },
              })
            );
          }}
          onImportAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.dispatch(
              CommonActions.navigate({
                name: 'Settings',
                params: { screen: 'MnemonicImport' },
              })
            );
          }}
          onImportLedgerAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.navigate('LedgerAccountImport' as never);
          }}
          onImportQRAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.navigate('QRAccountImport' as never);
          }}
          onAddWatchAccount={() => {
            setIsAddAccountModalVisible(false);
            navigation.navigate('Settings' as never, { screen: 'AddWatchAccount' } as never);
          }}
        />
      </SafeAreaView>
    </NFTBackground>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  tabContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  tabCard: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  tabInner: {
    flexDirection: 'row',
    padding: 4,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
  },
  activeTabText: {
    fontWeight: '600',
  },
  collectionHeaderContainer: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  collectionHeader: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  collectionHeaderContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  collectionHeaderInfo: {
    flex: 1,
  },
  collectionHeaderName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 2,
  },
  collectionHeaderSub: {
    fontSize: 12,
  },
  loadingMoreContainer: {
    paddingVertical: 16,
    alignItems: 'center',
  },
  emptyContainer: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 24,
  },
  emptyCard: {
    alignItems: 'center',
    padding: 32,
    borderRadius: 24,
  },
  emptyIconContainer: {
    width: 80,
    height: 80,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
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
});
