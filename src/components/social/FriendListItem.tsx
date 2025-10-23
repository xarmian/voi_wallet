import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Friend } from '@/types/social';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import AccountAvatar from '@/components/account/AccountAvatar';
import { formatAddress } from '@/utils/address';

interface FriendListItemProps {
  friend: Friend;
  onPress: (friend: Friend) => void;
  showLastInteraction?: boolean;
  showAddress?: boolean;
}

export default function FriendListItem({
  friend,
  onPress,
  showLastInteraction = true,
  showAddress = false,
}: FriendListItemProps) {
  const styles = useThemedStyles(createStyles);

  const formatLastInteraction = (timestamp?: number): string => {
    if (!timestamp) return 'No recent activity';

    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);

    if (seconds < 60) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    if (weeks < 4) return `${weeks}w ago`;
    return `${months}mo ago`;
  };

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={() => onPress(friend)}
      activeOpacity={0.7}
    >
      <View style={styles.avatarContainer}>
        {friend.avatar ? (
          <Image
            source={{ uri: friend.avatar }}
            style={styles.avatar}
          />
        ) : (
          <AccountAvatar
            address={friend.address}
            size={48}
            useEnvoiAvatar={false}
            fallbackToGenerated={true}
            showActiveIndicator={false}
            showRekeyIndicator={false}
          />
        )}
        {friend.isFavorite && (
          <View style={styles.favoriteBadge}>
            <Ionicons name="star" size={14} color="#FFA500" />
          </View>
        )}
      </View>

      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.name} numberOfLines={1}>
            {friend.envoiName}
          </Text>
        </View>

        {showAddress && (
          <Text style={styles.addressText}>
            {formatAddress(friend.address)}
          </Text>
        )}

        {friend.bio && (
          <Text style={styles.bio} numberOfLines={1}>
            {friend.bio}
          </Text>
        )}

        {showLastInteraction && (
          <Text style={styles.lastInteraction}>
            {formatLastInteraction(friend.lastInteraction)}
          </Text>
        )}
      </View>

      <Ionicons name="chevron-forward" size={20} color={styles.chevron.color} />
    </TouchableOpacity>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    avatarContainer: {
      position: 'relative',
      marginRight: theme.spacing.md,
    },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.background,
    },
    favoriteBadge: {
      position: 'absolute',
      top: -4,
      right: -4,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: theme.colors.card,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: theme.colors.card,
    },
    content: {
      flex: 1,
      justifyContent: 'center',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 2,
    },
    name: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
    },
    bio: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginBottom: 2,
    },
    lastInteraction: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    chevron: {
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.sm,
    },
    addressText: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
  });
