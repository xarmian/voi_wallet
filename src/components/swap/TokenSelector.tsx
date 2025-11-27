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
  KeyboardAvoidingView,
  Platform,
  Keyboard,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { Theme } from '../../constants/themes';
import { SwapService, SwapToken } from '../../services/swap';
import { NetworkId } from '../../types/network';
import { useWalletStore } from '../../store/walletStore';
import { NetworkService } from '../../services/network';
import { AccountBalance } from '../../types/wallet';
import { getTokenImageSource } from '../../utils/tokenImages';

interface TokenSelectorProps {
  visible: boolean;
  accountId: string;
  networkId?: NetworkId;
  selectedTokenId?: number;
  excludeTokenId?: number;
  /** If true, only show tokens the user owns (for "From" token selection) */
  ownedOnly?: boolean;
  onClose: () => void;
  onSelect: (token: SwapToken) => void;
}

interface TokenWithBalance extends SwapToken {
  balance?: string;
  balanceFormatted?: string;
  usdValue?: string;
}

export const TokenSelector: React.FC<TokenSelectorProps> = ({
  visible,
  accountId,
  networkId,
  selectedTokenId,
  excludeTokenId,
  ownedOnly = false,
  onClose,
  onSelect,
}) => {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [tokens, setTokens] = useState<TokenWithBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [slideAnim] = useState(new Animated.Value(0));
  const [networkBalance, setNetworkBalance] = useState<AccountBalance | null>(null);

  // Get account address from store
  const accounts = useWalletStore(state => state.wallet?.accounts);
  const currentAccount = accounts?.find(acc => acc.id === accountId);

  // Default single-network balance (for VOI)
  const singleNetworkBalance = useWalletStore(state =>
    state.accountStates[accountId]?.balance
  );

  // Load balance for the specific network when modal opens
  useEffect(() => {
    const loadNetworkBalance = async () => {
      if (!visible || !currentAccount?.address) return;

      setLoadingBalance(true);

      try {
        // For non-VOI networks, always fetch directly from NetworkService
        // This ensures we get the proper ASA balance structure
        if (networkId && networkId !== NetworkId.VOI_MAINNET) {
          const networkService = NetworkService.getInstance(networkId);
          const balance = await networkService.getAccountBalance(currentAccount.address);
          setNetworkBalance(balance);
        } else {
          // For VOI network, use the store balance
          setNetworkBalance(singleNetworkBalance || null);
        }
      } catch (error) {
        console.error('Error loading network balance:', error);
        setNetworkBalance(singleNetworkBalance || null);
      } finally {
        setLoadingBalance(false);
      }
    };

    loadNetworkBalance();
  }, [visible, currentAccount?.address, networkId, singleNetworkBalance]);

  // Use network-specific balance or fallback to single network balance
  const accountBalance = networkBalance || singleNetworkBalance;

  useEffect(() => {
    if (visible) {
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

  // Load tokens when modal opens and balance is available
  useEffect(() => {
    if (visible && accountBalance) {
      loadTokens();
    }
  }, [visible, accountBalance]);

  const loadTokens = async () => {
    setLoading(true);
    try {
      const provider = SwapService.getProvider(networkId);
      const availableTokens = await provider.getTokens();

      // Enrich tokens with user balances
      const tokensWithBalances = await enrichTokensWithBalances(availableTokens);

      // Filter out excluded token
      let filteredTokens = excludeTokenId
        ? tokensWithBalances.filter(t => t.id !== excludeTokenId)
        : tokensWithBalances;

      // If ownedOnly, filter to only tokens with balance > 0
      if (ownedOnly) {
        filteredTokens = filteredTokens.filter(t => parseFloat(t.balance || '0') > 0);
      }

      // Determine special token IDs based on network
      // VOI network: VOI (0) first, aUSDC (302190) second
      // Algorand: ALGO (0) first, USDC (31566704) second
      const nativeTokenId = 0;
      const stablecoinId = networkId === NetworkId.ALGORAND_MAINNET ? 31566704 : 302190;

      // Custom sort: Native token first, stablecoin second, then by balance, then alphabetically
      const sorted = filteredTokens.sort((a, b) => {
        const aId = a.id;
        const bId = b.id;

        // Native token always first
        if (aId === nativeTokenId) return -1;
        if (bId === nativeTokenId) return 1;

        // Stablecoin always second
        if (aId === stablecoinId) return -1;
        if (bId === stablecoinId) return 1;

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
    tokens: SwapToken[]
  ): Promise<TokenWithBalance[]> => {
    return Promise.all(
      tokens.map(async (token) => {
        try {
          const tokenId = token.id;

          // For native token (VOI/ALGO - id 0)
          if (tokenId === 0 || token.symbol === 'VOI' || token.symbol === 'ALGO') {
            const nativeBalance = accountBalance?.amount ? String(accountBalance.amount) : '0';
            const balanceValue = parseFloat(nativeBalance) / Math.pow(10, 6);

            // Calculate USD value from balance and price (use voiPrice or algoPrice)
            const nativePrice = networkId === NetworkId.ALGORAND_MAINNET
              ? (accountBalance?.algoPrice || 0)
              : (accountBalance?.voiPrice || 0);
            const nativeUsdValue = nativePrice > 0
              ? (balanceValue * nativePrice).toFixed(2)
              : undefined;

            return {
              ...token,
              balance: nativeBalance,
              balanceFormatted: balanceValue.toLocaleString(undefined, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 6,
              }),
              usdValue: nativeUsdValue,
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

              // Format USD value
              const assetUsdValue = asaAsset.usdValue
                ? parseFloat(asaAsset.usdValue).toFixed(2)
                : undefined;

              return {
                ...token,
                balance: asaAsset.amount.toString(),
                balanceFormatted: balanceValue.toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: Math.min(token.decimals, 6),
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

              // Format USD value
              const assetUsdValue = arc200Asset.usdValue
                ? parseFloat(arc200Asset.usdValue).toFixed(2)
                : undefined;

              return {
                ...token,
                balance: arc200Asset.amount.toString(),
                balanceFormatted: balanceValue.toLocaleString(undefined, {
                  minimumFractionDigits: 0,
                  maximumFractionDigits: Math.min(token.decimals, 6),
                }),
                usdValue: assetUsdValue,
              };
            }
          }

          // No balance
          return {
            ...token,
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

  const handleSelectToken = (token: SwapToken) => {
    Keyboard.dismiss();
    onSelect(token);
    onClose();
  };

  const renderTokenItem = ({ item }: { item: TokenWithBalance }) => {
    const isSelected = item.id === selectedTokenId;
    const hasBalance = parseFloat(item.balance || '0') > 0;

    const imageSource = getTokenImageSource(item, networkId);

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
          <Text style={styles.tokenId}>ID: {item.id}</Text>
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
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableWithoutFeedback onPress={onClose}>
          <View style={styles.overlay}>
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
              <Animated.View
                style={[
                  styles.modalContainer,
                  { transform: [{ translateY }] },
                ]}
              >
                {/* Header */}
                <View style={styles.header}>
                  <Text style={styles.title}>
                    {ownedOnly ? 'Select Token to Swap' : 'Select Token'}
                  </Text>
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
                    placeholder="Search by name, symbol, or ID..."
                    placeholderTextColor={theme.colors.textMuted}
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                  />
                  {searchQuery.length > 0 && (
                    <TouchableOpacity onPress={() => setSearchQuery('')}>
                      <Ionicons name="close-circle" size={20} color={theme.colors.textMuted} />
                    </TouchableOpacity>
                  )}
                </View>

                {/* Token List */}
                {loading || loadingBalance ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                    <Text style={styles.loadingText}>
                      {loadingBalance ? 'Loading balances...' : 'Loading tokens...'}
                    </Text>
                  </View>
                ) : filteredTokens.length === 0 ? (
                  <View style={styles.emptyContainer}>
                    <Ionicons name="search" size={48} color={theme.colors.textMuted} />
                    <Text style={styles.emptyText}>No tokens found</Text>
                    <Text style={styles.emptySubtext}>
                      {searchQuery
                        ? 'Try a different search term'
                        : ownedOnly
                          ? 'You don\'t have any tokens to swap'
                          : 'No swappable tokens available'}
                    </Text>
                  </View>
                ) : (
                  <FlatList
                    style={styles.tokenList}
                    data={filteredTokens}
                    renderItem={renderTokenItem}
                    keyExtractor={item => item.id.toString()}
                    contentContainerStyle={styles.listContent}
                    showsVerticalScrollIndicator={false}
                    ItemSeparatorComponent={() => <View style={styles.separator} />}
                    keyboardShouldPersistTaps="handled"
                  />
                )}
              </Animated.View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    keyboardView: {
      flex: 1,
    },
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
      height: '80%',
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
      flex: 1,
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
      flex: 1,
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
    tokenList: {
      flex: 1,
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
    tokenId: {
      fontSize: 11,
      color: theme.colors.textMuted,
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
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
      marginLeft: 56,
    },
  });
