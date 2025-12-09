/**
 * ClaimableTokensScreen - List of tokens available for claiming
 *
 * Shows all ARC-200 tokens that have been approved for transfer to the user.
 * Supports hiding tokens, viewing hidden tokens, and claiming all at once.
 */

import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Swipeable } from 'react-native-gesture-handler';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { NFTBackground } from '@/components/common/NFTBackground';
import UniversalHeader from '@/components/common/UniversalHeader';
import { GlassButton } from '@/components/common/GlassButton';
import { GlassCard } from '@/components/common/GlassCard';
import ClaimableTokenItem from '@/components/claimable/ClaimableTokenItem';
import {
  useClaimableStore,
  useDisplayedClaimableItems,
  useVisibleClaimableCount,
  useHiddenClaimableCount,
  useShowHiddenApprovals,
  useClaimableLoading,
} from '@/store/claimableStore';
import { useActiveAccount } from '@/store/walletStore';
import { ClaimableItem, toSerializableClaimableItem } from '@/types/claimable';
import type { WalletStackParamList } from '@/navigation/AppNavigator';

type NavigationProp = NativeStackNavigationProp<WalletStackParamList, 'ClaimableTokens'>;
type ClaimableTokensRouteProp = RouteProp<WalletStackParamList, 'ClaimableTokens'>;

const PENDING_REFRESH_DELAY = 8000; // 8 seconds

