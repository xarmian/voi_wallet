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
  FlatList,
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
import {
  useNavigation,
  useFocusEffect,
  useRoute,
  RouteProp,
} from '@react-navigation/native';
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
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { ClaimableItem, toSerializableClaimableItem } from '@/types/claimable';
import type { WalletStackParamList } from '@/navigation/AppNavigator';

type NavigationProp = NativeStackNavigationProp<
  WalletStackParamList,
  'ClaimableTokens'
>;
type ClaimableTokensRouteProp = RouteProp<
  WalletStackParamList,
  'ClaimableTokens'
>;

const PENDING_REFRESH_DELAY = 8000; // 8 seconds
const RETRY_REFRESH_DELAY = 5000; // 5 seconds for retry if claimed items still present

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
  const reducedMotion = useReducedMotion();
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
    const claimedItemIds = route.params?.claimedItemIds;

    if (
      pendingRefresh &&
      !pendingRefreshHandled.current &&
      activeAccount?.address
    ) {
      pendingRefreshHandled.current = true;
      setIsPendingRefresh(true);

      // Start pulsing animation. DR-13: skipped entirely under Reduce Motion —
      // `isPendingRefresh` still drives the visible "refreshing" copy, so the
      // state remains conveyed without the loop.
      if (!reducedMotion) {
        pulseOpacity.value = withRepeat(
          withTiming(0.4, { duration: 800 }),
          -1,
          true
        );
      }

      // Clear the params immediately to prevent re-triggering
      navigation.setParams({
        pendingRefresh: undefined,
        claimedItemIds: undefined,
      });

      // Schedule refresh after delay (store in ref so it persists across effect re-runs)
      pendingRefreshTimeoutRef.current = setTimeout(async () => {
        await fetchApprovals(activeAccount.address);

        // Check if any claimed items are still present in the list
        const { claimableItems } = useClaimableStore.getState();
        const claimedStillPresent = claimedItemIds?.some((id) =>
          claimableItems.some((item) => item.id === id)
        );

        if (claimedStillPresent) {
          // Retry once after additional delay if indexer hasn't updated yet
          pendingRefreshTimeoutRef.current = setTimeout(async () => {
            await fetchApprovals(activeAccount.address);
            setIsPendingRefresh(false);
            cancelAnimation(pulseOpacity);
            pulseOpacity.value = 1;
            pendingRefreshTimeoutRef.current = null;
          }, RETRY_REFRESH_DELAY);
        } else {
          setIsPendingRefresh(false);
          cancelAnimation(pulseOpacity);
          pulseOpacity.value = 1;
          pendingRefreshTimeoutRef.current = null;
        }
      }, PENDING_REFRESH_DELAY);
    }
  }, [
    route.params?.pendingRefresh,
    route.params?.claimedItemIds,
    activeAccount?.address,
    fetchApprovals,
    navigation,
    pulseOpacity,
    reducedMotion,
  ]);

  // DR-13: the effect above is short-circuited by `pendingRefreshHandled`, so a
  // pulse that was already running when the user switched Reduce Motion ON
  // would otherwise keep looping until the delayed refresh finishes. Stop it
  // from its own effect, which has no such guard.
  useEffect(() => {
    if (!reducedMotion) return;
    cancelAnimation(pulseOpacity);
    pulseOpacity.value = 1;
  }, [reducedMotion, pulseOpacity]);

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
      navigation.navigate('ClaimToken', {
        claimableItem: toSerializableClaimableItem(item),
      });
    },
    [navigation]
  );

  // Navigate to claim all screen
  const handleClaimAll = useCallback(() => {
    const claimableItems = displayedItems.filter(
      (item) => item.isClaimable && !hiddenApprovals.has(item.id)
    );
    if (claimableItems.length === 0) return;
    navigation.navigate('ClaimAllConfirmation', {
      items: claimableItems.map(toSerializableClaimableItem),
    });
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
    [
      hiddenApprovals,
      hideApproval,
      unhideApproval,
      styles,
      theme.colors.primary,
    ]
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

  // Render empty state. This screen keeps its own empty state rather than the
  // shared ListEmptyState: it has a distinct circular icon badge.
  const renderEmptyState = useCallback(
    () => (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIconContainer}>
          <Ionicons
            name="gift-outline"
            size={64}
            color={styles.emptyIcon.color}
          />
        </View>
        <Text style={styles.emptyTitle}>No Claimable Tokens</Text>
        <Text style={styles.emptySubtitle}>
          When someone approves tokens for you to claim, they will appear here.
        </Text>
      </View>
    ),
    [styles]
  );

  // Render loading state
  const renderLoadingState = useCallback(
    () => (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text style={styles.loadingText}>Loading claimable tokens...</Text>
      </View>
    ),
    [styles, theme.colors.primary]
  );

  // Empty slot doubles as the initial-load placeholder so pull-to-refresh
  // stays available in both states. Memoized: an unstable component identity
  // makes VirtualizedList remount the empty subtree on every render.
  const showLoadingState = isLoading && !isRefreshing;
  const renderListEmpty = useCallback(
    () => (showLoadingState ? renderLoadingState() : renderEmptyState()),
    [showLoadingState, renderLoadingState, renderEmptyState]
  );

  // Summary + pending-refresh banner scroll with the list, as before.
  const renderListHeader = () => {
    if (displayedItems.length === 0) return null;

    return (
      <>
        {/* Pending refresh indicator */}
        {isPendingRefresh && (
          <Animated.View
            style={[styles.pendingRefreshBanner, pulseAnimatedStyle]}
          >
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
      </>
    );
  };

  // Each row keeps its own Swipeable. FlatList keys cells by `keyExtractor`
  // and mounts/unmounts them (it does not reuse instances across items), so a
  // row's open/closed swipe state stays bound to its own item.
  const renderItem = useCallback(
    ({ item }: { item: ClaimableItem }) => (
      <Swipeable
        renderRightActions={() => renderRightActions(item)}
        overshootRight={false}
      >
        <ClaimableTokenItem
          item={item}
          onPress={() => handleItemPress(item)}
          isHidden={hiddenApprovals.has(item.id)}
        />
      </Swipeable>
    ),
    [hiddenApprovals, renderRightActions, handleItemPress]
  );

  const keyExtractor = useCallback((item: ClaimableItem) => item.id, []);

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

        <FlatList
          style={styles.scrollView}
          data={displayedItems}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={
            displayedItems.length === 0
              ? styles.emptyListContent
              : styles.scrollContent
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
          // Passed as an element, not a component reference: the header holds
          // a running Reanimated banner, and an unstable component identity
          // would make VirtualizedList remount it on every render.
          ListHeaderComponent={renderListHeader()}
          ListEmptyComponent={renderListEmpty}
          // Rows are variable height (token name/amount wrapping), so no
          // getItemLayout here — a wrong fixed height breaks scrolling.
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={11}
          // Intentionally left off: the list header renders a GlassCard, whose
          // glass uses BlurView, and clipping detaches/reattaches those native
          // views on Android (see SafeBlurView). Rows themselves use plain
          // Views, so nothing is recycled with a live BlurView.
          removeClippedSubviews={false}
        />
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
    emptyListContent: {
      flexGrow: 1,
      justifyContent: 'center',
      padding: 16,
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
