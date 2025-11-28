import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  RefreshControl,
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
import { NFTBackground } from '@/components/common/NFTBackground';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { GlassButton } from '@/components/common/GlassButton';

export default function FriendsScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
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

  // Group friends
  const favorites = filteredFriends.filter(f => f.isFavorite);
  const regular = filteredFriends.filter(f => !f.isFavorite);

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

  // Render empty state
  const renderEmptyState = () => {
    if (isLoading) {
      return null;
    }

    if (searchQuery.trim()) {
      return (
        <View style={styles.emptyState}>
          <Ionicons name="search-outline" size={64} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>No friends found</Text>
          <Text style={styles.emptyText}>
            Try a different search term
          </Text>
        </View>
      );
    }

    return (
      <View style={styles.emptyState}>
        <Ionicons name="people-outline" size={64} color={theme.colors.textMuted} />
        <Text style={styles.emptyTitle}>No friends yet</Text>
        <Text style={styles.emptyText}>
          Add friends by searching for their Envoi name
        </Text>
        <GlassButton
          variant="primary"
          size="md"
          label="Add Friend"
          icon="person-add"
          onPress={handleAddFriend}
          style={{ marginTop: theme.spacing.lg }}
        />
      </View>
    );
  };

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Friends"
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
          rightAction={
            <TouchableOpacity style={styles.profileButton} onPress={handleMyProfile}>
              <Ionicons name="person-circle-outline" size={28} color={theme.colors.primary} />
            </TouchableOpacity>
          }
        />

        {/* Search Bar */}
        <BlurredContainer
          style={styles.searchContainer}
          borderRadius={0}
        >
          <View style={styles.searchInputContainer}>
            <Ionicons name="search" size={20} color={theme.colors.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search friends"
              placeholderTextColor={theme.colors.textMuted}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')}>
                <Ionicons name="close-circle" size={20} color={theme.colors.textMuted} />
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
              <Ionicons name="person-add-outline" size={16} color={theme.colors.primary} />
              <Text style={styles.searchExpandText}>
                Search Envoi for "{searchQuery.trim()}"
              </Text>
            </TouchableOpacity>
          )}
        </BlurredContainer>

        {/* Friends List */}
        <ScrollView
          contentContainerStyle={filteredFriends.length === 0 ? styles.emptyListContent : styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
        >
          {filteredFriends.length === 0 ? (
            renderEmptyState()
          ) : (
            <>
              {favorites.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>Favorites</Text>
                    <Text style={styles.sectionCount}>{favorites.length}</Text>
                  </View>
                  {favorites.map((friend) => (
                    <FriendListItem
                      key={friend.id}
                      friend={friend}
                      onPress={handleFriendPress}
                      showLastInteraction={false}
                      showAddress={true}
                    />
                  ))}
                </View>
              )}

              {regular.length > 0 && (
                <View style={styles.section}>
                  <View style={styles.sectionHeader}>
                    <Text style={styles.sectionTitle}>
                      {searchQuery.trim() ? 'Results' : 'All Friends'}
                    </Text>
                    <Text style={styles.sectionCount}>{regular.length}</Text>
                  </View>
                  {regular.map((friend) => (
                    <FriendListItem
                      key={friend.id}
                      friend={friend}
                      onPress={handleFriendPress}
                      showLastInteraction={false}
                      showAddress={true}
                    />
                  ))}
                </View>
              )}
            </>
          )}
        </ScrollView>

        {/* Floating Add Button */}
        <TouchableOpacity
          style={styles.fab}
          onPress={handleAddFriend}
          activeOpacity={0.8}
        >
          <Ionicons name="person-add" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    profileButton: {
      padding: theme.spacing.xs,
    },
    searchContainer: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
    },
    searchInputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.glassBackground,
      borderRadius: theme.borderRadius.sm,
      paddingHorizontal: theme.spacing.sm,
      gap: theme.spacing.sm,
    },
    searchExpandButton: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: theme.spacing.xs,
    },
    searchExpandText: {
      marginLeft: theme.spacing.xs,
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    searchInput: {
      flex: 1,
      height: 44,
      fontSize: 16,
      color: theme.colors.text,
    },
    listContent: {
      flexGrow: 1,
      padding: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl + 60,
    },
    emptyListContent: {
      flexGrow: 1,
      justifyContent: 'center',
      padding: theme.spacing.sm,
    },
    section: {
      marginBottom: theme.spacing.sm,
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
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
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
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
  });
