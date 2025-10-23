import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TextInput,
  TouchableOpacity,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useFriendsStore, useSortedFriends } from '@/store/friendsStore';
import { Friend } from '@/types/social';
import FriendListItem from '@/components/social/FriendListItem';
import type { FriendsStackParamList } from '@/navigation/AppNavigator';

interface FriendSection {
  title: string;
  data: Friend[];
}

export default function FriendsScreen() {
  const styles = useThemedStyles(createStyles);
  const navigation =
    useNavigation<NativeStackNavigationProp<FriendsStackParamList, 'FriendsList'>>();
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const sortedFriends = useSortedFriends();
  const { initialize, isInitialized, isLoading, searchFriends, refreshAllProfiles } = useFriendsStore();

  // Initialize on mount
  useEffect(() => {
    if (!isInitialized) {
      initialize();
    }
  }, [isInitialized, initialize]);

  // Filter friends based on search
  const filteredFriends = searchQuery.trim()
    ? searchFriends(searchQuery)
    : sortedFriends;

  // Group into sections
  const sections: FriendSection[] = [];

  const favorites = filteredFriends.filter(f => f.isFavorite);
  const regular = filteredFriends.filter(f => !f.isFavorite);

  if (favorites.length > 0) {
    sections.push({ title: 'Favorites', data: favorites });
  }

  if (regular.length > 0) {
    sections.push({ title: searchQuery.trim() ? 'Results' : 'All Friends', data: regular });
  }

  // Handle friend press
  const handleFriendPress = useCallback((friend: Friend) => {
    navigation.navigate('FriendProfile', { envoiName: friend.envoiName });
  }, [navigation]);

  // Handle add friend
  const handleAddFriend = useCallback(() => {
    navigation.navigate('AddFriend');
  }, [navigation]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await refreshAllProfiles();
    setIsRefreshing(false);
  }, [refreshAllProfiles]);

  // Handle my profile
  const handleMyProfile = useCallback(() => {
    navigation.navigate('MyProfile');
  }, [navigation]);

  // Render section header
  const renderSectionHeader = useCallback(({ section }: { section: FriendSection }) => (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{section.title}</Text>
      <Text style={styles.sectionCount}>{section.data.length}</Text>
    </View>
  ), [styles]);

  // Render friend item
  const renderFriendItem = useCallback(({ item }: { item: Friend }) => (
    <FriendListItem
      friend={item}
      onPress={handleFriendPress}
      showLastInteraction={false}
      showAddress={true}
    />
  ), [handleFriendPress]);

  // Render empty state
  const renderEmptyState = () => {
    if (isLoading) {
      return null;
    }

    if (searchQuery.trim()) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="search-outline" size={64} color={styles.emptyIcon.color} />
          <Text style={styles.emptyTitle}>No friends found</Text>
          <Text style={styles.emptyText}>
            Try a different search term
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyState}>
        <Ionicons name="people-outline" size={64} color={styles.emptyIcon.color} />
        <Text style={styles.emptyTitle}>No friends yet</Text>
        <Text style={styles.emptyText}>
          Add friends by searching for their Envoi name
        </Text>
        <TouchableOpacity style={styles.emptyButton} onPress={handleAddFriend}>
          <Text style={styles.emptyButtonText}>Add Friend</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Friends</Text>
        <TouchableOpacity style={styles.profileButton} onPress={handleMyProfile}>
          <Ionicons name="person-circle-outline" size={28} color={styles.headerIcon.color} />
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
      <View style={styles.searchInputContainer}>
        <Ionicons name="search" size={20} color={styles.searchIcon.color} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search friends"
          placeholderTextColor={styles.searchPlaceholder.color}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
      {searchQuery.length > 0 && (
        <TouchableOpacity onPress={() => setSearchQuery('')}>
          <Ionicons name="close-circle" size={20} color={styles.searchIcon.color} />
        </TouchableOpacity>
      )}
    </View>
    {searchQuery.trim().length > 0 && (
      <TouchableOpacity
        style={styles.searchExpandButton}
        onPress={() =>
          navigation.navigate('AddFriend', {
            initialQuery: searchQuery.trim(),
          })
        }
      >
        <Ionicons name="person-add-outline" size={16} color={styles.searchExpandIcon.color} />
        <Text style={styles.searchExpandText}>
          Search Envoi for "{searchQuery.trim()}"
        </Text>
      </TouchableOpacity>
    )}
    </View>

      {/* Friends List */}
      <SectionList
        sections={sections}
        renderItem={renderFriendItem}
        renderSectionHeader={renderSectionHeader}
        keyExtractor={(item) => item.id}
        contentContainerStyle={sections.length === 0 ? styles.emptyListContent : styles.listContent}
        ListEmptyComponent={renderEmptyState}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={styles.refreshControl.color}
          />
        }
        stickySectionHeadersEnabled={true}
      />

      {/* Floating Add Button */}
      <TouchableOpacity
        style={styles.fab}
        onPress={handleAddFriend}
        activeOpacity={0.8}
      >
        <Ionicons name="person-add" size={24} color="#FFFFFF" />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
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
      fontSize: 28,
      fontWeight: 'bold',
      color: theme.colors.text,
    },
    profileButton: {
      padding: theme.spacing.xs,
    },
    headerIcon: {
      color: theme.colors.primary,
    },
    searchContainer: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
      backgroundColor: theme.colors.surface,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.background,
      borderRadius: theme.borderRadius.md,
      paddingHorizontal: theme.spacing.md,
      gap: theme.spacing.sm,
    },
    searchExpandButton: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: theme.spacing.xs,
    },
    searchExpandIcon: {
      color: theme.colors.primary,
    },
    searchExpandText: {
      marginLeft: theme.spacing.xs,
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    searchIcon: {
      color: theme.colors.textMuted,
    },
    searchInput: {
      flex: 1,
      height: 44,
      fontSize: 16,
      color: theme.colors.text,
    },
    searchPlaceholder: {
      color: theme.colors.textMuted,
    },
    listContent: {
      flexGrow: 1,
    },
    emptyListContent: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      backgroundColor: theme.colors.background,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    sectionCount: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textMuted,
    },
    emptyState: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.xl,
      paddingVertical: theme.spacing.xxl,
    },
    emptyIcon: {
      color: theme.colors.textMuted,
      marginBottom: theme.spacing.lg,
    },
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: theme.spacing.lg,
    },
    emptyButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: theme.spacing.xl,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
    },
    emptyButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    fab: {
      position: 'absolute',
      right: theme.spacing.lg,
      bottom: theme.spacing.lg,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: theme.colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
      ...theme.shadows.lg,
    },
    refreshControl: {
      color: theme.colors.primary,
    },
  });
