/**
 * ClaimAllConfirmationScreen - Confirmation screen for batch claiming multiple tokens
 *
 * Shows a summary of all tokens to be claimed and allows the user to confirm
 * the batch claim transaction.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Image,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation, CommonActions } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import algosdk from 'algosdk';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import AccountRecipientModal from '@/components/account/AccountRecipientModal';
import { NFTBackground } from '@/components/common/NFTBackground';
import UniversalHeader from '@/components/common/UniversalHeader';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { useActiveAccount } from '@/store/walletStore';
import { ClaimableItem, fromSerializableClaimableItem } from '@/types/claimable';
import { Arc200TransactionService, Arc200ClaimParams } from '@/services/transactions/arc200';
import VoiNetworkService, { NetworkService } from '@/services/network';
import EnvoiService, { EnvoiSearchResult } from '@/services/envoi';
import { normalizeAssetImageUrl } from '@/utils/assetImages';
import { resolveAddressOrName, isLikelyEnvoiName, formatAddress } from '@/utils/address';
import { NetworkId } from '@/types/network';
import { useCurrentNetworkConfig } from '@/store/networkStore';
import type { WalletStackParamList } from '@/navigation/AppNavigator';

// Claimable tokens are always on Voi network
const CLAIM_NETWORK_ID = NetworkId.VOI_MAINNET;

type ClaimAllRouteProp = RouteProp<WalletStackParamList, 'ClaimAllConfirmation'>;
type NavigationProp = NativeStackNavigationProp<WalletStackParamList, 'ClaimAllConfirmation'>;

/**
 * Formats a bigint token amount for display
 */
function formatTokenAmount(amount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  if (fractionalPart === 0n) {
    return wholePart.toLocaleString();
  }

  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
  const trimmedFractional = fractionalStr.replace(/0+$/, '');
  const displayFractional = trimmedFractional.slice(0, 4);

  return `${wholePart.toLocaleString()}.${displayFractional}`;
}

