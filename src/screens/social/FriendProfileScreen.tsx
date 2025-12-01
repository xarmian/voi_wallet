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
import { NFTBackground } from '@/components/common/NFTBackground';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { GlassButton } from '@/components/common/GlassButton';

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
  const { theme } = useTheme();
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

  const handleMessage = useCallback(() => {
    if (!friend?.address) {
      return;
    }

    (navigation as any).navigate('Chat', {
      friendAddress: friend.address,
      friendEnvoiName: friend.envoiName,
    });
  }, [navigation, friend]);

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
      <NFTBackground>
        <SafeAreaView style={styles.container} edges={['top']}>
          <UniversalHeader
            title="Friend Profile"
            showBackButton
            onBackPress={() => navigation.goBack()}
            showAccountSelector={false}
            onAccountSelectorPress={() => {}}
          />

          <View style={styles.emptyState}>
            <Ionicons name="alert-circle" size={48} color={theme.colors.textMuted} />
            <Text style={styles.emptyTitle}>Friend not found</Text>
            <Text style={styles.emptySubtitle}>
              This friend may have been removed or is unavailable.
            </Text>
          </View>
        </SafeAreaView>
      </NFTBackground>
    );
  }

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title={friend.envoiName}
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
          rightAction={
            <TouchableOpacity
              style={styles.favoriteButton}
              onPress={handleToggleFavorite}
            >
              <Ionicons
                name={friend.isFavorite ? 'star' : 'star-outline'}
                size={24}
                color={friend.isFavorite ? '#FFA500' : theme.colors.text}
              />
            </TouchableOpacity>
          }
        />

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

          {/* Quick Actions */}
          <BlurredContainer
            style={styles.card}
            borderRadius={theme.borderRadius.lg}
          >
            <Text style={styles.cardTitle}>Quick Actions</Text>
            <View style={styles.actionRow}>
              <GlassButton
                variant="secondary"
                size="sm"
                label="Message"
                icon="chatbubble"
                onPress={handleMessage}
                style={styles.actionButton}
              />
              <GlassButton
                variant="secondary"
                size="sm"
                label="Send"
                icon="paper-plane"
                onPress={handleSend}
                style={styles.actionButton}
              />
              <GlassButton
                variant="secondary"
                size="sm"
                label="Explorer"
                icon="open-outline"
                onPress={handleOpenExplorer}
                style={styles.actionButton}
              />
            </View>
            <View style={[styles.actionRow, { marginTop: theme.spacing.sm }]}>
              <GlassButton
                variant="secondary"
                size="sm"
                label="Remove"
                icon="trash"
                onPress={handleRemoveFriend}
                style={[styles.actionButton, styles.dangerButton]}
              />
            </View>
          </BlurredContainer>

          {/* Account Details */}
          <BlurredContainer
            style={styles.card}
            borderRadius={theme.borderRadius.lg}
          >
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
              <Ionicons name="copy" size={20} color={theme.colors.primary} />
            </TouchableOpacity>
          </BlurredContainer>

          {/* Activity */}
          <BlurredContainer
            style={styles.card}
            borderRadius={theme.borderRadius.lg}
          >
            <Text style={styles.cardTitle}>Activity</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Added</Text>
              <Text style={styles.detailValue}>{formatDate(friend.addedAt)}</Text>
            </View>
          </BlurredContainer>

          {/* Private Notes */}
          <BlurredContainer
            style={styles.card}
            borderRadius={theme.borderRadius.lg}
          >
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
              placeholderTextColor={theme.colors.textMuted}
            />
          </BlurredContainer>
        </KeyboardAwareScrollView>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    content: {
      padding: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl,
    },
    favoriteButton: {
      padding: theme.spacing.xs,
    },
    card: {
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
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
      gap: theme.spacing.sm,
    },
    actionButton: {
      flex: 1,
    },
    dangerButton: {
      // Could add danger styling here if needed
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
      backgroundColor: theme.colors.glassBackground,
      borderRadius: theme.borderRadius.sm,
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
      borderRadius: theme.borderRadius.sm,
      backgroundColor: theme.colors.glassBackground,
      color: theme.colors.text,
      textAlignVertical: 'top',
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.lg,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.sm,
    },
    emptySubtitle: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: theme.spacing.sm,
    },
  });
