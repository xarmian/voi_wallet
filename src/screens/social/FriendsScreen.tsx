import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
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
import { ListEmptyState } from '@/components/common/ListEmptyState';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';
import { GlassButton } from '@/components/common/GlassButton';

export default function FriendsScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const navigation =
    useNavigation<
      NativeStackNavigationProp<FriendsStackParamList, 'FriendsList'>
    >();
  const [searchQuery, setSearchQuery] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const sortedFriends = useSortedFriends();
  const {
    initialize,
    isInitialized,
    isLoading,
    searchFriends,
    refreshAllProfiles,
  } = useFriendsStore();

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

  // Group friends into SectionList sections (empty groups are omitted so no
  // header renders for them, matching the previous conditional rendering).
  const sections = useMemo(() => {
    const favorites = filteredFriends.filter((f) => f.isFavorite);
    const regular = filteredFriends.filter((f) => !f.isFavorite);

    const result: { title: string; data: Friend[] }[] = [];
    if (favorites.length > 0) {
      result.push({ title: 'Favorites', data: favorites });
    }
    if (regular.length > 0) {
      result.push({
        title: searchQuery.trim() ? 'Results' : 'All Friends',
        data: regular,
      });
    }
    return result;
  }, [filteredFriends, searchQuery]);

  // Handle friend press
  const handleFriendPress = useCallback(
    (friend: Friend) => {
      navigation.navigate('FriendProfile', { envoiName: friend.envoiName });
    },
    [navigation]
  );

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
  const renderEmptyState = useCallback(() => {
    if (isLoading) {
      return null;
    }

    if (searchQuery.trim()) {
      return (
        <ListEmptyState
          icon="search-outline"
          title="No friends found"
          subtitle="Try a different search term"
          style={styles.emptyState}
        />
      );
    }

    return (
      <ListEmptyState
        icon="people-outline"
        title="No friends yet"
        subtitle="Add friends by searching for their Envoi name"
        style={styles.emptyState}
        action={
          <GlassButton
            variant="primary"
            size="md"
            label="Add Friend"
            icon="person-add"
            onPress={handleAddFriend}
            style={{ marginTop: theme.spacing.lg }}
          />
        }
      />
    );
  }, [
    isLoading,
    searchQuery,
    styles.emptyState,
    handleAddFriend,
    theme.spacing.lg,
  ]);

  const renderFriendItem = useCallback(
    ({ item }: { item: Friend }) => (
      <FriendListItem
        friend={item}
        onPress={handleFriendPress}
        showLastInteraction={false}
        showAddress
      />
    ),
    [handleFriendPress]
  );

  const renderSectionHeader = useCallback(
    ({ section }: { section: { title: string; data: Friend[] } }) => (
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{section.title}</Text>
        <Text style={styles.sectionCount}>{section.data.length}</Text>
      </View>
    ),
    [styles.sectionHeader, styles.sectionTitle, styles.sectionCount]
  );

  const keyExtractor = useCallback((item: Friend) => item.id, []);

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Friends"
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
          rightAction={
            <TouchableOpacity
              style={styles.profileButton}
              onPress={handleMyProfile}
              accessibilityRole="button"
              accessibilityLabel="My profile"
            >
              <Ionicons
                name="person-circle-outline"
                size={28}
                color={theme.colors.primary}
              />
            </TouchableOpacity>
          }
        />

        {/* Search Bar */}
        <BlurredContainer style={styles.searchContainer} borderRadius={0}>
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
              <TouchableOpacity
                onPress={() => setSearchQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear search"
              >
                <Ionicons
                  name="close-circle"
                  size={20}
                  color={theme.colors.textMuted}
                />
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
              accessibilityRole="button"
              accessibilityLabel={`Search Envoi for ${searchQuery.trim()}`}
            >
              <Ionicons
                name="person-add-outline"
                size={16}
                color={theme.colors.primary}
              />
              <Text style={styles.searchExpandText}>
                Search Envoi for &quot;{searchQuery.trim()}&quot;
              </Text>
            </TouchableOpacity>
          )}
        </BlurredContainer>

        {/* Friends List */}
        <SectionList
          sections={sections}
          renderItem={renderFriendItem}
          renderSectionHeader={renderSectionHeader}
          keyExtractor={keyExtractor}
          contentContainerStyle={
            sections.length === 0 ? styles.emptyListContent : styles.listContent
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
          ListEmptyComponent={renderEmptyState}
          stickySectionHeadersEnabled={false}
          // Rows are variable height (name/address wrapping), so no
          // getItemLayout here — a wrong fixed height breaks scrolling.
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          windowSize={11}
          // Safe: rows pass `disableBlur`, so no BlurView is mounted inside
          // this VirtualizedList (see SafeBlurView's Android warning).
          removeClippedSubviews
          showsVerticalScrollIndicator={false}
        />

        {/* Floating Add Button */}
        <TouchableOpacity
          style={styles.fab}
          onPress={handleAddFriend}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Add contact"
        >
          <Ionicons
            name="person-add"
            size={24}
            color={theme.colors.buttonText}
          />
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