export default function ClaimableTokensScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ClaimableTokensRouteProp>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPendingRefresh, setIsPendingRefresh] = useState(false);
  const pendingRefreshHandled = useRef(false);
  const pendingRefreshTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const activeAccount = useActiveAccount();
  const displayedItems = useDisplayedClaimableItems();
  const visibleCount = useVisibleClaimableCount();
  const hiddenCount = useHiddenClaimableCount();
  const showHidden = useShowHiddenApprovals();
  const isLoading = useClaimableLoading();

  // Animation for pending refresh indicator
  const pulseOpacity = useSharedValue(1);
  const pulseAnimatedStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
  }));

  const {
    fetchApprovals,
    hideApproval,
    unhideApproval,
    toggleShowHidden,
    hiddenApprovals,
  } = useClaimableStore();

  // Handle pending refresh after successful claim
  useEffect(() => {
    const pendingRefresh = route.params?.pendingRefresh;
    if (pendingRefresh && !pendingRefreshHandled.current && activeAccount?.address) {
      pendingRefreshHandled.current = true;
      setIsPendingRefresh(true);

      // Start pulsing animation
      pulseOpacity.value = withRepeat(
        withTiming(0.4, { duration: 800 }),
        -1,
        true
      );

      // Clear the param immediately to prevent re-triggering
      navigation.setParams({ pendingRefresh: undefined });

      // Schedule refresh after delay (store in ref so it persists across effect re-runs)
      pendingRefreshTimeoutRef.current = setTimeout(async () => {
        await fetchApprovals(activeAccount.address);
        setIsPendingRefresh(false);
        cancelAnimation(pulseOpacity);
        pulseOpacity.value = 1;
        pendingRefreshTimeoutRef.current = null;
      }, PENDING_REFRESH_DELAY);
    }
  }, [route.params?.pendingRefresh, activeAccount?.address, fetchApprovals, navigation, pulseOpacity]);

  // Cleanup timeout on unmount only (separate effect with empty deps)
  useEffect(() => {
    return () => {
      if (pendingRefreshTimeoutRef.current) {
        clearTimeout(pendingRefreshTimeoutRef.current);
      }
      cancelAnimation(pulseOpacity);
    };
  }, [pulseOpacity]);

  // Fetch claimable tokens when screen comes into focus (but not during pending refresh)
  useFocusEffect(
    useCallback(() => {
      if (activeAccount?.address && !isPendingRefresh) {
        fetchApprovals(activeAccount.address);
      }
    }, [activeAccount?.address, fetchApprovals, isPendingRefresh])
  );

  // Handle pull-to-refresh
  const handleRefresh = useCallback(async () => {
    if (!activeAccount?.address) return;
    setIsRefreshing(true);
    try {
      await fetchApprovals(activeAccount.address);
    } finally {
      setIsRefreshing(false);
    }
  }, [activeAccount?.address, fetchApprovals]);

  // Navigate to single claim screen
  const handleItemPress = useCallback(
    (item: ClaimableItem) => {
      if (!item.isClaimable) return;
      navigation.navigate('ClaimToken', { claimableItem: toSerializableClaimableItem(item) });
    },
    [navigation]
  );

  // Navigate to claim all screen
  const handleClaimAll = useCallback(() => {
    const claimableItems = displayedItems.filter(
      (item) => item.isClaimable && !hiddenApprovals.has(item.id)
    );
    if (claimableItems.length === 0) return;
    navigation.navigate('ClaimAllConfirmation', { items: claimableItems.map(toSerializableClaimableItem) });
  }, [displayedItems, hiddenApprovals, navigation]);

  // Get count of claimable (non-hidden) items
  const claimableCount = displayedItems.filter(
    (item) => item.isClaimable && !hiddenApprovals.has(item.id)
  ).length;

  // Render right swipe actions (hide/unhide)
  const renderRightActions = useCallback(
    (item: ClaimableItem) => {
      const isHidden = hiddenApprovals.has(item.id);
      return (
        <TouchableOpacity
          style={[
            styles.swipeAction,
            { backgroundColor: isHidden ? theme.colors.primary : '#DC2626' },
          ]}
          onPress={() => {
            if (isHidden) {
              unhideApproval(item.id);
            } else {
              hideApproval(item.id);
            }
          }}
        >
          <Ionicons
            name={isHidden ? 'eye-outline' : 'eye-off-outline'}
            size={24}
            color="white"
          />
          <Text style={styles.swipeActionText}>
            {isHidden ? 'Unhide' : 'Hide'}
          </Text>
        </TouchableOpacity>
      );
    },
    [hiddenApprovals, hideApproval, unhideApproval, styles, theme.colors.primary]
  );

  // Render header right action (Claim All button)
  const renderHeaderRight = () => {
    if (claimableCount === 0) return null;
    return (
      <GlassButton
        label="Claim All"
        variant="primary"
        size="sm"
        onPress={handleClaimAll}
        icon="flash"
      />
    );
  };

  // Render empty state
  const renderEmptyState = () => (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIconContainer}>
        <Ionicons name="gift-outline" size={64} color={styles.emptyIcon.color} />
      </View>
      <Text style={styles.emptyTitle}>No Claimable Tokens</Text>
      <Text style={styles.emptySubtitle}>
        When someone approves tokens for you to claim, they will appear here.
      </Text>
    </View>
  );

  // Render loading state
  const renderLoadingState = () => (
    <View style={styles.loadingContainer}>
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <Text style={styles.loadingText}>Loading claimable tokens...</Text>
    </View>
  );

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Claimable Tokens"
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
          rightAction={renderHeaderRight()}
        />

        {/* Hidden toggle */}
        {hiddenCount > 0 && (
          <TouchableOpacity
            style={styles.hiddenToggle}
            onPress={toggleShowHidden}
          >
            <Ionicons
              name={showHidden ? 'eye' : 'eye-off'}
              size={18}
              color={styles.hiddenToggleText.color}
            />
            <Text style={styles.hiddenToggleText}>
              {showHidden
                ? `Showing ${hiddenCount} hidden`
                : `${hiddenCount} hidden`}
            </Text>
            <Ionicons
              name={showHidden ? 'chevron-up' : 'chevron-down'}
              size={16}
              color={styles.hiddenToggleText.color}
            />
          </TouchableOpacity>
        )}

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
        >
          {isLoading && !isRefreshing && displayedItems.length === 0 ? (
            renderLoadingState()
          ) : displayedItems.length === 0 ? (
            renderEmptyState()
          ) : (
            <>
              {/* Pending refresh indicator */}
              {isPendingRefresh && (
                <Animated.View style={[styles.pendingRefreshBanner, pulseAnimatedStyle]}>
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                  <Text style={styles.pendingRefreshText}>
                    Updating claim status...
                  </Text>
                </Animated.View>
              )}

              {/* Summary card */}
              <GlassCard variant="light" padding="md" style={styles.summaryCard}>
                <View style={styles.summaryRow}>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{visibleCount}</Text>
                    <Text style={styles.summaryLabel}>Available</Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryValue}>{claimableCount}</Text>
                    <Text style={styles.summaryLabel}>Claimable</Text>
                  </View>
                  {hiddenCount > 0 && (
                    <>
                      <View style={styles.summaryDivider} />
                      <View style={styles.summaryItem}>
                        <Text style={styles.summaryValue}>{hiddenCount}</Text>
                        <Text style={styles.summaryLabel}>Hidden</Text>
                      </View>
                    </>
                  )}
                </View>
              </GlassCard>

              {/* Token list */}
              <View style={styles.listContainer}>
                {displayedItems.map((item) => {
                  const isHidden = hiddenApprovals.has(item.id);
                  return (
                    <Swipeable
                      key={item.id}
                      renderRightActions={() => renderRightActions(item)}
                      overshootRight={false}
                    >
                      <ClaimableTokenItem
                        item={item}
                        onPress={() => handleItemPress(item)}
                        isHidden={isHidden}
                      />
                    </Swipeable>
                  );
                })}
              </View>
            </>
          )}
        </ScrollView>
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
    scrollContent: {
      padding: 16,
      paddingBottom: 32,
    },
    hiddenToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 8,
      paddingHorizontal: 16,
      gap: 6,
    },
    hiddenToggleText: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    pendingRefreshBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary + '15',
      borderRadius: theme.borderRadius.md,
      paddingVertical: 12,
      paddingHorizontal: 16,
      marginBottom: 16,
      gap: 10,
    },
    pendingRefreshText: {
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '500',
    },
    summaryCard: {
      marginBottom: 16,
    },
    summaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-around',
    },
    summaryItem: {
      alignItems: 'center',
      paddingHorizontal: 16,
    },
    summaryValue: {
      fontSize: 24,
      fontWeight: '700',
      color: theme.colors.text,
    },
    summaryLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    summaryDivider: {
      width: 1,
      height: 32,
      backgroundColor: theme.colors.border,
    },
    listContainer: {
      gap: 0,
    },
    swipeAction: {
      justifyContent: 'center',
      alignItems: 'center',
      width: 80,
      marginBottom: 8,
      borderRadius: theme.borderRadius.md,
    },
    swipeActionText: {
      color: 'white',
      fontSize: 12,
      fontWeight: '500',
      marginTop: 4,
    },
    emptyContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 80,
      paddingHorizontal: 32,
    },
    emptyIconContainer: {
      width: 120,
      height: 120,
      borderRadius: 60,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginBottom: 24,
    },
    emptyIcon: {
      color: theme.colors.textMuted,
    },
    emptyTitle: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 8,
      textAlign: 'center',
    },
    emptySubtitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 20,
    },
    loadingContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 80,
    },
    loadingText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 12,
    },
  });
