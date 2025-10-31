import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ARC72Collection } from '@/types/nft';
import { useTheme } from '@/contexts/ThemeContext';

interface CollectionListItemProps {
  collection: ARC72Collection;
  onPress: (collection: ARC72Collection) => void;
}

export default function CollectionListItem({
  collection,
  onPress,
}: CollectionListItemProps) {
  const { theme } = useTheme();
  const [imageError, setImageError] = React.useState(false);
  const [imageLoading, setImageLoading] = React.useState(true);

  // Try to get image from collection or firstToken
  const getImageUrl = () => {
    if (collection.imageUrl) return collection.imageUrl;
    if (collection.firstToken?.metadata) {
      try {
        const metadata = JSON.parse(collection.firstToken.metadata);
        return metadata.image;
      } catch {
        return null;
      }
    }
    return null;
  };

  const imageUrl = getImageUrl();
  const showImage = imageUrl && !imageError;

  // Debug: Log collection data to see what we're getting
  if (!collection.name || collection.name.trim() === '') {
    console.log('Collection missing name:', JSON.stringify(collection, null, 2));
  }

  return (
    <TouchableOpacity
      style={[styles.container, { backgroundColor: theme.colors.card }]}
      onPress={() => onPress(collection)}
      activeOpacity={0.7}
    >
      <View style={styles.imageContainer}>
        {showImage ? (
          <>
            <Image
              source={{ uri: imageUrl }}
              style={styles.image}
              onError={() => {
                setImageError(true);
                setImageLoading(false);
              }}
              onLoad={() => setImageLoading(false)}
            />
            {imageLoading && (
              <View style={styles.imageLoadingOverlay}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
              </View>
            )}
          </>
        ) : (
          <View
            style={[
              styles.placeholderImage,
              { backgroundColor: theme.colors.background },
            ]}
          >
            <Ionicons
              name="images-outline"
              size={24}
              color={theme.colors.textSecondary}
            />
          </View>
        )}
      </View>

      <View style={styles.info}>
        <View style={styles.headerRow}>
          <Text
            style={[styles.name, { color: theme.colors.text }]}
            numberOfLines={1}
          >
            {collection.name}
          </Text>
          {collection.verified === 1 && (
            <Ionicons
              name="checkmark-circle"
              size={16}
              color={theme.colors.primary}
              style={styles.verifiedBadge}
            />
          )}
        </View>
        <Text
          style={[styles.contractId, { color: theme.colors.textSecondary }]}
          numberOfLines={1}
        >
          Contract: {collection.contractId}
        </Text>
        <View style={styles.statsRow}>
          <Text
            style={[styles.stats, { color: theme.colors.textSecondary }]}
            numberOfLines={1}
          >
            {collection.totalSupply.toLocaleString()} items
          </Text>
          {collection.uniqueOwners > 0 && (
            <>
              <Text
                style={[styles.statsSeparator, { color: theme.colors.textSecondary }]}
              >
                •
              </Text>
              <Text
                style={[styles.stats, { color: theme.colors.textSecondary }]}
                numberOfLines={1}
              >
                {collection.uniqueOwners.toLocaleString()} owners
              </Text>
            </>
          )}
        </View>
      </View>

      <Ionicons
        name="chevron-forward"
        size={20}
        color={theme.colors.textSecondary}
        style={styles.chevron}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    padding: 12,
    borderRadius: 12,
    marginHorizontal: 16,
    marginVertical: 6,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  imageContainer: {
    width: 60,
    height: 60,
    borderRadius: 8,
    overflow: 'hidden',
    marginRight: 12,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imageLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
  },
  placeholderImage: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  info: {
    flex: 1,
    justifyContent: 'center',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  verifiedBadge: {
    marginLeft: 4,
  },
  contractId: {
    fontSize: 12,
    marginBottom: 4,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  stats: {
    fontSize: 12,
  },
  statsSeparator: {
    marginHorizontal: 6,
    fontSize: 12,
  },
  chevron: {
    marginLeft: 8,
  },
});
