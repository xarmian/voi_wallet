import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  FlatList,
  Image,
  ActivityIndicator,
  Alert,
  Dimensions,
  Switch,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Theme } from '@/constants/themes';
import { EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useActiveAccount } from '@/store/walletStore';
import { NFTService } from '@/services/nft';
import { NFTToken } from '@/types/nft';
import { useTheme } from '@/contexts/ThemeContext';

const { width } = Dimensions.get('window');
const NFT_ITEM_SIZE = (width - 60) / 2; // 2 columns with padding

interface NFTThemeSelectorProps {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
}

interface NFTItemProps {
  nft: NFTToken;
  isSelected: boolean;
  isLoading: boolean;
  onSelect: (nft: NFTToken) => void;
  theme: Theme;
  styles: ReturnType<typeof createStyles>;
}

const NFTItem: React.FC<NFTItemProps> = ({
  nft,
  isSelected,
  isLoading,
  onSelect,
  theme,
  styles,
}) => {
  const hasValidImage = NFTService.hasValidImage(nft);
  const displayName = NFTService.getDisplayName(nft);

  return (
    <TouchableOpacity
      style={[styles.nftItem, isSelected && styles.selectedNftItem]}
      onPress={() => onSelect(nft)}
      disabled={isLoading}
      activeOpacity={0.8}
    >
      <View style={styles.nftImageContainer}>
        {hasValidImage && nft.imageUrl ? (
          <Image
            source={{ uri: nft.imageUrl }}
            style={styles.nftImage}
            resizeMode="cover"
          />
        ) : (
          <View style={[styles.placeholderImage, { backgroundColor: theme.colors.background }]}>
            <Ionicons
              name="image-outline"
              size={32}
              color={theme.colors.textSecondary}
            />
          </View>
        )}
        {isLoading && (
          <View style={styles.loadingOverlay}>
            <ActivityIndicator size="small" color={theme.colors.primary} />
          </View>
        )}
        {isSelected && (
          <View style={styles.selectedBadge}>
            <Ionicons name="checkmark-circle" size={24} color={theme.colors.primary} />
          </View>
        )}
      </View>
      <View style={styles.nftInfo}>
        <Text
          style={[styles.nftName, { color: theme.colors.text }]}
          numberOfLines={2}
        >
          {displayName}
        </Text>
        <Text
          style={[styles.nftContract, { color: theme.colors.textSecondary }]}
          numberOfLines={1}
        >
          #{nft.tokenId}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

export default function NFTThemeSelector({
  visible,
  onClose,
  theme,
}: NFTThemeSelectorProps) {
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(theme, insets), [theme, insets]);
  const { setNFTTheme, nftThemeData } = useTheme();
  const activeAccount = useActiveAccount();

  const [nfts, setNfts] = useState<NFTToken[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [processingNFT, setProcessingNFT] = useState<string | null>(null);

  useEffect(() => {
    if (visible && activeAccount) {
      loadNFTs();
    }
  }, [visible, activeAccount?.address]);

  const loadNFTs = async () => {
    if (!activeAccount) return;

    try {
      setIsLoading(true);
      const response = await NFTService.fetchUserNFTs(activeAccount.address);
      
      // Filter to only NFTs with valid images
      const nftsWithImages = response.tokens.filter((token) =>
        NFTService.hasValidImage(token)
      );
      
      setNfts(nftsWithImages);
    } catch (error) {
      console.error('Failed to load NFTs:', error);
      Alert.alert('Error', 'Failed to load NFTs. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleNFTSelect = async (nft: NFTToken) => {
    if (!nft.imageUrl) {
      Alert.alert('Error', 'This NFT does not have a valid image.');
      return;
    }

    const nftKey = `${nft.contractId}:${nft.tokenId}`;
    setProcessingNFT(nftKey);

    try {
      // setNFTTheme now uses current base theme mode automatically
      await setNFTTheme({
        contractId: nft.contractId,
        tokenId: nft.tokenId,
        imageUrl: nft.imageUrl,
        nftName: NFTService.getDisplayName(nft),
      });

      // Don't close the modal - let user stay in NFT selector
      // User can manually close via the X button
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

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <Ionicons name="images-outline" size={64} color={theme.colors.textMuted} />
      <Text style={[styles.emptyStateText, { color: theme.colors.textSecondary }]}>
        No NFTs with images found
      </Text>
      <Text style={[styles.emptyStateSubtext, { color: theme.colors.textMuted }]}>
        {activeAccount
          ? 'NFTs with valid images will appear here'
          : 'Please select an account to view NFTs'}
      </Text>
    </View>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Select NFT Theme</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <Ionicons name="close" size={24} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
        </View>

        {/* NFT List */}
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
              Loading NFTs...
            </Text>
          </View>
        ) : nfts.length === 0 ? (
          renderEmptyState()
        ) : (
          <FlatList
            data={nfts}
            keyExtractor={(item) => `${item.contractId}:${item.tokenId}`}
            renderItem={({ item }) => (
              <NFTItem
                nft={item}
                isSelected={isNFTSelected(item)}
                isLoading={processingNFT === `${item.contractId}:${item.tokenId}`}
                onSelect={handleNFTSelect}
                theme={theme}
                styles={styles}
              />
            )}
            numColumns={2}
            contentContainerStyle={styles.listContainer}
            columnWrapperStyle={styles.row}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </Modal>
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
    listContainer: {
      paddingTop: 16,
      paddingBottom: 16 + insets.bottom,
      paddingHorizontal: 20,
    },
    row: {
      justifyContent: 'space-between',
    },
    nftItem: {
      width: NFT_ITEM_SIZE,
      backgroundColor: theme.colors.card,
      borderRadius: 12,
      marginBottom: 16,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    selectedNftItem: {
      borderColor: theme.colors.primary,
      borderWidth: 2,
    },
    nftImageContainer: {
      width: '100%',
      height: NFT_ITEM_SIZE,
      position: 'relative',
    },
    nftImage: {
      width: '100%',
      height: '100%',
    },
    placeholderImage: {
      width: '100%',
      height: '100%',
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    selectedBadge: {
      position: 'absolute',
      top: 8,
      right: 8,
      backgroundColor: theme.colors.background,
      borderRadius: 12,
      padding: 2,
    },
    nftInfo: {
      padding: 12,
    },
    nftName: {
      fontSize: 14,
      fontWeight: '600',
      marginBottom: 4,
    },
    nftContract: {
      fontSize: 12,
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
    emptyStateSubtext: {
      fontSize: 14,
      marginTop: 8,
      textAlign: 'center',
    },
  });
