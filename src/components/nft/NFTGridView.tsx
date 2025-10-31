import React from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NFTToken } from '@/types/nft';
import { NFTService } from '@/services/nft';
import { Theme } from '@/constants/themes';

const { width } = Dimensions.get('window');
const itemSize = (width - 60) / 2;

interface NFTGridViewProps {
  nfts: NFTToken[];
  onNFTPress: (nft: NFTToken) => void;
  onNFTLongPress?: (nft: NFTToken) => void;
  theme: Theme;
  refreshing?: boolean;
  onRefresh?: () => void;
  onEndReached?: () => void;
  ListEmptyComponent?: React.ReactElement;
  ListFooterComponent?: React.ReactElement;
  processingNFTKey?: string | null;
  imageErrors?: Set<string>;
  onImageError?: (contractId: number, tokenId: string) => void;
  showOwnedBadge?: boolean;
  ownershipMap?: Set<string>;
}

export default function NFTGridView({
  nfts,
  onNFTPress,
  onNFTLongPress,
  theme,
  refreshing = false,
  onRefresh,
  onEndReached,
  ListEmptyComponent,
  ListFooterComponent,
  processingNFTKey,
  imageErrors = new Set(),
  onImageError,
  showOwnedBadge = false,
  ownershipMap = new Set(),
}: NFTGridViewProps) {
  const hasImageError = (contractId: number, tokenId: string) => {
    return imageErrors.has(`${contractId}:${tokenId}`);
  };

  const isTokenOwned = (nft: NFTToken): boolean => {
    if (!showOwnedBadge) return false;
    return NFTService.isTokenOwned(nft.contractId, nft.tokenId, ownershipMap);
  };

  const renderNFTItem = ({ item }: { item: NFTToken }) => {
    const hasError = hasImageError(item.contractId, item.tokenId);
    const showImage = NFTService.hasValidImage(item) && !hasError;
    const nftKey = `${item.contractId}:${item.tokenId}`;
    const isProcessing = processingNFTKey === nftKey;
    const owned = isTokenOwned(item);

    return (
      <TouchableOpacity
        style={[styles.nftItem, { backgroundColor: theme.colors.card }]}
        onPress={() => onNFTPress(item)}
        onLongPress={onNFTLongPress ? () => onNFTLongPress(item) : undefined}
        activeOpacity={0.8}
        disabled={isProcessing}
      >
        <View style={styles.nftImageContainer}>
          {isProcessing && (
            <View style={styles.processingOverlay}>
              <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
          )}
          {showImage ? (
            <Image
              source={{ uri: item.imageUrl! }}
              style={styles.nftImage}
              onError={() => onImageError?.(item.contractId, item.tokenId)}
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
          {owned && (
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

  return (
    <FlatList
      key="nft-grid-view"
      data={nfts}
      renderItem={renderNFTItem}
      keyExtractor={(item) => `${item.contractId}-${item.tokenId}`}
      numColumns={2}
      contentContainerStyle={nfts.length === 0 ? styles.emptyListContainer : styles.listContainer}
      columnWrapperStyle={nfts.length > 0 ? styles.row : undefined}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
          />
        ) : undefined
      }
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      ListEmptyComponent={ListEmptyComponent}
      ListFooterComponent={ListFooterComponent}
      showsVerticalScrollIndicator={false}
    />
  );
}

const styles = StyleSheet.create({
  listContainer: {
    padding: 20,
  },
  emptyListContainer: {
    flexGrow: 1,
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
  processingOverlay: {
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
});
