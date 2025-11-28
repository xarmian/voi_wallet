/**
 * Swap Quote Display Component
 * Displays swap quote information including rate, price impact, and route
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Theme } from '../../constants/themes';
import { SwapToken, UnifiedSwapQuote } from '../../services/swap/types';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { GlassCard } from '@/components/common/GlassCard';

interface SwapQuoteDisplayProps {
  quote: UnifiedSwapQuote | null;
  inputToken: SwapToken | null;
  outputToken: SwapToken | null;
  loading: boolean;
  error: string | null;
  slippage: number;
  onRefresh: () => void;
  onSlippagePress: () => void;
  onRouteDetailPress: () => void;
}

export const SwapQuoteDisplay: React.FC<SwapQuoteDisplayProps> = ({
  quote,
  inputToken,
  outputToken,
  loading,
  error,
  slippage,
  onRefresh,
  onSlippagePress,
  onRouteDetailPress,
}) => {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();

  const formatAmount = (amount: string, decimals: number | undefined): string => {
    try {
      if (decimals === undefined || !amount) return '0';
      // API returns amounts in base units, convert to display units
      const value = parseFloat(amount) / Math.pow(10, decimals);
      return value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: Math.min(decimals, 6),
      });
    } catch {
      return '0';
    }
  };

  const calculateRate = (): string => {
    if (!quote || !inputToken || !outputToken) return '-';

    try {
      const rate = quote.rate;
      return `1 ${inputToken.symbol} = ${rate.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 6,
      })} ${outputToken.symbol}`;
    } catch {
      return '-';
    }
  };

  const getPriceImpactColor = (impact: number): string => {
    if (impact < 1) return themeColors.success;
    if (impact < 3) return themeColors.warning;
    return themeColors.error;
  };

  const getRouteLabel = (): string => {
    if (!quote || !quote.route) return '-';

    // Handle direct routes with pools array
    if (quote.route.type === 'direct' && quote.route.pools) {
      const pools = quote.route.pools;
      if (pools.length === 1) {
        return `Direct (${pools[0].dex.toUpperCase()})`;
      }
      // Multiple pools in direct route
      const dexes = [...new Set(pools.map(pool => pool.dex.toUpperCase()))];
      return `${pools.length} pools via ${dexes.join(', ')}`;
    }

    // Handle multi-hop routes with hops array
    if (quote.route.type === 'multi-hop' && quote.route.hops) {
      const allPools = quote.route.hops.flatMap(hop => hop.pools);
      const dexes = [...new Set(allPools.map(pool => pool.dex.toUpperCase()))];
      return `${quote.route.totalPools} pools via ${dexes.join(', ')}`;
    }

    // Fallback to totalPools
    if (quote.route.totalPools > 0) {
      return `${quote.route.totalPools} pool${quote.route.totalPools > 1 ? 's' : ''}`;
    }

    return '-';
  };

  if (error) {
    return (
      <GlassCard variant="medium" style={styles.container} animated={false}>
        <View style={styles.errorContainer}>
          <Ionicons name="alert-circle" size={24} color={themeColors.error} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={onRefresh}>
            <Text style={styles.retryButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      </GlassCard>
    );
  }

  if (!quote) {
    return (
      <GlassCard variant="medium" style={styles.container} animated={false}>
        <View style={styles.placeholderContainer}>
          <Ionicons name="swap-horizontal" size={32} color={themeColors.textMuted} />
          <Text style={styles.placeholderText}>
            Enter an amount to get a quote
          </Text>
        </View>
      </GlassCard>
    );
  }

  return (
    <GlassCard variant="medium" style={styles.container} animated={false}>
      {/* Loading overlay */}
      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="small" color={themeColors.primary} />
          <Text style={styles.loadingOverlayText}>Updating...</Text>
        </View>
      )}

      {/* Header with Refresh and Slippage */}
      <View style={[styles.header, loading && styles.contentLoading]}>
        <Text style={styles.headerTitle}>Quote</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={styles.headerButton}
            onPress={onSlippagePress}
            disabled={loading}
          >
            <Ionicons name="settings-outline" size={18} color={themeColors.text} />
            <Text style={styles.headerButtonText}>{slippage}%</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.headerButton, loading && styles.refreshButtonLoading]}
            onPress={onRefresh}
            disabled={loading}
          >
            <ActivityIndicator
              size={16}
              color={loading ? themeColors.primary : themeColors.text}
              style={loading ? undefined : { display: 'none' }}
            />
            <Ionicons
              name="refresh"
              size={18}
              color={themeColors.text}
              style={loading ? { display: 'none' } : undefined}
            />
          </TouchableOpacity>
        </View>
      </View>

      {/* Quote Details */}
      <View style={[styles.quoteDetails, loading && styles.contentLoading]}>
        {/* Rate */}
        <View style={styles.quoteRow}>
          <Text style={styles.quoteLabel}>Rate</Text>
          <Text style={styles.quoteValue}>{calculateRate()}</Text>
        </View>

        {/* Price Impact */}
        <View style={styles.quoteRow}>
          <View style={styles.labelWithIcon}>
            <Text style={styles.quoteLabel}>Price Impact</Text>
            <TouchableOpacity>
              <Ionicons
                name="information-circle-outline"
                size={16}
                color={themeColors.textMuted}
              />
            </TouchableOpacity>
          </View>
          <Text
            style={[
              styles.quoteValue,
              { color: getPriceImpactColor(quote.priceImpact || 0) },
            ]}
          >
            {quote.priceImpact !== undefined && quote.priceImpact < 0.01
              ? '<0.01%'
              : `${(quote.priceImpact || 0).toFixed(2)}%`}
          </Text>
        </View>

        {/* Minimum Received */}
        <View style={styles.quoteRow}>
          <View style={styles.labelWithIcon}>
            <Text style={styles.quoteLabel}>Minimum Received</Text>
            <TouchableOpacity>
              <Ionicons
                name="information-circle-outline"
                size={16}
                color={themeColors.textMuted}
              />
            </TouchableOpacity>
          </View>
          <Text style={styles.quoteValue}>
            {formatAmount(quote.minimumOutputAmount || '0', outputToken?.decimals)}{' '}
            {outputToken?.symbol}
          </Text>
        </View>

        {/* Route */}
        <TouchableOpacity
          style={styles.quoteRow}
          onPress={onRouteDetailPress}
          activeOpacity={0.7}
        >
          <View style={styles.labelWithIcon}>
            <Text style={styles.quoteLabel}>Route</Text>
            <Ionicons
              name="information-circle-outline"
              size={16}
              color={themeColors.textMuted}
            />
          </View>
          <View style={styles.routeValue}>
            <Text style={styles.quoteValue}>{getRouteLabel()}</Text>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={themeColors.textSecondary}
            />
          </View>
        </TouchableOpacity>

      </View>

      {/* Warning for high price impact */}
      {quote.priceImpact !== undefined && quote.priceImpact >= 3 && (
        <View style={styles.warningContainer}>
          <Ionicons name="warning" size={16} color={themeColors.warning} />
          <Text style={styles.warningText}>
            High price impact. You may lose a significant portion of your funds.
          </Text>
        </View>
      )}
    </GlassCard>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.lg,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    headerTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerActions: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    headerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      backgroundColor: theme.glass.light.backgroundColor,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
    },
    headerButtonText: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.text,
    },
    quoteDetails: {
      gap: theme.spacing.md,
    },
    quoteRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    labelWithIcon: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    quoteLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    quoteValue: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      textAlign: 'right',
    },
    routeValue: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    errorContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.md,
      paddingVertical: theme.spacing.lg,
    },
    errorText: {
      fontSize: 14,
      color: theme.colors.error,
      textAlign: 'center',
    },
    retryButton: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
      backgroundColor: theme.glass.medium.backgroundColor,
      borderRadius: theme.borderRadius.lg,
      marginTop: theme.spacing.sm,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
    },
    retryButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    placeholderContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      paddingVertical: theme.spacing.xxl,
    },
    placeholderText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: theme.spacing.sm,
      backgroundColor: `${theme.colors.warning}20`,
      padding: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      marginTop: theme.spacing.md,
    },
    warningText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.warning,
      lineHeight: 18,
    },
    loadingOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 0.5)'
        : 'rgba(255, 255, 255, 0.6)',
      borderRadius: theme.borderRadius.xl,
      zIndex: 10,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    loadingOverlayText: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.primary,
    },
    contentLoading: {
      opacity: 0.5,
    },
    refreshButtonLoading: {
      backgroundColor: `${theme.colors.primary}15`,
    },
  });
