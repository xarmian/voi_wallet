import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  RouteProp,
  useNavigation,
  useRoute,
} from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';

import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import EnvoiProfileCard from '@/components/envoi/EnvoiProfileCard';
import { useFriendsStore } from '@/store/friendsStore';
import type { FriendsStackParamList } from '@/navigation/AppNavigator';
import { useCurrentNetworkConfig } from '@/store/networkStore';
import type { EnvoiNameInfo } from '@/services/envoi/types';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';

const formatRelativeTime = (timestamp?: number): string => {
  if (!timestamp) return 'No recent activity';

  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'Just now';

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
};

const formatDate = (timestamp?: number): string => {
  if (!timestamp) return 'Unknown';
  return new Date(timestamp).toLocaleString();
};

export type FriendProfileRouteProp = RouteProp<FriendsStackParamList, 'FriendProfile'>;

export default function FriendProfileScreen() {
  const styles = useThemedStyles(createStyles);
  const navigation = useNavigation();
  const route = useRoute<FriendProfileRouteProp>();
  const networkConfig = useCurrentNetworkConfig();

  const { envoiName } = route.params;

  const friend = useFriendsStore(
    (state) =>
      state.friends.find(
        (f) => f.envoiName.toLowerCase() === envoiName.toLowerCase()
      ) || null
  );

  const refreshFriendProfile = useFriendsStore((state) => state.refreshFriendProfile);
  const toggleFavorite = useFriendsStore((state) => state.toggleFavorite);
  const removeFriend = useFriendsStore((state) => state.removeFriend);
  const updateFriendNotes = useFriendsStore((state) => state.updateFriendNotes);

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [notesDraft, setNotesDraft] = useState(friend?.notes ?? '');

  useEffect(() => {
    setNotesDraft(friend?.notes ?? '');
  }, [friend?.notes]);

  // Save notes on unmount using ref to avoid dependency issues
  const notesRef = useRef({ envoiName: '', notes: '', draft: '' });

  useEffect(() => {
    if (friend) {
      notesRef.current = {
        envoiName: friend.envoiName,
        notes: friend.notes?.trim() ?? '',
        draft: notesDraft.trim(),
      };
    }
  }, [friend, notesDraft]);

  useEffect(() => {
    return () => {
      const { envoiName, notes, draft } = notesRef.current;
      if (envoiName && draft !== notes) {
        updateFriendNotes(envoiName, draft).catch((error) => {
          console.error('Failed to save notes on unmount:', error);
        });
      }
    };
  }, [updateFriendNotes]);

  const envoiProfile: EnvoiNameInfo | null = useMemo(() => {
    if (!friend) {
      return null;
    }

    return {
      name: friend.envoiName,
      address: friend.address,
      avatar: friend.avatar,
      bio: friend.bio,
      socialLinks: friend.socialLinks,
    };
  }, [friend]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refreshFriendProfile(envoiName);
    } catch (error) {
      console.error('Failed to refresh friend profile:', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [envoiName, refreshFriendProfile]);

  const handleToggleFavorite = useCallback(async () => {
    try {
      await toggleFavorite(envoiName);
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
      Alert.alert('Error', 'Unable to update favorite status right now.');
    }
  }, [envoiName, toggleFavorite]);

  const handleRemoveFriend = useCallback(() => {
    if (!friend) {
      navigation.goBack();
      return;
    }

    Alert.alert(
      'Remove Friend',
      `Remove ${friend.envoiName} from your friends list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeFriend(friend.envoiName);
              navigation.goBack();
            } catch (error) {
              console.error('Failed to remove friend:', error);
              Alert.alert('Error', 'Unable to remove friend.');
            }
          },
        },
      ]
    );
  }, [friend, navigation, removeFriend]);

  const handleCopyAddress = useCallback(async () => {
    if (!friend?.address) {
      return;
    }

    try {
      await Clipboard.setStringAsync(friend.address);
      Alert.alert('Copied', 'Address copied to clipboard');
    } catch (error) {
      console.error('Failed to copy address:', error);
      Alert.alert('Error', 'Failed to copy address');
    }
  }, [friend?.address]);

  const handleOpenExplorer = useCallback(() => {
    if (!friend?.address) {
      return;
    }

    const explorerUrl = networkConfig?.blockExplorerUrl;
    if (!explorerUrl) {
      Alert.alert('Unavailable', 'No explorer configured for this network.');
      return;
    }

    const url = `${explorerUrl.replace(/\/$/, '')}/account/${friend.address}`;
    Linking.openURL(url).catch((error) => {
      console.error('Failed to open explorer:', error);
      Alert.alert('Error', 'Unable to open explorer link.');
    });
  }, [friend?.address, networkConfig?.blockExplorerUrl]);

  const handleSend = useCallback(() => {
    const parentNavigator = navigation.getParent() as any;
    if (!friend?.address || !parentNavigator) {
      return;
    }

    parentNavigator.navigate('Home', {
      screen: 'Send',
      params: {
        recipient: friend.address,
        label: friend.envoiName,
      },
    });
  }, [friend, navigation]);


  if (!friend) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => navigation.goBack()}
          >
            <Ionicons name="chevron-back" size={24} color={styles.headerText.color} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Friend Profile</Text>
          <View style={styles.iconPlaceholder} />
        </View>

        <View style={styles.emptyState}>
          <Ionicons name="alert-circle" size={48} color={styles.emptyIcon.color} />
          <Text style={styles.emptyTitle}>Friend not found</Text>
          <Text style={styles.emptySubtitle}>
            This friend may have been removed or is unavailable.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons name="chevron-back" size={24} color={styles.headerText.color} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{friend.envoiName}</Text>
        <TouchableOpacity
          style={styles.iconButton}
          onPress={handleToggleFavorite}
        >
          <Ionicons
            name={friend.isFavorite ? 'star' : 'star-outline'}
            size={24}
            color={friend.isFavorite ? '#FFA500' : styles.headerText.color}
          />
        </TouchableOpacity>
      </View>

      <KeyboardAwareScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
        }
      >
        <EnvoiProfileCard
          address={friend.address}
          envoiProfile={envoiProfile as any}
          isLoading={false}
          title="Friend Profile"
          showVerifiedBadge={false}
        />

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Quick Actions</Text>
          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.actionButton} onPress={handleSend}>
              <Ionicons name="paper-plane" size={20} color={styles.actionIcon.color} />
              <Text style={styles.actionLabel}>Send</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleOpenExplorer}
            >
              <Ionicons name="open-outline" size={20} color={styles.actionIcon.color} />
              <Text style={styles.actionLabel}>Explorer</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleRemoveFriend}
            >
              <Ionicons name="trash" size={20} color={styles.dangerText.color} />
              <Text style={[styles.actionLabel, styles.dangerText]}>Remove</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Account Details</Text>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Envoi Name</Text>
            <Text style={styles.detailValue}>{friend.envoiName}</Text>
          </View>
          <TouchableOpacity
            style={styles.addressContainer}
            onPress={handleCopyAddress}
          >
            <View style={styles.addressTextWrapper}>
              <Text style={styles.addressLabel}>Primary Address</Text>
              <Text style={styles.addressValue}>{friend.address}</Text>
            </View>
            <Ionicons name="copy" size={20} color={styles.actionIcon.color} />
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Activity</Text>
          <View style={[styles.detailRow, { display: 'none' }]}>
            <Text style={styles.detailLabel}>Last Interaction</Text>
            <Text style={styles.detailValue}>{formatRelativeTime(friend.lastInteraction)}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Added</Text>
            <Text style={styles.detailValue}>{formatDate(friend.addedAt)}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Private Notes</Text>
          <Text style={styles.helperText}>
            Only you can see these notes. They stay on your device.
          </Text>
          <TextInput
            style={styles.notesInput}
            value={notesDraft}
            onChangeText={setNotesDraft}
            multiline
            placeholder="Add details about this friend"
            placeholderTextColor={styles.placeholder.color}
          />
        </View>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      padding: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
      textAlign: 'center',
    },
    headerText: {
      color: theme.colors.text,
    },
    iconButton: {
      padding: theme.spacing.xs,
      borderRadius: theme.borderRadius.sm,
    },
    iconPlaceholder: {
      width: 32,
    },
    card: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.md,
    },
    cardTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    actionRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: theme.spacing.sm,
    },
    actionButton: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface,
      marginHorizontal: theme.spacing.xs,
    },
    actionLabel: {
      marginTop: 4,
      fontSize: 14,
      color: theme.colors.text,
    },
    actionIcon: {
      color: theme.colors.primary,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
    },
    detailLabel: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
    detailValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
    },
    addressContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
    },
    addressTextWrapper: {
      flex: 1,
      marginRight: theme.spacing.sm,
    },
    addressLabel: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginBottom: 2,
    },
    addressValue: {
      fontSize: 13,
      color: theme.colors.text,
      fontFamily: 'monospace',
    },
    helperText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginBottom: theme.spacing.sm,
    },
    notesInput: {
      minHeight: 100,
      padding: theme.spacing.sm,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface,
      color: theme.colors.text,
      textAlignVertical: 'top',
    },
    placeholder: {
      color: theme.colors.textMuted,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.lg,
    },
    emptyIcon: {
      color: theme.colors.textMuted,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
    },
    emptySubtitle: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
    },
    dangerText: {
      color: theme.colors.error,
    },
  });
