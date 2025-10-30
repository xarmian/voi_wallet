import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Dimensions,
  Alert,
  Share,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import * as Clipboard from 'expo-clipboard';
import { NFTToken } from '@/types/nft';
import { NFTService } from '@/services/nft';
import { useTheme } from '@/contexts/ThemeContext';

const { width } = Dimensions.get('window');
const imageSize = width - 40;

interface NFTDetailRouteParams {
  nft: NFTToken;
}

export default function NFTDetailScreen() {
  const [imageError, setImageError] = useState(false);
  const [isSettingTheme, setIsSettingTheme] = useState(false);
  const route = useRoute();
  const navigation = useNavigation<StackNavigationProp<any>>();
  const { nft } = route.params as NFTDetailRouteParams;
  const { theme, setNFTTheme } = useTheme();

  const handleBackPress = () => {
    navigation.goBack();
  };

  const handleShareNFT = async () => {
    try {
      const message = `Check out my NFT: ${NFTService.getDisplayName(nft)} (${NFTService.getContractIdentifier(nft)})`;
      await Share.share({
        message,
        title: 'My NFT',
      });
    } catch (error) {
      console.error('Failed to share NFT:', error);
    }
  };

  const handleCopyContractId = async () => {
    try {
      await Clipboard.setStringAsync(nft.contractId.toString());
      Alert.alert('Copied!', 'Contract ID copied to clipboard');
    } catch (error) {
      console.error('Failed to copy contract ID:', error);
      Alert.alert('Error', 'Failed to copy contract ID');
    }
  };

  const handleCopyTokenId = async () => {
    try {
      await Clipboard.setStringAsync(nft.tokenId);
      Alert.alert('Copied!', 'Token ID copied to clipboard');
    } catch (error) {
      console.error('Failed to copy token ID:', error);
      Alert.alert('Error', 'Failed to copy token ID');
    }
  };

  const handleSend = () => {
    navigation.navigate('Send' as never, {
      nftToken: nft,
      networkId: nft.networkId, // Pass the network ID from the NFT
    } as never);
  };

  const handleSetAsTheme = async () => {
    if (!NFTService.hasValidImage(nft) || !nft.imageUrl) {
      Alert.alert('Cannot Set Theme', 'This NFT does not have a valid image.');
      return;
    }

    setIsSettingTheme(true);
    try {
      await setNFTTheme({
        contractId: nft.contractId,
        tokenId: nft.tokenId,
        imageUrl: nft.imageUrl!,
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
      setIsSettingTheme(false);
    }
  };

  const formatDate = (round: number) => {
    // This is a rough approximation - in a real app you'd want to convert
    // the round number to an actual timestamp
    return `Round ${round.toLocaleString()}`;
  };

  const renderProperties = () => {
    const properties = NFTService.formatProperties(nft);

    if (properties.length === 0) {
      return null;
    }

    return (
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          Properties
        </Text>
        <View style={styles.propertiesContainer}>
          {properties.map((property, index) => (
            <View
              key={index}
              style={[
                styles.propertyItem,
                { backgroundColor: theme.colors.surface },
              ]}
            >
              <Text
                style={[
                  styles.propertyKey,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {property.key}
              </Text>
              <Text
                style={[styles.propertyValue, { color: theme.colors.text }]}
              >
                {property.value}
              </Text>
            </View>
          ))}
        </View>
      </View>
    );
  };

  const showImage = NFTService.hasValidImage(nft) && !imageError;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top']}
    >
      <View
        style={[
          styles.header,
          {
            backgroundColor: theme.colors.card,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <TouchableOpacity style={styles.backButton} onPress={handleBackPress}>
          <Ionicons name="arrow-back" size={24} color={theme.colors.primary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
          NFT Details
        </Text>
        <View style={styles.headerActions}>
          {NFTService.hasValidImage(nft) && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleSetAsTheme}
              disabled={isSettingTheme}
            >
              {isSettingTheme ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <Ionicons
                  name="color-palette-outline"
                  size={22}
                  color={theme.colors.primary}
                />
              )}
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.actionButton} onPress={handleSend}>
            <Ionicons
              name="send-outline"
              size={22}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionButton} onPress={handleShareNFT}>
            <Ionicons
              name="share-outline"
              size={22}
              color={theme.colors.primary}
            />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        <View
          style={[
            styles.imageContainer,
            { backgroundColor: theme.colors.card },
          ]}
        >
          {showImage ? (
            <Image
              source={{ uri: nft.imageUrl! }}
              style={styles.nftImage}
              onError={() => setImageError(true)}
            />
          ) : (
            <View
              style={[
                styles.placeholderImage,
                { backgroundColor: theme.colors.surface },
              ]}
            >
              <Ionicons
                name="image-outline"
                size={64}
                color={theme.colors.textSecondary}
              />
              <Text
                style={[
                  styles.placeholderText,
                  { color: theme.colors.textSecondary },
                ]}
              >
                No Image Available
              </Text>
            </View>
          )}
        </View>

        <View
          style={[styles.infoContainer, { backgroundColor: theme.colors.card }]}
        >
          <Text style={[styles.nftName, { color: theme.colors.text }]}>
            {NFTService.getDisplayName(nft)}
          </Text>

          {nft.metadata.description && (
            <Text
              style={[
                styles.nftDescription,
                { color: theme.colors.textSecondary },
              ]}
            >
              {nft.metadata.description}
            </Text>
          )}

          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
              Token Information
            </Text>

            <View style={styles.infoItem}>
              <Text
                style={[
                  styles.infoLabel,
                  { color: theme.colors.textSecondary },
                ]}
              >
                Contract ID:
              </Text>
              <TouchableOpacity onPress={handleCopyContractId}>
                <Text
                  style={[styles.infoValue, { color: theme.colors.primary }]}
                >
                  {nft.contractId}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.infoItem}>
              <Text
                style={[
                  styles.infoLabel,
                  { color: theme.colors.textSecondary },
                ]}
              >
                Token ID:
              </Text>
              <TouchableOpacity onPress={handleCopyTokenId}>
                <Text
                  style={[styles.infoValue, { color: theme.colors.primary }]}
                >
                  {nft.tokenId}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.infoItem}>
              <Text
                style={[
                  styles.infoLabel,
                  { color: theme.colors.textSecondary },
                ]}
              >
                Mint Round:
              </Text>
              <Text style={[styles.infoValue, { color: theme.colors.text }]}>
                {formatDate(nft.mintRound)}
              </Text>
            </View>

            <View style={styles.infoItem}>
              <Text
                style={[
                  styles.infoLabel,
                  { color: theme.colors.textSecondary },
                ]}
              >
                Owner:
              </Text>
              <Text
                style={[styles.infoValueMono, { color: theme.colors.text }]}
                numberOfLines={1}
              >
                {nft.owner}
              </Text>
            </View>

            {nft.metadataURI && (
              <View style={styles.infoItem}>
                <Text
                  style={[
                    styles.infoLabel,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  Metadata URI:
                </Text>
                <Text
                  style={[styles.infoValueMono, { color: theme.colors.text }]}
                  numberOfLines={2}
                >
                  {nft.metadataURI}
                </Text>
              </View>
            )}
          </View>

          {renderProperties()}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
  },
  backButton: {
    padding: 5,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: {
    padding: 5,
    marginLeft: 8,
  },
  content: {
    flex: 1,
  },
  imageContainer: {
    margin: 20,
    borderRadius: 15,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  nftImage: {
    width: imageSize,
    height: imageSize,
    resizeMode: 'cover',
  },
  placeholderImage: {
    width: imageSize,
    height: imageSize,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    marginTop: 8,
    fontSize: 16,
  },
  infoContainer: {
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 15,
    padding: 20,
  },
  nftName: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  nftDescription: {
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 20,
  },
  section: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  infoItem: {
    flexDirection: 'row',
    marginBottom: 8,
    alignItems: 'flex-start',
  },
  infoLabel: {
    fontSize: 14,
    width: 100,
    fontWeight: '500',
  },
  infoValue: {
    fontSize: 14,
    flex: 1,
    fontWeight: '500',
  },
  infoValueMono: {
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },
  propertiesContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  propertyItem: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 80,
  },
  propertyKey: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 2,
  },
  propertyValue: {
    fontSize: 14,
    fontWeight: '600',
  },
});
