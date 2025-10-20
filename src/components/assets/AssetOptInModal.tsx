import React, { useState, useCallback, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StyleSheet,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  submitAsaOptIn,
  validateAsaOptIn,
} from '../../services/transactions/asa';
import { NetworkService } from '../../services/network';
import UnifiedAuthModal from '../UnifiedAuthModal';
import { useWalletStore, useActiveAccount } from '../../store';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NetworkId } from '@/types/network';
import { getNetworkConfig, NETWORK_CONFIGURATIONS } from '@/services/network/config';

interface AssetInfo {
  assetId: number;
  name: string;
  unitName: string;
  total: number;
  decimals: number;
  creator: string;
  verified?: boolean;
}

interface SearchResult {
  index: number;
  params: {
    name?: string;
    'unit-name'?: string;
    total: number;
    decimals: number;
    creator: string;
  };
}

interface AssetOptInModalProps {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function AssetOptInModal({
  visible,
  onClose,
  onSuccess,
}: AssetOptInModalProps) {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const insets = useSafeAreaInsets();
  const activeAccount = useActiveAccount();
  const [selectedNetworkId, setSelectedNetworkId] = useState<NetworkId>('voi-mainnet');
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<AssetInfo | null>(null);
  const [mbrCost, setMbrCost] = useState<number>(0);
  const [error, setError] = useState<string>('');
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextToken, setNextToken] = useState<string | undefined>(undefined);
  const refreshAllBalances = useWalletStore(
    (state) => state.refreshAllBalances
  );

