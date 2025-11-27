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
import { Route, RoutePool, RouteHop, SnowballToken } from '../../services/snowball/types';
import SnowballApiService from '../../services/snowball';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { getTokenImageSource } from '../../utils/tokenImages';

interface RouteDetailModalProps {
  visible: boolean;
  route: Route;
  inputToken: SnowballToken;
  outputToken: SnowballToken;
  onClose: () => void;
}

interface RouteStep {
  pool: RoutePool;
  hopIndex: number;
  poolIndex: number;
  tokenIn?: SnowballToken;
  tokenOut?: SnowballToken;
}

export const RouteDetailModal: React.FC<RouteDetailModalProps> = ({
  visible,
  route,
  inputToken,
  outputToken,
  onClose,
}) => {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();

  const [routeSteps, setRouteSteps] = useState<RouteStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [slideAnim] = useState(new Animated.Value(0));
  const [intermediateTokens, setIntermediateTokens] = useState<Map<string, SnowballToken>>(new Map());

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
      const tokenMap = new Map<string, SnowballToken>();

      // Fetch intermediate tokens for multi-hop routes
      if (route.type === 'multi-hop' && route.hops && Array.isArray(route.hops)) {
        const tokenIdsToFetch = new Set<string>();
        
        // Collect all intermediate token IDs from hops
        route.hops.forEach((hop, hopIndex) => {
          // For all hops except the last, the outputToken is an intermediate token
          if (hopIndex < route.hops!.length - 1) {
            tokenIdsToFetch.add(hop.outputToken);
          }
        });

        // Fetch intermediate tokens
        for (const tokenId of tokenIdsToFetch) {
          try {
            const tokenIdNum = parseInt(tokenId, 10);
            if (!isNaN(tokenIdNum)) {
              const token = await SnowballApiService.getTokenById(tokenIdNum);
              if (token) {
                tokenMap.set(tokenId, token);
              }
            }
          } catch (error) {
            console.warn(`RouteDetailModal: Failed to fetch token ${tokenId}:`, error);
          }
        }
      }

      setIntermediateTokens(tokenMap);

      // Check if route has a type property
      if (!route.type) {
        console.warn('RouteDetailModal: Route missing type property, attempting to infer from structure');
        
        // Try to infer route type from structure
        if (route.pools && Array.isArray(route.pools) && route.pools.length > 0) {
          // Treat as direct route if pools exist
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
        } else if (route.hops && Array.isArray(route.hops) && route.hops.length > 0) {
          // Treat as multi-hop route if hops exist
          steps = route.hops.flatMap((hop, hopIndex) => {
            if (!hop.pools || !Array.isArray(hop.pools) || hop.pools.length === 0) {
              return [];
            }
            return hop.pools.map((pool, poolIndex) => {
              const isFirstPool = hopIndex === 0 && poolIndex === 0;
              const isLastPool =
                hopIndex === route.hops!.length - 1 &&
                poolIndex === hop.pools.length - 1;

              // Get intermediate token for this hop
              const intermediateToken = hopIndex < route.hops!.length - 1 
                ? tokenMap.get(hop.outputToken) 
                : undefined;

              return {
                pool,
                hopIndex,
                poolIndex,
                tokenIn: isFirstPool ? inputToken : intermediateToken,
                tokenOut: isLastPool ? outputToken : intermediateToken,
              };
            });
          });
        }
      } else {
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
            
            // Get tokens for this hop
            // For first hop: inputToken is the swap inputToken, outputToken is intermediate
            // For subsequent hops: inputToken is previous hop's outputToken (intermediate), outputToken is next intermediate or final outputToken
            const hopInputToken = hopIndex === 0 
              ? inputToken 
              : tokenMap.get(hop.inputToken);
            const hopOutputToken = hopIndex === route.hops!.length - 1
              ? outputToken
              : tokenMap.get(hop.outputToken);

            return hop.pools.map((pool, poolIndex) => {
              // First pool of hop uses hop's inputToken
              const isFirstPoolInHop = poolIndex === 0;
              // Last pool of hop uses hop's outputToken
              const isLastPoolInHop = poolIndex === hop.pools.length - 1;

              let tokenIn: SnowballToken | undefined;
              let tokenOut: SnowballToken | undefined;

              if (isFirstPoolInHop && isLastPoolInHop) {
                // Single pool in hop
                tokenIn = hopInputToken;
                tokenOut = hopOutputToken;
              } else if (isFirstPoolInHop) {
                // First pool: input is hop's inputToken, output is intermediate (hop's outputToken)
                tokenIn = hopInputToken;
                tokenOut = hopOutputToken;
              } else if (isLastPoolInHop) {
                // Last pool: input is intermediate (hop's inputToken), output is hop's outputToken
                tokenIn = hopInputToken;
                tokenOut = hopOutputToken;
              } else {
                // Middle pools: both are intermediate (hop's outputToken, which is the intermediate)
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

  const renderTokenIcon = (token: SnowballToken | undefined, fallbackSymbol: string) => {
    if (!token) {
      return (
        <View style={styles.tokenIcon}>
          <Text style={styles.tokenIconText}>{fallbackSymbol[0]}</Text>
        </View>
      );
    }

    const imageSource = getTokenImageSource(token);

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
                      <Text style={styles.finalSummaryLabel}>You receive</Text>
                      <Text style={styles.finalSummaryValue}>
                        {formatAmount(
                          routeSteps[routeSteps.length - 1]?.pool.outputAmount || '0',
                          outputToken.decimals
                        )}{' '}
                        {outputToken.symbol}
                      </Text>
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
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
      height: Dimensions.get('window').height * 0.9,
      maxHeight: '90%',
      flexDirection: 'column',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.lg,
      flexShrink: 0,
    },
    title: {
      fontSize: 20,
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
      paddingBottom: theme.spacing.lg,
    },
    loadingContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xxl,
      gap: theme.spacing.md,
    },
    loadingText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    summaryContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.sm,
    },
    summaryRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    summaryLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    summaryValue: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    stepContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      gap: theme.spacing.md,
    },
    stepHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    stepNumber: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepNumberText: {
      fontSize: 14,
      fontWeight: '700',
      color: 'white',
    },
    dexName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    tokenPair: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: theme.spacing.sm,
    },
    tokenInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      flex: 1,
    },
    tokenIcon: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.colors.primary + '20',
      alignItems: 'center',
      justifyContent: 'center',
    },
    tokenIconText: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    tokenSymbol: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    tokenAmount: {
      fontSize: 12,
      color: theme.colors.textSecondary,
    },
    poolInfo: {
      paddingTop: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
      gap: theme.spacing.xs,
    },
    poolInfoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    poolInfoLabel: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    poolInfoValue: {
      fontSize: 12,
      fontWeight: '600',
      color: theme.colors.text,
    },
    stepArrow: {
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
    },
    finalSummary: {
      marginTop: theme.spacing.lg,
      backgroundColor: `${theme.colors.success}20`,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
    },
    finalSummaryContent: {
      gap: theme.spacing.xs,
    },
    finalSummaryLabel: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      fontWeight: '600',
    },
    finalSummaryValue: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.colors.success,
    },
  });
