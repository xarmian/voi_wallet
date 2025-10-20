import React, { useState, useEffect } from 'react';
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
import { useNavigation, CommonActions } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { useActiveAccount } from '@/store/walletStore';
import { NFTService } from '@/services/nft';
import { NFTToken } from '@/types/nft';
import { NFT_CONSTANTS, NFT_ERROR_MESSAGES } from '@/constants/nft';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { NetworkId } from '@/types/network';

const { width } = Dimensions.get('window');
const itemSize = (width - 60) / 2; // 2 columns with padding

type NetworkFilter = 'voi' | 'algorand';

export default function NFTScreen() {
  const [nfts, setNfts] = useState<NFTToken[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set());
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);
  const [isAddAccountModalVisible, setIsAddAccountModalVisible] =
    useState(false);
  const [networkFilter, setNetworkFilter] = useState<NetworkFilter>('voi');

  const navigation = useNavigation<StackNavigationProp<any>>();
  const activeAccount = useActiveAccount();
  const { theme } = useTheme();

  useEffect(() => {
    if (activeAccount) {
      loadNFTs();
    }
  }, [activeAccount?.address]);

  // Cleanup image error tracking on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      setImageErrors(new Set());
    };
  }, []);

  const loadNFTs = async () => {
    if (!activeAccount) return;

    try {
      setIsLoading(true);
      const response = await NFTService.fetchUserNFTs(activeAccount.address);
      // Add networkId to each NFT token (currently all are Voi)
      const tokensWithNetwork = response.tokens.map(token => ({
        ...token,
        networkId: NetworkId.VOI_MAINNET, // All ARC-72 tokens are currently on Voi
      }));
      setNfts(tokensWithNetwork);
    } catch (error) {
      console.error('Failed to load NFTs:', error);
      const errorMessage =
        error instanceof Error
          ? error.message
          : NFT_ERROR_MESSAGES.FETCH_FAILED;
      Alert.alert('Error', errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await loadNFTs();
    setRefreshing(false);
  };

  const handleNFTPress = (nft: NFTToken) => {
    navigation.navigate('NFTDetail', { nft });
  };

  const handleImageError = (contractId: number, tokenId: string) => {
    const key = `${contractId}:${tokenId}`;
    setImageErrors((prev) => {
      const newSet = new Set(prev);
      newSet.add(key);

      // Prevent memory leaks by limiting cache size
      if (newSet.size > NFT_CONSTANTS.MAX_IMAGE_CACHE_SIZE) {
        const iterator = newSet.values();
        iterator.next(); // Remove first (oldest) entry
        newSet.delete(iterator.next().value);
      }

      return newSet;
    });
  };

  const hasImageError = (contractId: number, tokenId: string) => {
    const key = `${contractId}:${tokenId}`;
    return imageErrors.has(key);
  };

  const handleAccountSelectorPress = () => {
    setIsAccountModalVisible(true);
  };

  const handleAccountModalClose = () => {
    setIsAccountModalVisible(false);
  };

  const handleAddAccount = () => {
    setIsAccountModalVisible(false);
    setIsAddAccountModalVisible(true);
  };

  // Filter NFTs based on selected network
  const filteredNfts = nfts.filter(nft => {
    if (networkFilter === 'voi') {
      return nft.networkId?.includes('voi') ?? true; // Default to Voi if no networkId
    } else if (networkFilter === 'algorand') {
      return nft.networkId?.includes('algorand') ?? false;
    }
    return true;
  });

  const renderNetworkTabs = () => (
    <View style={styles.networkTabsContainer}>
      <TouchableOpacity
        style={[
          styles.networkTab,
          networkFilter === 'voi' && styles.networkTabActive,
        ]}
        onPress={() => setNetworkFilter('voi')}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.networkTabText,
            networkFilter === 'voi' && styles.networkTabTextActive,
          ]}
        >
          Voi
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.networkTab,
          styles.networkTabDisabled,
          networkFilter === 'algorand' && styles.networkTabActive,
        ]}
        disabled={true}
        activeOpacity={0.7}
      >
        <Text
          style={[
            styles.networkTabText,
            styles.networkTabTextDisabled,
            networkFilter === 'algorand' && styles.networkTabTextActive,
          ]}
        >
          Algorand
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderNFTItem = ({ item }: { item: NFTToken }) => {
    const hasError = hasImageError(item.contractId, item.tokenId);
    const showImage = NFTService.hasValidImage(item) && !hasError;

    return (
      <TouchableOpacity
        style={[styles.nftItem, { backgroundColor: theme.colors.card }]}
        onPress={() => handleNFTPress(item)}
        activeOpacity={0.8}
      >
        <View style={styles.nftImageContainer}>
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
    const isAlgorandTab = networkFilter === 'algorand';
    return (
      <View style={styles.emptyContainer}>
        <Ionicons
          name="images-outline"
          size={64}
          color={theme.colors.textSecondary}
        />
        <Text style={[styles.emptyTitle, { color: theme.colors.text }]}>
          No NFTs Found
        </Text>
        <Text
          style={[styles.emptySubtitle, { color: theme.colors.textSecondary }]}
        >
          {isAlgorandTab
            ? 'Algorand NFT support coming soon'
            : 'Your NFT collection will appear here when you have ARC-72 tokens'}
        </Text>
      </View>
    );
  };

  const renderLoadingState = () => (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
        Loading your NFTs...
      </Text>
    </View>
  );

  if (isLoading) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        edges={['top']}
      >
        <UniversalHeader
          title="My NFTs"
          subtitle="Your ARC-72 NFT Collection"
          onAccountSelectorPress={handleAccountSelectorPress}
        />
        {renderLoadingState()}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top']}
    >
      <UniversalHeader
        title="My NFTs"
        subtitle={`${filteredNfts.length} NFT${filteredNfts.length !== 1 ? 's' : ''} found`}
        onAccountSelectorPress={handleAccountSelectorPress}
      />

      {renderNetworkTabs()}

      <FlatList
        data={filteredNfts}
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
        ListEmptyComponent={renderEmptyState}
        showsVerticalScrollIndicator={false}
      />

      <AccountListModal
        isVisible={isAccountModalVisible}
        onClose={handleAccountModalClose}
        onAddAccount={handleAddAccount}
      />

      {/* Add Account Modal */}
      <AddAccountModal
        isVisible={isAddAccountModalVisible}
        onClose={() => setIsAddAccountModalVisible(false)}
        onCreateAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.dispatch(
            CommonActions.navigate({
              name: 'Settings',
              params: {
                screen: 'CreateAccount',
              },
            })
          );
        }}
        onImportAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.dispatch(
            CommonActions.navigate({
              name: 'Settings',
              params: {
                screen: 'MnemonicImport',
              },
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
          navigation.navigate(
            'Settings' as never,
            { screen: 'AddWatchAccount' } as never
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  networkTabsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 8,
  },
  networkTab: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#ccc',
  },
  networkTabActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  networkTabDisabled: {
    opacity: 0.4,
  },
  networkTabText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#666',
  },
  networkTabTextActive: {
    color: '#fff',
  },
  networkTabTextDisabled: {
    color: '#999',
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
});
