/**
 * Route Detail Modal
 * Displays hop-by-hop route information for a swap
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Animated,
  ActivityIndicator,
  Dimensions,
  Pressable,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Theme } from '../../constants/themes';
import { SwapToken, UnifiedRoute, UnifiedRoutePool, UnifiedRouteHop } from '../../services/swap/types';
import { SwapService } from '../../services/swap';
import { NetworkId } from '../../types/network';
import { useNetworkStore } from '../../store/networkStore';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { getTokenImageSource } from '../../utils/tokenImages';

interface RouteDetailModalProps {
  visible: boolean;
  route: UnifiedRoute;
  inputToken: SwapToken;
  outputToken: SwapToken;
  estimatedOutput?: string;
  minimumOutput?: string;
  onClose: () => void;
}

interface RouteStep {
  pool: UnifiedRoutePool;
  hopIndex: number;
  poolIndex: number;
  tokenIn?: SwapToken;
  tokenOut?: SwapToken;
}

export const RouteDetailModal: React.FC<RouteDetailModalProps> = ({
  visible,
  route,
  inputToken,
  outputToken,
  estimatedOutput,
  minimumOutput,
  onClose,
}) => {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const currentNetwork = useNetworkStore(state => state.currentNetwork);

  const [routeSteps, setRouteSteps] = useState<RouteStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [slideAnim] = useState(new Animated.Value(0));
  const [intermediateTokens, setIntermediateTokens] = useState<Map<string, SwapToken>>(new Map());

  useEffect(() => {
    if (visible) {
      loadRouteDetails();

      Animated.spring(slideAnim, {
        toValue: 1,
        useNativeDriver: true,
        tension: 65,
        friction: 11,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
      // Reset loading state when modal closes
      setLoading(true);
      setRouteSteps([]);
    }
  }, [visible, route]);

  const loadRouteDetails = async () => {
    setLoading(true);
    try {
      if (!route) {
        console.warn('RouteDetailModal: No route provided');
        setRouteSteps([]);
        setLoading(false);
        return;
      }

      let steps: RouteStep[] = [];
      const tokenMap = new Map<string, SwapToken>();
      const provider = SwapService.getProvider(currentNetwork);

      // Fetch intermediate tokens for multi-hop routes
      // In UnifiedRoute, hops may have inputToken/outputToken as SwapToken | null
      if (route.type === 'multi-hop' && route.hops && Array.isArray(route.hops)) {
        // Collect intermediate tokens from hops that have them
        for (const hop of route.hops) {
          if (hop.inputToken) {
            tokenMap.set(String(hop.inputToken.id), hop.inputToken);
          }
          if (hop.outputToken) {
            tokenMap.set(String(hop.outputToken.id), hop.outputToken);
          }
        }
      }

      setIntermediateTokens(tokenMap);

      // Handle direct routes with pools array
      if (route.type === 'direct' && route.pools && Array.isArray(route.pools) && route.pools.length > 0) {
        steps = route.pools.map((pool, index) => {
          const tokenIn = index === 0 ? inputToken : undefined;
          const tokenOut = index === route.pools!.length - 1 ? outputToken : undefined;

          return {
            pool,
            hopIndex: 0,
            poolIndex: index,
            tokenIn,
            tokenOut,
          };
        });
      }

      // Handle multi-hop routes with hops array
      if (route.type === 'multi-hop' && route.hops && Array.isArray(route.hops) && route.hops.length > 0) {
        steps = route.hops.flatMap((hop, hopIndex) => {
          if (!hop.pools || !Array.isArray(hop.pools) || hop.pools.length === 0) {
            console.warn(`RouteDetailModal: Hop ${hopIndex} has no pools or invalid pools array`);
            return [];
          }
            
          // Get tokens for this hop from the hop's inputToken/outputToken (SwapToken | null)
          const hopInputToken = hopIndex === 0
            ? inputToken
            : (hop.inputToken || undefined);
          const hopOutputToken = hopIndex === route.hops!.length - 1
            ? outputToken
            : (hop.outputToken || undefined);

          return hop.pools.map((pool, poolIndex) => {
            // First pool of hop uses hop's inputToken
            const isFirstPoolInHop = poolIndex === 0;
            // Last pool of hop uses hop's outputToken
            const isLastPoolInHop = poolIndex === hop.pools.length - 1;

            let tokenIn: SwapToken | undefined;
            let tokenOut: SwapToken | undefined;

            if (isFirstPoolInHop && isLastPoolInHop) {
              // Single pool in hop
              tokenIn = hopInputToken;
              tokenOut = hopOutputToken;
            } else if (isFirstPoolInHop) {
              // First pool: input is hop's inputToken
              tokenIn = hopInputToken;
              tokenOut = hopOutputToken;
            } else if (isLastPoolInHop) {
              // Last pool: output is hop's outputToken
              tokenIn = hopInputToken;
              tokenOut = hopOutputToken;
            } else {
              // Middle pools
              tokenIn = hopOutputToken;
              tokenOut = hopOutputToken;
            }

            return {
              pool,
              hopIndex,
              poolIndex,
              tokenIn,
              tokenOut,
            };
          });
        });
      }

      if (steps.length === 0) {
        console.warn('RouteDetailModal: No route steps generated. Route structure:', route);
      } else {
        console.log(`RouteDetailModal: Generated ${steps.length} route steps`);
      }

      setRouteSteps(steps);
    } catch (error) {
      console.error('Error loading route details:', error);
      setRouteSteps([]);
    } finally {
      setLoading(false);
    }
  };

  const formatAmount = (amount: string, decimals: number = 6): string => {
    try {
      // API returns amounts in base units, convert to display units
      const value = parseFloat(amount) / Math.pow(10, decimals);
      if (isNaN(value)) return amount;

      return value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: Math.min(decimals, 6),
      });
    } catch {
      return amount;
    }
  };

  const renderTokenIcon = (token: SwapToken | undefined, fallbackSymbol: string) => {
    if (!token) {
      return (
        <View style={styles.tokenIcon}>
          <Text style={styles.tokenIconText}>{fallbackSymbol[0]}</Text>
        </View>
      );
    }

    const imageSource = getTokenImageSource(token, currentNetwork);

    if (imageSource) {
      if (imageSource.type === 'uri') {
        return (
          <Image
            source={{ uri: imageSource.uri }}
            style={styles.tokenIcon}
            defaultSource={require('../../../assets/icon.png')}
          />
        );
      } else {
        return (
          <Image
            source={imageSource.source}
            style={styles.tokenIcon}
          />
        );
      }
    }

    // Fallback to placeholder
    return (
      <View style={styles.tokenIcon}>
        <Text style={styles.tokenIconText}>{token.symbol?.[0] || fallbackSymbol[0]}</Text>
      </View>
    );
  };

  const translateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [600, 0],
  });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <Animated.View
          style={[
            styles.modalContainer,
            { transform: [{ translateY }] },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Route Details</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={themeColors.text} />
            </TouchableOpacity>
          </View>

          {/* Content */}
          <View style={styles.scrollContainer}>
            <ScrollView
              style={styles.scrollView}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={true}
              bounces={true}
            >
              {loading ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="large" color={themeColors.primary} />
                  <Text style={styles.loadingText}>Loading route details...</Text>
                </View>
              ) : routeSteps.length === 0 ? (
                <View style={styles.loadingContainer}>
                  <Text style={styles.loadingText}>No route steps found</Text>
                  <Text style={styles.loadingText}>Route: {route ? JSON.stringify(route, null, 2) : 'null'}</Text>
                </View>
              ) : (
                <>
                  {/* Summary */}
                  <View style={styles.summaryContainer}>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Total Pools</Text>
                      <Text style={styles.summaryValue}>{routeSteps.length}</Text>
                    </View>
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Route Type</Text>
                      <Text style={styles.summaryValue}>
                        {route?.type === 'direct' ? 'Direct' : 'Multi-hop'}
                      </Text>
                    </View>
                    {route?.hops && (
                      <View style={styles.summaryRow}>
                        <Text style={styles.summaryLabel}>Hops</Text>
                        <Text style={styles.summaryValue}>{route.hops.length}</Text>
                      </View>
                    )}
                  </View>

                  {/* Route Steps */}
                  {routeSteps.map((step, index) => (
                    <View key={index}>
                      <View style={styles.stepContainer}>
                        {/* Step Number */}
                        <View style={styles.stepHeader}>
                          <View style={styles.stepNumber}>
                            <Text style={styles.stepNumberText}>{index + 1}</Text>
                          </View>
                          <Text style={styles.dexName}>{step.pool.dex.toUpperCase()}</Text>
                        </View>

                        {/* Token Pair */}
                        <View style={styles.tokenPair}>
                          <View style={styles.tokenInfo}>
                            {renderTokenIcon(step.tokenIn, inputToken.symbol)}
                            <View>
                              <Text style={styles.tokenSymbol}>
                                {step.tokenIn?.symbol || inputToken.symbol}
                              </Text>
                              <Text style={styles.tokenAmount}>
                                {formatAmount(step.pool.inputAmount, step.tokenIn?.decimals || inputToken.decimals)}
                              </Text>
                            </View>
                          </View>

                          <Ionicons
                            name="arrow-forward"
                            size={20}
                            color={themeColors.primary}
                          />

                          <View style={styles.tokenInfo}>
                            {renderTokenIcon(step.tokenOut, outputToken.symbol)}
                            <View>
                              <Text style={styles.tokenSymbol}>
                                {step.tokenOut?.symbol || outputToken.symbol}
                              </Text>
                              <Text style={styles.tokenAmount}>
                                {formatAmount(step.pool.outputAmount, step.tokenOut?.decimals || outputToken.decimals)}
                              </Text>
                            </View>
                          </View>
                        </View>

                        {/* Pool Info */}
                        <View style={styles.poolInfo}>
                          <View style={styles.poolInfoRow}>
                            <Text style={styles.poolInfoLabel}>Pool ID</Text>
                            <Text style={styles.poolInfoValue}>{step.pool.poolId}</Text>
                          </View>
                        </View>
                      </View>

                      {/* Arrow between steps */}
                      {index < routeSteps.length - 1 && (
                        <View style={styles.stepArrow}>
                          <Ionicons
                            name="chevron-down"
                            size={24}
                            color={themeColors.textMuted}
                          />
                        </View>
                      )}
                    </View>
                  ))}

                  {/* Final Output Summary */}
                  <View style={styles.finalSummary}>
                    <View style={styles.finalSummaryContent}>
                      <View style={styles.finalSummaryRow}>
                        <Text style={styles.finalSummaryLabel}>Estimated output</Text>
                        <Text style={styles.finalSummaryValue}>
                          {formatAmount(estimatedOutput || '0', outputToken.decimals)} {outputToken.symbol}
                        </Text>
                      </View>
                      <View style={styles.finalSummaryRow}>
                        <Text style={styles.finalSummaryLabel}>Minimum received</Text>
                        <Text style={styles.minimumValue}>
                          {formatAmount(minimumOutput || '0', outputToken.decimals)} {outputToken.symbol}
                        </Text>
                      </View>
                    </View>
                  </View>
                </>
              )}
            </ScrollView>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    backdrop: {
      flex: 1,
      width: '100%',
    },
    modalContainer: {
      backgroundColor: theme.colors.card,
      borderTopLeftRadius: theme.borderRadius.xl,
      borderTopRightRadius: theme.borderRadius.xl,
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.lg,
      height: Dimensions.get('window').height * 0.85,
      maxHeight: '85%',
      flexDirection: 'column',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.sm,
      flexShrink: 0,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    closeButton: {
      padding: theme.spacing.xs,
    },
    scrollContainer: {
      flex: 1,
      minHeight: 0,
      overflow: 'hidden',
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      paddingBottom: theme.spacing.sm,
    },
    loadingContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xl,
      gap: theme.spacing.sm,
    },
    loadingText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    summaryContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
      gap: theme.spacing.xs,
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    summaryLabel: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    summaryValue: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.text,
    },
    stepContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.sm,
      gap: theme.spacing.sm,
    },
    stepHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    stepNumber: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepNumberText: {
      fontSize: 12,
      fontWeight: '700',
      color: 'white',
    },
    dexName: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    tokenPair: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: theme.spacing.xs,
    },
    tokenInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      flex: 1,
    },
    tokenIcon: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: theme.colors.primary + '20',
      alignItems: 'center',
      justifyContent: 'center',
    },
    tokenIconText: {
      fontSize: 14,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    tokenSymbol: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.text,
    },
    tokenAmount: {
      fontSize: 11,
      color: theme.colors.textSecondary,
    },
    poolInfo: {
      paddingTop: theme.spacing.xs,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    poolInfoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    poolInfoLabel: {
      fontSize: 11,
      color: theme.colors.textMuted,
    },
    poolInfoValue: {
      fontSize: 11,
      fontWeight: '600',
      color: theme.colors.text,
    },
    stepArrow: {
      alignItems: 'center',
      paddingVertical: theme.spacing.xs,
    },
    finalSummary: {
      marginTop: theme.spacing.sm,
      backgroundColor: `${theme.colors.success}15`,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.sm,
    },
    finalSummaryContent: {
      gap: theme.spacing.xs,
    },
    finalSummaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    finalSummaryLabel: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    finalSummaryValue: {
      fontSize: 15,
      fontWeight: '700',
      color: theme.colors.success,
    },
    minimumValue: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.text,
    },
  });