  const reset = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setSelectedAsset(null);
    setError('');
    setMbrCost(0);
    setLoadingMore(false);
    setHasMore(false);
    setNextToken(undefined);
    setShowAuthModal(false);
    setIsProcessing(false);
  }, []);

  useEffect(() => {
    if (!visible) {
      reset();
    }
  }, [visible, reset]);

  const searchAssets = async (loadMore = false) => {
    if (!searchQuery.trim()) {
      setError('Please enter an Asset ID or name');
      return;
    }

    if (loadMore) {
      setLoadingMore(true);
    } else {
      setSearching(true);
      setError('');
      setSearchResults([]);
      setSelectedAsset(null);
      setNextToken(undefined);
    }

    try {
      // Use the new search functionality with pagination
      const tokenToUse = loadMore ? nextToken : undefined;
      const networkService = NetworkService.getInstance(selectedNetworkId);
      const response = await networkService.searchAssets(
        searchQuery.trim(),
        20,
        tokenToUse
      );

      if (response.assets.length === 0 && !loadMore) {
        setError('No assets found');
        return;
      }

      if (loadMore) {
        setSearchResults((prev) => [...prev, ...response.assets]);
      } else {
        setSearchResults(response.assets);
      }

      setNextToken(response.nextToken);
      setHasMore(!!response.nextToken);

      // Debug logging
      console.log('Modal search response:', {
        assetsCount: response.assets.length,
        nextToken: response.nextToken,
        hasMore: !!response.nextToken,
        loadMore,
      });
    } catch (err) {
      setError(`Error searching for assets: ${err.message}`);
    } finally {
      if (loadMore) {
        setLoadingMore(false);
      } else {
        setSearching(false);
      }
    }
  };

  const loadMoreAssets = () => {
    if (hasMore && !loadingMore) {
      searchAssets(true);
    }
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const paddingToBottom = 100; // Trigger load more when 100px from bottom

    if (
      layoutMeasurement.height + contentOffset.y >=
      contentSize.height - paddingToBottom
    ) {
      loadMoreAssets();
    }
  };

  const selectAsset = async (result: SearchResult) => {
    setError('');

    if (!activeAccount) {
      setError('No active account found');
      return;
    }

    try {
      const asset: AssetInfo = {
        assetId: result.index,
        name: result.params.name || `Asset ${result.index}`,
        unitName: result.params['unit-name'] || '',
        total: result.params.total,
        decimals: result.params.decimals,
        creator: result.params.creator,
      };

      setSelectedAsset(asset);

      // Validate opt-in possibility
      const validation = await validateAsaOptIn(
        activeAccount.address,
        result.index,
        selectedNetworkId
      );

      if (!validation.valid) {
        setError(validation.error || 'Cannot opt-in to this asset');
      } else {
        setMbrCost(validation.mbrCost || 100000);
      }
    } catch (err) {
      setError(`Error validating asset: ${err.message}`);
    }
  };

  const handleOptIn = () => {
    if (!selectedAsset) {
      return;
    }

    setError('');
    setShowAuthModal(true);
  };

  const handleAuthSuccess = async (pin?: string) => {
    if (!selectedAsset || !activeAccount) {
      return;
    }

    setIsProcessing(true);
    setError('');

    try {
      const txId = await submitAsaOptIn(
        selectedAsset.assetId,
        activeAccount.address,
        selectedNetworkId,
        pin
      );

      const networkService = NetworkService.getInstance(selectedNetworkId);
      await networkService.waitForConfirmation(txId, 4);
      await refreshAllBalances();

      setShowAuthModal(false);

      Alert.alert('Success', `Successfully opted into ${selectedAsset.name}`, [
        {
          text: 'OK',
          onPress: () => {
            onSuccess();
            onClose();
          },
        },
      ]);
    } catch (err) {
      setError(`Failed to opt-in: ${err.message}`);
      setShowAuthModal(false);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAuthCancel = () => {
    if (!isProcessing) {
      setShowAuthModal(false);
    }
  };

  const formatAmount = (amount: number, decimals: number) => {
    if (decimals === 0) return amount.toString();
    const divisor = Math.pow(10, decimals);
    return (amount / divisor).toLocaleString();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View
        style={[
          styles.container,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={themeColors.textMuted} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Add Asset</Text>
          <View style={styles.headerSpacer} />
        </View>

        <KeyboardAwareScrollView
          style={styles.scrollView}
          onScroll={handleScroll}
          scrollEventThrottle={400}
          extraScrollHeight={50}
        >
            {/* Network Selector */}
            <View style={styles.networkSection}>
              <Text style={styles.inputLabel}>Network</Text>
              <View style={styles.networkSelectorContainer}>
                {Object.values(NETWORK_CONFIGURATIONS).map((config) => (
                  <TouchableOpacity
                    key={config.id}
                    style={[
                      styles.networkOption,
                      selectedNetworkId === config.id && styles.networkOptionSelected,
                    ]}
                    onPress={() => {
                      setSelectedNetworkId(config.id);
                      // Reset search results when network changes
                      setSearchResults([]);
                      setSelectedAsset(null);
                      setError('');
                    }}
                    disabled={isProcessing}
                  >
                    <View
                      style={[
                        styles.networkDot,
                        { backgroundColor: config.color },
                      ]}
                    />
                    <Text
                      style={[
                        styles.networkOptionText,
                        selectedNetworkId === config.id && styles.networkOptionTextSelected,
                      ]}
                    >
                      {config.name}
                    </Text>
                    {selectedNetworkId === config.id && (
                      <Ionicons
                        name="checkmark-circle"
                        size={20}
                        color={themeColors.primary}
                      />
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* Search Input */}
            <View style={styles.searchSection}>
              <Text style={styles.inputLabel}>Asset Search</Text>
              <View style={styles.searchInputContainer}>
                <TextInput
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  placeholder="Enter Asset ID or name"
                  placeholderTextColor={themeColors.textMuted}
                  style={styles.searchInput}
                  editable={!isProcessing}
                  onSubmitEditing={() => searchAssets()}
                  returnKeyType="search"
                />
                <TouchableOpacity
                  onPress={searchAssets}
                  disabled={searching || isProcessing}
                  style={styles.searchButton}
                >
                  {searching ? (
                    <ActivityIndicator
                      size="small"
                      color={themeColors.primary}
                    />
                  ) : (
                    <Ionicons
                      name="search"
                      size={20}
                      color={themeColors.primary}
                    />
                  )}
                </TouchableOpacity>
              </View>
            </View>

            {/* Error Message */}
            {error && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Search Results */}
            {searchResults.length > 0 && !selectedAsset && (
              <View style={styles.searchResultsContainer}>
                <Text style={styles.searchResultsTitle}>
                  Search Results ({searchResults.length}
                  {hasMore ? '+' : ''})
                </Text>
                {searchResults.map((result) => (
                  <TouchableOpacity
                    key={result.index}
                    style={styles.searchResultItem}
                    onPress={() => selectAsset(result)}
                  >
                    <View style={styles.searchResultContent}>
                      <Text style={styles.searchResultName}>
                        {result.params.name || `Asset ${result.index}`}
                      </Text>
                      {result.params['unit-name'] && (
                        <Text style={styles.searchResultSymbol}>
                          {result.params['unit-name']}
                        </Text>
                      )}
                      <Text style={styles.searchResultId}>
                        ID: {result.index}
                      </Text>
                    </View>
                    <Ionicons
                      name="chevron-forward"
                      size={20}
                      color={themeColors.textMuted}
                    />
                  </TouchableOpacity>
                ))}

                {/* Load More Indicator */}
                {loadingMore && (
                  <View style={styles.loadingMoreContainer}>
                    <ActivityIndicator
                      size="small"
                      color={themeColors.primary}
                    />
                    <Text style={styles.loadingMoreText}>
                      Loading more assets...
                    </Text>
                  </View>
                )}

                {/* Load More Button (fallback for manual loading) */}
                {hasMore && !loadingMore && (
                  <TouchableOpacity
                    style={styles.loadMoreButton}
                    onPress={loadMoreAssets}
                  >
                    <Ionicons
                      name="chevron-down"
                      size={20}
                      color={themeColors.primary}
                    />
                    <Text style={styles.loadMoreText}>Load More Assets</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Selected Asset Info */}
            {selectedAsset && !error && (
              <View style={styles.assetInfoContainer}>
                <Text style={styles.assetName}>{selectedAsset.name}</Text>
                {selectedAsset.unitName && (
                  <Text style={styles.assetUnitName}>
                    {selectedAsset.unitName}
                  </Text>
                )}

                <View style={styles.assetDetails}>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Asset ID</Text>
                    <Text style={styles.detailValue}>
                      {selectedAsset.assetId}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Total Supply</Text>
                    <Text style={styles.detailValue}>
                      {formatAmount(
                        selectedAsset.total,
                        selectedAsset.decimals
                      )}
                    </Text>
                  </View>
                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Decimals</Text>
                    <Text style={styles.detailValue}>
                      {selectedAsset.decimals}
                    </Text>
                  </View>
                </View>

                {/* MBR Cost Warning */}
                <View style={styles.warningContainer}>
                  <View style={styles.warningContent}>
                    <Ionicons
                      name="information-circle"
                      size={16}
                      color={themeColors.warning}
                    />
                    <Text style={styles.warningText}>
                      Opting in requires {(mbrCost / 1000000).toFixed(1)} VOI to
                      be locked for minimum balance
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Action Buttons */}
            {selectedAsset && !error && (
              <View style={styles.actionButtons}>
                <TouchableOpacity
                  onPress={onClose}
                  disabled={isProcessing}
                  style={styles.cancelButton}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleOptIn}
                  disabled={isProcessing}
                  style={styles.optInButton}
                >
                  {isProcessing ? (
                    <ActivityIndicator size="small" color="white" />
                  ) : (
                    <Text style={styles.optInButtonText}>Opt In</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
        </KeyboardAwareScrollView>
      </View>

      <UnifiedAuthModal
        visible={showAuthModal}
        onSuccess={handleAuthSuccess}
        onCancel={handleAuthCancel}
        title="Authorize Asset Opt-In"
        message={
          selectedAsset
            ? `Authenticate to opt into ${selectedAsset.name}`
            : 'Authenticate to complete the opt-in'
        }
        purpose="sign_transaction"
        isProcessing={isProcessing}
      />
    </Modal>
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
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    closeButton: {
      padding: theme.spacing.xs,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    headerSpacer: {
      width: 40,
    },
    scrollView: {
      flex: 1,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    networkSection: {
      marginBottom: theme.spacing.lg,
    },
    networkSelectorContainer: {
      flexDirection: 'row',
      gap: theme.spacing.xs,
    },
    networkOption: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      borderWidth: 2,
      borderColor: 'transparent',
      gap: theme.spacing.sm,
    },
    networkOptionSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.surface,
    },
    networkDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    networkOptionText: {
      flex: 1,
      fontSize: 16,
      color: theme.colors.text,
      fontWeight: '500',
    },
    networkOptionTextSelected: {
      color: theme.colors.primary,
      fontWeight: '600',
    },
    searchSection: {
      marginBottom: theme.spacing.xl,
    },
    inputLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
    },
    searchInputContainer: {
      flexDirection: 'row',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      alignItems: 'center',
    },
    searchInput: {
      flex: 1,
      color: theme.colors.text,
      fontSize: 16,
    },
    searchButton: {
      marginLeft: theme.spacing.sm,
      padding: theme.spacing.xs,
    },
    errorContainer: {
      backgroundColor: theme.colors.error + '20',
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.md,
    },
    errorText: {
      color: theme.colors.error,
      fontSize: 14,
    },
    searchResultsContainer: {
      marginBottom: theme.spacing.xl,
    },
    searchResultsTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    searchResultItem: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    searchResultContent: {
      flex: 1,
    },
    searchResultName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs / 2,
    },
    searchResultSymbol: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs / 2,
    },
    searchResultId: {
      fontSize: 12,
      color: theme.colors.textMuted,
    },
    loadMoreButton: {
      backgroundColor: theme.colors.background,
      borderColor: theme.colors.primary,
      borderWidth: 1,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.sm,
      marginTop: theme.spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    loadMoreText: {
      color: theme.colors.primary,
      fontSize: 14,
      fontWeight: '600',
    },
    loadingMoreContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    loadingMoreText: {
      color: theme.colors.textSecondary,
      fontSize: 14,
    },
    assetInfoContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.xl,
    },
    assetName: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    assetUnitName: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.md,
    },
    assetDetails: {
      gap: theme.spacing.sm,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    detailLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    detailValue: {
      fontSize: 14,
      color: theme.colors.text,
    },
    warningContainer: {
      backgroundColor: theme.colors.warning + '20',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.sm,
      marginTop: theme.spacing.md,
    },
    warningContent: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    warningText: {
      color: theme.colors.warning,
      fontSize: 14,
      marginLeft: theme.spacing.xs,
      flex: 1,
    },
    actionButtons: {
      flexDirection: 'row',
      gap: theme.spacing.sm,
    },
    cancelButton: {
      flex: 1,
      backgroundColor: theme.colors.card,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
    },
    cancelButtonText: {
      color: theme.colors.textSecondary,
      fontSize: 16,
      fontWeight: '600',
    },
    optInButton: {
      flex: 1,
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
    },
    optInButtonText: {
      color: 'white',
      fontSize: 16,
      fontWeight: '600',
    },
  });
