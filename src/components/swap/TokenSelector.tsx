/**
 * Token Selector Component
 * Allows users to select tokens for swapping
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  FlatList,
  TextInput,
  StyleSheet,
  TouchableWithoutFeedback,
  Animated,
  ActivityIndicator,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { Theme } from '../../constants/themes';
import { SnowballToken } from '../../services/snowball/types';
import SnowballApiService from '../../services/snowball';
import { useWalletStore } from '../../store/walletStore';
import { MimirApiService } from '../../services/mimir';
import { getTokenImageSource } from '../../utils/tokenImages';

interface TokenSelectorProps {
  visible: boolean;
  accountId: string;
  selectedTokenId?: number;
  excludeTokenId?: number;
  onClose: () => void;
  onSelect: (token: SnowballToken) => void;
}

interface TokenWithBalance extends SnowballToken {
  balance?: string;
  balanceFormatted?: string;
  usdValue?: string;
}

export const TokenSelector: React.FC<TokenSelectorProps> = ({
  visible,
  accountId,
  selectedTokenId,
  excludeTokenId,
  onClose,
  onSelect,
}) => {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [tokens, setTokens] = useState<TokenWithBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [slideAnim] = useState(new Animated.Value(0));

  const accountBalance = useWalletStore(state =>
    state.accountStates[accountId]?.balance
  );

  useEffect(() => {
    if (visible) {
      loadTokens();

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
      setSearchQuery('');
    }
  }, [visible]);

  const loadTokens = async () => {
    setLoading(true);
    try {
      const availableTokens = await SnowballApiService.getTokens();

      // Filter out wrapped tokens (is_wrapped = true)
      const unwrappedTokens = availableTokens.filter(token => !token.is_wrapped);

      // Enrich tokens with user balances
      const tokensWithBalances = await enrichTokensWithBalances(unwrappedTokens);

      // Filter out excluded token
      const filteredTokens = excludeTokenId
        ? tokensWithBalances.filter(t => t.id !== excludeTokenId)
        : tokensWithBalances;

      // Custom sort: VOI (0) first, aUSDC (302190) second, then alphabetical
      const sorted = filteredTokens.sort((a, b) => {
        const aId = typeof a.id === 'string' ? parseInt(a.id, 10) : a.id;
        const bId = typeof b.id === 'string' ? parseInt(b.id, 10) : b.id;

        // VOI always first
        if (aId === 0) return -1;
        if (bId === 0) return 1;

        // aUSDC (302190) always second
        if (aId === 302190) return -1;
        if (bId === 302190) return 1;

        // For remaining tokens, sort by balance first, then alphabetically
        const balanceA = parseFloat(a.balance || '0');
        const balanceB = parseFloat(b.balance || '0');

        if (balanceA > 0 && balanceB === 0) return -1;
        if (balanceA === 0 && balanceB > 0) return 1;
        if (balanceA > 0 && balanceB > 0) return balanceB - balanceA;

        // Both zero balance - sort alphabetically
        return a.symbol.localeCompare(b.symbol);
      });

      setTokens(sorted);
    } catch (error) {
      console.error('Error loading tokens:', error);
    } finally {
      setLoading(false);
    }
  };

  const enrichTokensWithBalances = async (
    tokens: SnowballToken[]
  ): Promise<TokenWithBalance[]> => {
    return Promise.all(
      tokens.map(async (token) => {
        try {
          // Ensure token.id is a number
          const tokenId = typeof token.id === 'string' ? parseInt(token.id, 10) : token.id;

          // For VOI (native token)
          if (tokenId === 0 || token.symbol === 'VOI') {
            const voiBalance = accountBalance?.amount ? String(accountBalance.amount) : '0';
            const balanceValue = parseFloat(voiBalance) / Math.pow(10, 6);

            // Calculate USD value from balance and voiPrice
            const voiPrice = accountBalance?.voiPrice || 0;
            const voiUsdValue = voiPrice > 0
              ? (balanceValue * voiPrice).toFixed(5).replace(/\.?0+$/, '')
              : undefined;

            return {
              ...token,
              id: tokenId,
              balance: voiBalance,
              balanceFormatted: balanceValue.toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 6,
              }),
              usdValue: voiUsdValue,
            };
          }

          // For ASA and ARC-200 tokens - check if user has balance
          if (accountBalance?.assets && Array.isArray(accountBalance.assets)) {
            // Check for ASA tokens first (using assetId)
            const asaAsset = accountBalance.assets.find(
              asset => asset.assetId === tokenId && asset.assetType === 'asa'
            );

            if (asaAsset) {
              const balanceValue =
                parseFloat(asaAsset.amount.toString()) / Math.pow(10, token.decimals);

              // Format USD value with max 5 decimals
              const assetUsdValue = asaAsset.usdValue
                ? parseFloat(asaAsset.usdValue).toFixed(5).replace(/\.?0+$/, '')
                : undefined;

              return {
                ...token,
                id: tokenId,
                balance: asaAsset.amount.toString(),
                balanceFormatted: balanceValue.toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: token.decimals,
                }),
                usdValue: assetUsdValue,
              };
            }

            // Check for ARC-200 tokens (using contractId)
            const arc200Asset = accountBalance.assets.find(
              asset => asset.contractId === tokenId && asset.assetType === 'arc200'
            );

            if (arc200Asset) {
              const balanceValue =
                parseFloat(arc200Asset.amount.toString()) / Math.pow(10, token.decimals);

              // Format USD value with max 5 decimals
              const assetUsdValue = arc200Asset.usdValue
                ? parseFloat(arc200Asset.usdValue).toFixed(5).replace(/\.?0+$/, '')
                : undefined;

              return {
                ...token,
                id: tokenId,
                balance: arc200Asset.amount.toString(),
                balanceFormatted: balanceValue.toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: token.decimals,
                }),
                usdValue: assetUsdValue,
              };
            }
          }

          // No balance
          return {
            ...token,
            id: tokenId,
            balance: '0',
            balanceFormatted: '0',
          };
        } catch (error) {
          console.error(`Error getting balance for token ${token.symbol}:`, error);
          return {
            ...token,
            balance: '0',
            balanceFormatted: '0',
          };
        }
      })
    );
  };

  const filteredTokens = useMemo(() => {
    if (!searchQuery.trim()) return tokens;

    const query = searchQuery.toLowerCase();
    return tokens.filter(
      token =>
        token.symbol.toLowerCase().includes(query) ||
        token.name.toLowerCase().includes(query) ||
        token.id.toString().includes(query)
    );
  }, [tokens, searchQuery]);

  const handleSelectToken = (token: SnowballToken) => {
    onSelect(token);
    onClose();
  };

  const renderTokenItem = ({ item }: { item: TokenWithBalance }) => {
    const isSelected = item.id === selectedTokenId;
    const hasBalance = parseFloat(item.balance || '0') > 0;

    const imageSource = getTokenImageSource(item);

    return (
      <TouchableOpacity
        style={[styles.tokenItem, isSelected && styles.tokenItemSelected]}
        onPress={() => handleSelectToken(item)}
        activeOpacity={0.7}
      >
        {/* Token Icon */}
        <View style={styles.tokenIconContainer}>
          {imageSource ? (
            imageSource.type === 'uri' ? (
              <Image
                source={{ uri: imageSource.uri }}
                style={styles.tokenIcon}
                defaultSource={require('../../../assets/icon.png')}
              />
            ) : (
              <Image
                source={imageSource.source}
                style={styles.tokenIcon}
              />
            )
          ) : (
            <View style={styles.tokenIconPlaceholder}>
              <Text style={styles.tokenIconText}>{item.symbol[0]}</Text>
            </View>
          )}
        </View>

        {/* Token Info */}
        <View style={styles.tokenInfo}>
          <View style={styles.tokenNameRow}>
            <Text style={styles.tokenSymbol}>{item.symbol}</Text>
            {item.verified && (
              <Ionicons name="checkmark-circle" size={16} color={theme.colors.success} />
            )}
          </View>
          <Text style={styles.tokenName} numberOfLines={1}>
            {item.name}
          </Text>
        </View>

        {/* Balance */}
        <View style={styles.balanceContainer}>
          {hasBalance ? (
            <>
              <Text style={styles.balanceAmount}>{item.balanceFormatted}</Text>
              {item.usdValue && parseFloat(item.usdValue) > 0 && (
                <Text style={styles.balanceUsd}>${item.usdValue}</Text>
              )}
            </>
          ) : (
            <Text style={styles.noBalance}>-</Text>
          )}
        </View>

        {/* Selection Indicator */}
        {isSelected && (
          <View style={styles.selectedIndicator}>
            <Ionicons name="checkmark" size={20} color="white" />
          </View>
        )}
      </TouchableOpacity>
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
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.overlay}>
          <TouchableWithoutFeedback>
            <Animated.View
              style={[
                styles.modalContainer,
                { transform: [{ translateY }] },
              ]}
            >
              {/* Header */}
              <View style={styles.header}>
                <Text style={styles.title}>Select Token</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                  <Ionicons name="close" size={24} color={theme.colors.text} />
                </TouchableOpacity>
              </View>

              {/* Search */}
              <View style={styles.searchContainer}>
                <Ionicons
                  name="search"
                  size={20}
                  color={theme.colors.textMuted}
                  style={styles.searchIcon}
                />
                <TextInput
                  style={styles.searchInput}
                  placeholder="Search tokens..."
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

              {/* Token List */}
              {loading ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="large" color={theme.colors.primary} />
                  <Text style={styles.loadingText}>Loading tokens...</Text>
                </View>
              ) : filteredTokens.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Ionicons name="search" size={48} color={theme.colors.textMuted} />
                  <Text style={styles.emptyText}>No tokens found</Text>
                  <Text style={styles.emptySubtext}>
                    {searchQuery
                      ? 'Try a different search term'
                      : 'No swappable tokens available'}
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={filteredTokens}
                  renderItem={renderTokenItem}
                  keyExtractor={item => item.id.toString()}
                  contentContainerStyle={styles.listContent}
                  showsVerticalScrollIndicator={false}
                  ItemSeparatorComponent={() => <View style={styles.separator} />}
                />
              )}
            </Animated.View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
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
    modalContainer: {
      backgroundColor: theme.colors.card,
      borderTopLeftRadius: theme.borderRadius.xl,
      borderTopRightRadius: theme.borderRadius.xl,
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xxl,
      maxHeight: '85%',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing.md,
    },
    title: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
    },
    closeButton: {
      padding: theme.spacing.xs,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.md,
      marginBottom: theme.spacing.md,
      height: 48,
    },
    searchIcon: {
      marginRight: theme.spacing.sm,
    },
    searchInput: {
      flex: 1,
      fontSize: 16,
      color: theme.colors.text,
      paddingVertical: theme.spacing.sm,
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
    emptyContainer: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.xxl,
      gap: theme.spacing.sm,
    },
    emptyText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginTop: theme.spacing.md,
    },
    emptySubtext: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      textAlign: 'center',
    },
    listContent: {
      paddingBottom: theme.spacing.md,
    },
    tokenItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      gap: theme.spacing.md,
    },
    tokenItemSelected: {
      backgroundColor: `${theme.colors.primary}10`,
      marginHorizontal: -theme.spacing.lg,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.borderRadius.lg,
    },
    tokenIconContainer: {
      width: 40,
      height: 40,
    },
    tokenIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
    },
    tokenIconPlaceholder: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: `${theme.colors.primary}20`,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tokenIconText: {
      fontSize: 18,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    tokenInfo: {
      flex: 1,
      gap: 2,
    },
    tokenNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    tokenSymbol: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    tokenName: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    balanceContainer: {
      alignItems: 'flex-end',
      gap: 2,
    },
    balanceAmount: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    balanceUsd: {
      fontSize: 12,
      color: theme.colors.textSecondary,
    },
    noBalance: {
      fontSize: 14,
      color: theme.colors.textMuted,
    },
    selectedIndicator: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: theme.spacing.sm,
    },
    separator: {
      height: 1,
      backgroundColor: theme.colors.border,
      marginLeft: 64,
    },
  });