export default function ClaimAllConfirmationScreen() {
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();
  const themeColors = useThemeColors();
  const navigation = useNavigation<NavigationProp>();
  const route = useRoute<ClaimAllRouteProp>();

  const items = route.params.items.map(fromSerializableClaimableItem);
  const activeAccount = useActiveAccount();

  const [sendToSelf, setSendToSelf] = useState(true);
  const [recipientInput, setRecipientInput] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [isResolvingName, setIsResolvingName] = useState(false);
  const [nameResolutionError, setNameResolutionError] = useState<string | null>(null);
  const [isClaiming, setIsClaiming] = useState(false);
  const [estimatedFee, setEstimatedFee] = useState<number>(0);
  const [isRecipientModalVisible, setIsRecipientModalVisible] = useState(false);
  const [searchResults, setSearchResults] = useState<EnvoiSearchResult[]>([]);
  const [isSearchingNames, setIsSearchingNames] = useState(false);
  const hasSubmittedRef = useRef(false);

  const currentNetworkConfig = useCurrentNetworkConfig();
  const isEnvoiEnabled = currentNetworkConfig?.features?.envoi ?? false;

  const finalRecipientAddress = sendToSelf
    ? activeAccount?.address || ''
    : recipientAddress;

  // Resolve custom recipient address
  useEffect(() => {
    if (sendToSelf || !recipientInput.trim()) {
      setRecipientAddress('');
      setResolvedName(null);
      setNameResolutionError(null);
      return;
    }

    const input = recipientInput.trim();

    // Skip if already resolved
    if (recipientAddress && algosdk.isValidAddress(recipientAddress)) {
      if (input === recipientAddress || (resolvedName && input === resolvedName)) {
        return;
      }
    }

    const resolveRecipient = async () => {
      setIsResolvingName(true);
      setNameResolutionError(null);

      try {
        if (isLikelyEnvoiName(input)) {
          const resolved = await resolveAddressOrName(input);
          if (resolved) {
            setRecipientAddress(resolved);
            setResolvedName(input);
          } else {
            setNameResolutionError('Could not resolve name');
            setRecipientAddress('');
          }
        } else if (algosdk.isValidAddress(input)) {
          setRecipientAddress(input);
          setResolvedName(null);
        } else {
          setNameResolutionError('Invalid address');
          setRecipientAddress('');
        }
      } catch (error) {
        setNameResolutionError('Failed to resolve address');
        setRecipientAddress('');
      } finally {
        setIsResolvingName(false);
      }
    };

    const debounceTimer = setTimeout(resolveRecipient, 500);
    return () => clearTimeout(debounceTimer);
  }, [recipientInput, sendToSelf, recipientAddress, resolvedName]);

  // Search Envoi names as user types
  useEffect(() => {
    const trimmed = recipientInput.trim();

    if (!trimmed || !isEnvoiEnabled || sendToSelf) {
      setSearchResults([]);
      setIsSearchingNames(false);
      return;
    }

    const normalized = trimmed.toLowerCase();

    // Skip if already resolved to this name
    if (resolvedName && resolvedName.toLowerCase() === normalized) {
      setSearchResults([]);
      setIsSearchingNames(false);
      return;
    }

    // Skip if it's a valid address
    if (algosdk.isValidAddress(trimmed)) {
      setSearchResults([]);
      setIsSearchingNames(false);
      return;
    }

    // Only search if input looks like a name
    const looksLikeName = /^[a-z0-9-_.]+$/.test(normalized) && normalized.length >= 2;
    if (!looksLikeName) {
      setSearchResults([]);
      setIsSearchingNames(false);
      return;
    }

    let cancelled = false;

    const runSearch = async () => {
      try {
        setIsSearchingNames(true);
        const envoiService = EnvoiService.getInstance();
        const results = await envoiService.searchNames(normalized);
        if (cancelled) return;

        // Deduplicate by address and limit to 5 results
        const uniqueResults = results
          .filter(
            (result, index, arr) =>
              arr.findIndex((item) => item.address === result.address) === index
          )
          .slice(0, 5);

        setSearchResults(uniqueResults);
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to search Envoi names:', error);
          setSearchResults([]);
        }
      } finally {
        if (!cancelled) {
          setIsSearchingNames(false);
        }
      }
    };

    const timeoutId = setTimeout(runSearch, 350);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [recipientInput, resolvedName, isEnvoiEnabled, sendToSelf]);

  // Handle search result selection
  const handleSearchResultSelect = useCallback((result: EnvoiSearchResult) => {
    setRecipientInput(result.name);
    setResolvedName(result.name);
    setRecipientAddress(result.address);
    setNameResolutionError(null);
    setSearchResults([]);
    setIsSearchingNames(false);
  }, []);

  // Handle recipient selection from modal
  const handleRecipientSelect = useCallback((address: string, label?: string) => {
    setRecipientInput(address);
    setRecipientAddress(address);
    setResolvedName(label || null);
    setNameResolutionError(null);
    setIsRecipientModalVisible(false);
  }, []);

  // Estimate transaction fee (including MBR where needed)
  useEffect(() => {
    const estimateFee = async () => {
      if (!finalRecipientAddress || !algosdk.isValidAddress(finalRecipientAddress)) {
        // Default estimate assuming all need MBR (worst case)
        try {
          const costEstimate = await Arc200TransactionService.estimateClaimCost(
            items.length,
            items.length,
            CLAIM_NETWORK_ID
          );
          setEstimatedFee(costEstimate.total);
        } catch (error) {
          setEstimatedFee(1000 * items.length);
        }
        return;
      }

      try {
        // Check which tokens need MBR for the recipient
        const uniqueContractIds = [...new Set(items.map((item) => item.contractId))];
        let needsMbrCount = 0;

        for (const contractId of uniqueContractIds) {
          const hasBalance = await Arc200TransactionService.checkRecipientBalance(
            finalRecipientAddress,
            contractId
          );
          if (!hasBalance) {
            needsMbrCount++;
          }
        }

        const costEstimate = await Arc200TransactionService.estimateClaimCost(
          items.length,
          needsMbrCount,
          CLAIM_NETWORK_ID
        );
        setEstimatedFee(costEstimate.total);
      } catch (error) {
        console.error('Failed to estimate fee:', error);
        setEstimatedFee(1000 * items.length);
      }
    };
    estimateFee();
  }, [items, finalRecipientAddress]);

  // Handle batch claim - navigate to universal signing screen
  const handleClaimAll = useCallback(async () => {
    if (!activeAccount?.address || !finalRecipientAddress) {
      Alert.alert('Error', 'Missing account or recipient address');
      return;
    }

    if (!algosdk.isValidAddress(finalRecipientAddress)) {
      Alert.alert('Error', 'Invalid recipient address');
      return;
    }

    setIsClaiming(true);

    try {
      // Build claim params for each item
      const claimParams: Arc200ClaimParams[] = items.map((item) => ({
        contractId: item.contractId,
        from: item.owner,
        to: finalRecipientAddress,
        amount: item.amount,
        sender: activeAccount.address,
      }));

      // Build the batch transaction group (always on Voi network)
      const txnGroup = await Arc200TransactionService.buildBatchClaimTransactionGroup(
        claimParams,
        CLAIM_NETWORK_ID
      );

      // Encode transactions as base64 for UniversalTransactionSigning
      const base64Transactions = txnGroup.txnBytes.map((txnBytes) =>
        Buffer.from(txnBytes).toString('base64')
      );

      // Navigate to UniversalTransactionSigning screen with Voi network
      navigation.navigate('UniversalTransactionSigning' as any, {
        transactions: base64Transactions,
        account: activeAccount,
        title: `Claim ${items.length} Token${items.length > 1 ? 's' : ''}`,
        networkId: CLAIM_NETWORK_ID,
        onSuccess: async (result: any) => {
          // Guard against double submission
          if (hasSubmittedRef.current) {
            console.log('Transaction already submitted, skipping duplicate');
            return;
          }
          hasSubmittedRef.current = true;

          // Submit the signed transactions to Voi network
          try {
            const networkService = NetworkService.getInstance(CLAIM_NETWORK_ID);
            const algodClient = networkService.getAlgodClient();
            const signedTxns = result.signedTransactions.map(
              (txn: string) => new Uint8Array(Buffer.from(txn, 'base64'))
            );
            await algodClient.sendRawTransaction(signedTxns).do();
            
            // Navigate back to claimable tokens list with pending refresh
            navigation.dispatch(
              CommonActions.reset({
                index: 1,
                routes: [
                  { name: 'HomeMain' },
                  { name: 'ClaimableTokens', params: { pendingRefresh: true } },
                ],
              })
            );
          } catch (submitError) {
            const message = submitError instanceof Error ? submitError.message : 'Failed to submit transaction';
            Alert.alert('Submission Failed', message);
          }
        },
        onReject: async () => {
          // User cancelled - just go back
          navigation.goBack();
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build claim transactions';
      Alert.alert('Claim Failed', message);
    } finally {
      setIsClaiming(false);
    }
  }, [activeAccount, finalRecipientAddress, items, navigation]);

  const canClaim =
    activeAccount?.address &&
    finalRecipientAddress &&
    algosdk.isValidAddress(finalRecipientAddress) &&
    !isClaiming &&
    !isResolvingName;

  // Group items by token for summary
  const tokenSummary = items.reduce((acc, item) => {
    const key = item.contractId;
    if (!acc[key]) {
      acc[key] = {
        name: item.tokenName,
        symbol: item.tokenSymbol,
        decimals: item.tokenDecimals,
        imageUrl: item.tokenImageUrl,
        totalAmount: 0n,
        count: 0,
      };
    }
    acc[key].totalAmount += item.amount;
    acc[key].count += 1;
    return acc;
  }, {} as Record<number, { name: string; symbol: string; decimals: number; imageUrl?: string; totalAmount: bigint; count: number }>);

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Claim All Tokens"
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />

        <KeyboardAwareScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
        >
          {/* Summary Card */}
          <GlassCard variant="medium" padding="lg" style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>Claiming {items.length} Token{items.length > 1 ? 's' : ''}</Text>

            <View style={styles.tokenList}>
              {Object.entries(tokenSummary).map(([contractId, token]) => (
                <View key={contractId} style={styles.tokenRow}>
                  <TokenImage imageUrl={token.imageUrl} theme={theme} styles={styles} />
                  <View style={styles.tokenInfo}>
                    <Text style={styles.tokenName}>{token.name}</Text>
                    {token.count > 1 && (
                      <Text style={styles.tokenCount}>
                        from {token.count} source{token.count > 1 ? 's' : ''}
                      </Text>
                    )}
                  </View>
                  <View style={styles.tokenAmount}>
                    <Text style={styles.amountText}>
                      {formatTokenAmount(token.totalAmount, token.decimals)}
                    </Text>
                    <Text style={styles.symbolText}>{token.symbol}</Text>
                  </View>
                </View>
              ))}
            </View>
          </GlassCard>

          {/* Recipient Selection */}
          <GlassCard variant="light" padding="md" style={styles.recipientCard}>
            <View style={styles.recipientToggle}>
              <Text style={styles.recipientLabel}>Send to myself</Text>
              <Switch
                value={sendToSelf}
                onValueChange={setSendToSelf}
                trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                thumbColor="white"
              />
            </View>

            {!sendToSelf && (
              <View style={styles.customRecipientContainer}>
                <Text style={styles.inputLabel}>Recipient Address</Text>
                <View style={styles.inputWrapper}>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter address or .voi name"
                    placeholderTextColor={themeColors.placeholder}
                    value={recipientInput}
                    onChangeText={setRecipientInput}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <View style={styles.inputButtonsContainer}>
                    <TouchableOpacity
                      style={styles.inputButton}
                      onPress={() => setIsRecipientModalVisible(true)}
                    >
                      <Ionicons
                        name="people"
                        size={22}
                        color={themeColors.primary}
                      />
                    </TouchableOpacity>
                  </View>
                  {isResolvingName && (
                    <ActivityIndicator
                      size="small"
                      color={theme.colors.primary}
                      style={styles.inputLoader}
                    />
                  )}
                </View>
                {isEnvoiEnabled && isSearchingNames && (
                  <View style={styles.searchStatus}>
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                    <Text style={styles.searchStatusText}>Searching Envoi...</Text>
                  </View>
                )}
                {nameResolutionError && (
                  <Text style={styles.errorText}>{nameResolutionError}</Text>
                )}
                {resolvedName && recipientAddress && (
                  <Text style={styles.resolvedText}>
                    Resolved: {resolvedName} → {formatAddress(recipientAddress)}
                  </Text>
                )}
                {!resolvedName && recipientAddress && !isLikelyEnvoiName(recipientInput) && (
                  <Text style={styles.addressText}>
                    {formatAddress(recipientAddress)}
                  </Text>
                )}
                {/* Envoi Search Results */}
                {searchResults.length > 0 && (
                  <View style={styles.searchResults}>
                    {searchResults.map((result, index) => (
                      <TouchableOpacity
                        key={`${result.name}-${result.address}`}
                        style={[
                          styles.searchResultItem,
                          index === searchResults.length - 1 && styles.searchResultItemLast,
                        ]}
                        onPress={() => handleSearchResultSelect(result)}
                        activeOpacity={0.8}
                      >
                        {result.avatar ? (
                          <Image
                            source={{ uri: result.avatar }}
                            style={styles.searchResultAvatar}
                          />
                        ) : (
                          <View style={styles.searchResultFallbackAvatar}>
                            <Text style={styles.searchResultFallbackText}>
                              {result.name.charAt(0).toUpperCase()}
                            </Text>
                          </View>
                        )}
                        <View style={styles.searchResultContent}>
                          <Text style={styles.searchResultName}>{result.name}</Text>
                          <Text style={styles.searchResultAddress}>
                            {formatAddress(result.address)}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            )}
          </GlassCard>

          {/* Fee Estimate */}
          <View style={styles.feeContainer}>
            <Text style={styles.feeLabel}>Estimated Max Fee</Text>
            <Text style={styles.feeValue}>
              {(estimatedFee / 1_000_000).toFixed(6)} VOI
            </Text>
          </View>

          {/* Warning */}
          <View style={styles.warningContainer}>
            <Ionicons name="information-circle" size={20} color={theme.colors.warning} />
            <Text style={styles.warningText}>
              All tokens will be claimed in a single atomic transaction. If any claim fails, the entire transaction will be reverted.
            </Text>
          </View>

          {/* Claim Button */}
          <GlassButton
            label={isClaiming ? 'Claiming...' : `Claim ${items.length} Token${items.length > 1 ? 's' : ''}`}
            variant="primary"
            size="lg"
            onPress={handleClaimAll}
            disabled={!canClaim}
            loading={isClaiming}
            icon="flash"
            style={styles.claimButton}
          />
        </KeyboardAwareScrollView>

        {/* Account Recipient Modal */}
        <AccountRecipientModal
          isVisible={isRecipientModalVisible}
          onClose={() => setIsRecipientModalVisible(false)}
          onAccountSelect={handleRecipientSelect}
        />
      </SafeAreaView>
    </NFTBackground>
  );
}

// Helper component for token images
function TokenImage({ imageUrl, theme, styles }: { imageUrl?: string; theme: Theme; styles: any }) {
  const [error, setError] = useState(false);
  const normalizedUrl = normalizeAssetImageUrl(imageUrl);

  if (!normalizedUrl || error) {
    return (
      <View style={styles.tokenImagePlaceholder}>
        <Ionicons name="disc" size={20} color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <Image
      source={{ uri: normalizedUrl }}
      style={styles.tokenImage}
      onError={() => setError(true)}
    />
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
    summaryCard: {
      marginBottom: 16,
    },
    summaryTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 16,
      textAlign: 'center',
    },
    tokenList: {
      gap: 12,
    },
    tokenRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    tokenImage: {
      width: 36,
      height: 36,
      borderRadius: 18,
      marginRight: 12,
    },
    tokenImagePlaceholder: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: 12,
    },
    tokenInfo: {
      flex: 1,
    },
    tokenName: {
      fontSize: 15,
      fontWeight: '500',
      color: theme.colors.text,
    },
    tokenCount: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    tokenAmount: {
      alignItems: 'flex-end',
    },
    amountText: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    symbolText: {
      fontSize: 11,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    recipientCard: {
      marginBottom: 16,
    },
    recipientToggle: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    recipientLabel: {
      fontSize: 16,
      color: theme.colors.text,
      fontWeight: '500',
    },
    customRecipientContainer: {
      marginTop: 16,
      paddingTop: 16,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    inputLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: 8,
    },
    inputWrapper: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface,
      borderRadius: theme.borderRadius.md,
    },
    input: {
      flex: 1,
      paddingHorizontal: 16,
      paddingVertical: 12,
      fontSize: 16,
      color: theme.colors.text,
    },
    inputButtonsContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingRight: 8,
    },
    inputButton: {
      padding: 8,
    },
    inputLoader: {
      position: 'absolute',
      right: 50,
    },
    errorText: {
      fontSize: 12,
      color: theme.colors.error,
      marginTop: 6,
    },
    resolvedText: {
      fontSize: 12,
      color: theme.colors.success,
      marginTop: 6,
    },
    addressText: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 6,
    },
    searchStatus: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 6,
    },
    searchStatusText: {
      fontSize: 12,
      color: theme.colors.primary,
      marginLeft: 6,
    },
    searchResults: {
      marginTop: 8,
      backgroundColor: theme.mode === 'dark'
        ? 'rgba(30, 30, 40, 0.9)'
        : 'rgba(255, 255, 255, 0.85)',
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.mode === 'dark'
        ? 'rgba(255, 255, 255, 0.15)'
        : 'rgba(255, 255, 255, 0.5)',
      overflow: 'hidden',
    },
    searchResultItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    searchResultItemLast: {
      borderBottomWidth: 0,
    },
    searchResultAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      marginRight: 10,
      backgroundColor: theme.colors.surface,
    },
    searchResultFallbackAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      marginRight: 10,
      backgroundColor: theme.colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
    },
    searchResultFallbackText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    searchResultContent: {
      flex: 1,
    },
    searchResultName: {
      fontSize: 15,
      fontWeight: '500',
      color: theme.colors.text,
    },
    searchResultAddress: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    feeContainer: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: 4,
      marginBottom: 16,
    },
    feeLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    feeValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
    },
    warningContainer: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: theme.colors.warning + '15',
      borderRadius: theme.borderRadius.md,
      padding: 12,
      marginBottom: 24,
      gap: 10,
    },
    warningText: {
      flex: 1,
      fontSize: 13,
      color: theme.colors.warning,
      lineHeight: 18,
    },
    claimButton: {
      marginTop: 8,
    },
  });
