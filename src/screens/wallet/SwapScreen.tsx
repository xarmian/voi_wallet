/**
 * Swap Screen
 * Allows users to swap tokens on Voi Network using Snowball DEX aggregator
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation } from '@react-navigation/native';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useActiveAccount, useWalletStore } from '@/store/walletStore';
import UniversalHeader from '@/components/common/UniversalHeader';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { TokenSelector } from '@/components/swap/TokenSelector';
import { SwapQuoteDisplay } from '@/components/swap/SwapQuoteDisplay';
import { RouteDetailModal } from '@/components/swap/RouteDetailModal';
import {
  SlippageSettingsModal,
  getStoredSlippage,
} from '@/components/swap/SlippageSettingsModal';
import AccountListModal from '@/components/account/AccountListModal';
import SnowballApiService from '@/services/snowball';
import { SnowballToken, SwapQuote } from '@/services/snowball/types';
import { NetworkId } from '@/types/network';
import VoiNetworkService from '@/services/network';
import algosdk from 'algosdk';
import UnifiedAuthModal from '@/components/UnifiedAuthModal';
import { getTokenImageSource } from '@/utils/tokenImages';

interface SwapScreenRouteParams {
  assetName?: string;
  assetId?: number;
  accountId: string;
  networkId?: NetworkId;
}

const VOI_TOKEN_ID = 0; // VOI is the native token with ID 0

export default function SwapScreen() {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const navigation = useNavigation();
  const route = useRoute();
  const routeParams = route.params as SwapScreenRouteParams | undefined;

  const activeAccount = useActiveAccount();
  const accountId = routeParams?.accountId || activeAccount?.id;

  // Get account balance from store
  const accountBalance = useWalletStore(state =>
    accountId ? state.accountStates[accountId]?.balance : undefined
  );

  // Load balance if not available
  const loadAccountBalance = useWalletStore(state => state.loadAccountBalance);

  useEffect(() => {
    if (accountId && !accountBalance) {
      loadAccountBalance(accountId);
    }
  }, [accountId, accountBalance, loadAccountBalance]);

  // Token selection state
  const [inputToken, setInputToken] = useState<SnowballToken | null>(null);
  const [outputToken, setOutputToken] = useState<SnowballToken | null>(null);
  const [showInputTokenSelector, setShowInputTokenSelector] = useState(false);
  const [showOutputTokenSelector, setShowOutputTokenSelector] = useState(false);

  // Amount and quote state
  const [inputAmount, setInputAmount] = useState('');
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Slippage and route modals
  const [slippage, setSlippage] = useState(1.0);
  const [showSlippageModal, setShowSlippageModal] = useState(false);
  const [showRouteModal, setShowRouteModal] = useState(false);

  // Transaction state
  const [isSwapping, setIsSwapping] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);

  // Account selector state
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);

  // Load initial tokens
  useEffect(() => {
    loadInitialTokens();
    loadStoredSlippage();
  }, [routeParams]);

  const loadInitialTokens = async () => {
    try {
      // Set input token based on route params or default to VOI
      if (routeParams?.assetId !== undefined) {
        const token = await SnowballApiService.getTokenById(routeParams.assetId);
        if (token) {
          setInputToken(token);
        }
      }

      // Default output token to VOI if input is not VOI
      if (routeParams?.assetId !== VOI_TOKEN_ID) {
        const voiToken = await SnowballApiService.getTokenById(VOI_TOKEN_ID);
        if (voiToken) {
          setOutputToken(voiToken);
        }
      }
    } catch (error) {
      console.error('Error loading initial tokens:', error);
    }
  };

  const loadStoredSlippage = async () => {
    const stored = await getStoredSlippage();
    setSlippage(stored);
  };

  // Fetch quote when amount or tokens change
  useEffect(() => {
    if (inputToken && outputToken && inputAmount && parseFloat(inputAmount) > 0) {
      fetchQuote();
    } else {
      setQuote(null);
      setQuoteError(null);
    }
  }, [inputToken, outputToken, inputAmount, slippage]);

  const fetchQuote = async () => {
    if (!inputToken || !outputToken || !inputAmount || !activeAccount) return;

    const amountValue = parseFloat(inputAmount);
    if (isNaN(amountValue) || amountValue <= 0) {
      setQuoteError('Please enter a valid amount');
      return;
    }

    setQuoteLoading(true);
    setQuoteError(null);

    try {
      // Convert amount to base units
      const amountInBaseUnits = BigInt(
        Math.floor(amountValue * Math.pow(10, inputToken.decimals))
      ).toString();

      const quoteResponse = await SnowballApiService.getQuote({
        inputToken: inputToken.id,
        outputToken: outputToken.id,
        amount: amountInBaseUnits,
        address: activeAccount.address,
        slippageTolerance: slippage / 100, // Convert percentage to decimal
      });

      setQuote(quoteResponse);
    } catch (error) {
      console.error('Error fetching quote:', error);
      setQuoteError(
        error instanceof Error
          ? error.message
          : 'Failed to get quote. Please try again.'
      );
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  };

  const handleSwapTokens = () => {
    // Swap input and output tokens
    const temp = inputToken;
    setInputToken(outputToken);
    setOutputToken(temp);

    // Clear amount and quote
    setInputAmount('');
    setQuote(null);
    setQuoteError(null);
  };

  const handleInputAmountChange = (text: string) => {
    // Allow only numbers and decimal point
    const cleaned = text.replace(/[^0-9.]/g, '');

    // Prevent multiple decimal points
    const parts = cleaned.split('.');
    const formatted = parts.length > 2 ? `${parts[0]}.${parts.slice(1).join('')}` : cleaned;

    setInputAmount(formatted);
  };

  const handleMaxPress = () => {
    if (!inputToken || !accountBalance) return;

    try {
      let maxAmount = '0';

      if (inputToken.id === VOI_TOKEN_ID) {
        // For VOI, account for transaction fees (reserve ~0.1 VOI for fees)
        const balance = BigInt(accountBalance.amount || '0');
        const reserveForFees = BigInt(100000); // 0.1 VOI in microAlgos
        const maxBalance = balance > reserveForFees ? balance - reserveForFees : BigInt(0);
        const value = Number(maxBalance) / Math.pow(10, 6);
        maxAmount = value.toFixed(6);
      } else {
        // For ARC-200 tokens
        const asset = accountBalance.assets?.find(
          a => a.contractId === inputToken.id && a.assetType === 'arc200'
        );

        if (asset) {
          const balance = BigInt(asset.amount);
          const value = Number(balance) / Math.pow(10, inputToken.decimals);
          maxAmount = value.toFixed(inputToken.decimals);
        }
      }

      // Remove trailing zeros
      maxAmount = maxAmount.replace(/\.?0+$/, '');
      setInputAmount(maxAmount);
    } catch (error) {
      console.error('Error calculating max amount:', error);
    }
  };

  const handleSlippageSave = (newSlippage: number) => {
    setSlippage(newSlippage);
  };

  // Account selector handlers
  const handleAccountSelectorPress = () => {
    setIsAccountModalVisible(true);
  };

  const handleAccountModalClose = () => {
    setIsAccountModalVisible(false);
  };

  const handleAccountSelect = (selectedAccountId: string) => {
    // Update route params with the new accountId
    navigation.setParams({
      ...(routeParams || {}),
      accountId: selectedAccountId,
    } as SwapScreenRouteParams);
    setIsAccountModalVisible(false);
  };

  const handleAddAccount = () => {
    setIsAccountModalVisible(false);
    // Navigation to add account can be handled here if needed
  };

  const handleReviewSwap = () => {
    if (!quote || !quote.quote || !inputToken || !outputToken || !activeAccount) {
      Alert.alert('Error', 'Missing required swap information');
      return;
    }

    // Show confirmation alert - convert from base units to display units
    const outputAmount = parseFloat(quote.quote.outputAmount) / Math.pow(10, outputToken.decimals);
    const minOutput = parseFloat(quote.quote.minimumOutputAmount) / Math.pow(10, outputToken.decimals);

    Alert.alert(
      'Confirm Swap',
      `Swap ${inputAmount} ${inputToken.symbol} for approximately ${outputAmount.toFixed(Math.min(outputToken.decimals, 6))} ${outputToken.symbol}?\n\nMinimum received: ${minOutput.toFixed(Math.min(outputToken.decimals, 6))} ${outputToken.symbol}\nPrice impact: ${quote.quote.priceImpact.toFixed(2)}%`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => setShowAuthModal(true),
        },
      ]
    );
  };

  const handleSwapExecute = async (pin?: string) => {
    if (!quote || !inputToken || !outputToken || !activeAccount) return;

    setIsSwapping(true);

    try {
      // Get unsigned transactions from quote
      if (!quote.unsignedTransactions || quote.unsignedTransactions.length === 0) {
        throw new Error('No transactions returned from quote');
      }

      const networkService = VoiNetworkService.getInstance();

      // Decode and sign each transaction
      const signedTxns: Uint8Array[] = [];

      for (const txnBase64 of quote.unsignedTransactions) {
        const txnBytes = Buffer.from(txnBase64, 'base64');
        const txn = algosdk.decodeUnsignedTransaction(txnBytes);

        // Sign the transaction
        if (!pin) {
          throw new Error('PIN required for signing');
        }

        // Import the SecureKeyManager for PIN-based signing
        const { SecureKeyManager } = await import('@/services/secure/keyManager');
        const keyManager = SecureKeyManager.getInstance();
        const privateKey = await keyManager.getPrivateKey(activeAccount.id, pin);

        if (!privateKey) {
          throw new Error('Failed to retrieve private key');
        }

        const signedTxn = txn.signTxn(privateKey);
        signedTxns.push(signedTxn);
      }

      // Submit transaction group
      const txId = await networkService.submitTransaction(signedTxns);

      // Show success message
      Alert.alert(
        'Swap Successful',
        `Your swap has been submitted!\n\nTransaction ID: ${txId}`,
        [
          {
            text: 'OK',
            onPress: () => {
              // Refresh balances
              useWalletStore.getState().refreshAllBalances();
              // Navigate back
              navigation.goBack();
            },
          },
        ]
      );
    } catch (error) {
      console.error('Error executing swap:', error);
      Alert.alert(
        'Swap Failed',
        error instanceof Error
          ? error.message
          : 'Failed to execute swap. Please try again.'
      );
    } finally {
      setIsSwapping(false);
      setShowAuthModal(false);
    }
  };

  const getInputBalance = (): string => {
    if (!inputToken || !accountBalance) return '0';

    try {
      const tokenId = typeof inputToken.id === 'string' ? parseInt(inputToken.id, 10) : inputToken.id;

      if (tokenId === VOI_TOKEN_ID || inputToken.symbol === 'VOI') {
        const balance = BigInt(accountBalance.amount || '0');
        const value = Number(balance) / Math.pow(10, 6);
        return value.toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 6,
        });
      }

      const asset = accountBalance.assets?.find(
        a => a.contractId === tokenId && a.assetType === 'arc200'
      );

      if (asset) {
        const balance = BigInt(asset.amount);
        const value = Number(balance) / Math.pow(10, inputToken.decimals);
        return value.toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: inputToken.decimals,
        });
      }
    } catch (error) {
      console.error('Error getting balance:', error);
    }

    return '0';
  };

  const isSwapDisabled = (): boolean => {
    if (!inputToken || !outputToken || !inputAmount || !quote || isSwapping || quoteLoading) {
      return true;
    }

    const amount = parseFloat(inputAmount);
    if (isNaN(amount) || amount <= 0) {
      return true;
    }

    return false;
  };

  const renderTokenIcon = (token: SnowballToken | null) => {
    if (!token) return null;

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
      <View style={styles.tokenIconPlaceholder}>
        <Text style={styles.tokenIconText}>{token.symbol[0]}</Text>
      </View>
    );
  };

  if (!activeAccount || !accountId) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader title="Swap" onBackPress={() => navigation.goBack()} />
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>No account selected</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Swap Tokens"
          onBackPress={() => navigation.goBack()}
          onAccountSelectorPress={handleAccountSelectorPress}
        />

      <KeyboardAwareScrollView contentContainerStyle={styles.scrollContent}>
        {/* Input Token Section */}
        <View style={styles.tokenSection}>
          <Text style={styles.sectionLabel}>You pay</Text>
          <View style={styles.tokenCard}>
            {/* Amount Input */}
            <View style={styles.amountRow}>
              <TextInput
                style={styles.amountInput}
                value={inputAmount}
                onChangeText={handleInputAmountChange}
                placeholder="0.0"
                placeholderTextColor={themeColors.textMuted}
                keyboardType="decimal-pad"
                editable={!!inputToken}
              />
              <TouchableOpacity
                style={styles.maxButton}
                onPress={handleMaxPress}
                disabled={!inputToken}
              >
                <Text style={styles.maxButtonText}>MAX</Text>
              </TouchableOpacity>
            </View>

            {/* Token Selector and Balance */}
            <View style={styles.tokenRow}>
              <TouchableOpacity
                style={styles.tokenSelector}
                onPress={() => setShowInputTokenSelector(true)}
              >
                {inputToken ? (
                  <>
                    {renderTokenIcon(inputToken)}
                    <Text style={styles.tokenSymbol}>{inputToken.symbol}</Text>
                  </>
                ) : (
                  <Text style={styles.selectTokenText}>Select token</Text>
                )}
                <Ionicons name="chevron-down" size={20} color={themeColors.text} />
              </TouchableOpacity>

              {inputToken && (
                <Text style={styles.balanceText}>
                  Balance: {getInputBalance()}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* Swap Button */}
        <View style={styles.swapButtonContainer}>
          <TouchableOpacity
            style={styles.swapButton}
            onPress={handleSwapTokens}
            disabled={!inputToken || !outputToken}
          >
            <Ionicons name="swap-vertical" size={24} color={themeColors.primary} />
          </TouchableOpacity>
        </View>

        {/* Output Token Section */}
        <View style={styles.tokenSection}>
          <Text style={styles.sectionLabel}>You receive</Text>
          <View style={styles.tokenCard}>
            {/* Output Amount Display */}
            <View style={styles.amountRow}>
              <Text style={styles.outputAmount}>
                {quote && quote.quote && outputToken && outputToken.decimals !== undefined
                  ? (parseFloat(quote.quote.outputAmount) / Math.pow(10, outputToken.decimals)).toLocaleString(undefined, {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: Math.min(outputToken.decimals, 6),
                    })
                  : '0.0'}
              </Text>
            </View>

            {/* Token Selector */}
            <View style={styles.tokenRow}>
              <TouchableOpacity
                style={styles.tokenSelector}
                onPress={() => setShowOutputTokenSelector(true)}
              >
                {outputToken ? (
                  <>
                    {renderTokenIcon(outputToken)}
                    <Text style={styles.tokenSymbol}>{outputToken.symbol}</Text>
                  </>
                ) : (
                  <Text style={styles.selectTokenText}>Select token</Text>
                )}
                <Ionicons name="chevron-down" size={20} color={themeColors.text} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Quote Display */}
        <SwapQuoteDisplay
          quote={quote}
          inputToken={inputToken}
          outputToken={outputToken}
          loading={quoteLoading}
          error={quoteError}
          slippage={slippage}
          onRefresh={fetchQuote}
          onSlippagePress={() => setShowSlippageModal(true)}
          onRouteDetailPress={() => setShowRouteModal(true)}
        />

        {/* Review Swap Button */}
        <TouchableOpacity
          style={[styles.reviewButton, isSwapDisabled() && styles.reviewButtonDisabled]}
          onPress={handleReviewSwap}
          disabled={isSwapDisabled()}
        >
          {isSwapping ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Text style={styles.reviewButtonText}>Review Swap</Text>
          )}
        </TouchableOpacity>
      </KeyboardAwareScrollView>

      {/* Modals */}
      <TokenSelector
        visible={showInputTokenSelector}
        accountId={accountId!}
        selectedTokenId={inputToken?.id}
        excludeTokenId={outputToken?.id}
        onClose={() => setShowInputTokenSelector(false)}
        onSelect={setInputToken}
      />

      <TokenSelector
        visible={showOutputTokenSelector}
        accountId={accountId!}
        selectedTokenId={outputToken?.id}
        excludeTokenId={inputToken?.id}
        onClose={() => setShowOutputTokenSelector(false)}
        onSelect={setOutputToken}
      />

      <SlippageSettingsModal
        visible={showSlippageModal}
        currentSlippage={slippage}
        onClose={() => setShowSlippageModal(false)}
        onSave={handleSlippageSave}
      />

      {quote && inputToken && outputToken && (
        <RouteDetailModal
          visible={showRouteModal}
          route={quote.route}
          inputToken={inputToken}
          outputToken={outputToken}
          onClose={() => setShowRouteModal(false)}
        />
      )}

      {/* Auth Modal for signing */}
      <UnifiedAuthModal
        visible={showAuthModal}
        onSuccess={handleSwapExecute}
        onCancel={() => setShowAuthModal(false)}
      />

      </SafeAreaView>

      {/* Account List Modal - rendered outside SafeAreaView to ensure proper z-index */}
      <AccountListModal
        isVisible={isAccountModalVisible}
        onClose={handleAccountModalClose}
        onAddAccount={handleAddAccount}
        onAccountSelect={handleAccountSelect}
      />
    </>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    scrollContent: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.lg,
      paddingBottom: theme.spacing.xl * 2, // Extra padding at bottom for scroll space
    },
    errorContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    errorText: {
      fontSize: 16,
      color: theme.colors.error,
    },
    tokenSection: {
      marginBottom: theme.spacing.md,
    },
    sectionLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.sm,
    },
    tokenCard: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing.lg,
      gap: theme.spacing.md,
    },
    amountRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    amountInput: {
      flex: 1,
      fontSize: 32,
      fontWeight: '600',
      color: theme.colors.text,
    },
    outputAmount: {
      flex: 1,
      fontSize: 32,
      fontWeight: '600',
      color: theme.colors.text,
    },
    maxButton: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.sm,
      backgroundColor: theme.colors.primary + '20',
      borderRadius: theme.borderRadius.md,
    },
    maxButtonText: {
      fontSize: 14,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    tokenRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    tokenSelector: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
    },
    tokenIcon: {
      width: 24,
      height: 24,
      borderRadius: 12,
    },
    tokenIconPlaceholder: {
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: theme.colors.primary + '20',
      alignItems: 'center',
      justifyContent: 'center',
    },
    tokenIconText: {
      fontSize: 12,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    tokenSymbol: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    selectTokenText: {
      fontSize: 16,
      color: theme.colors.textMuted,
    },
    balanceText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    swapButtonContainer: {
      alignItems: 'center',
      marginVertical: theme.spacing.sm,
    },
    swapButton: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 4,
      borderColor: theme.colors.background,
    },
    reviewButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.lg,
      borderRadius: theme.borderRadius.xl,
      alignItems: 'center',
      marginTop: theme.spacing.lg,
    },
    reviewButtonDisabled: {
      backgroundColor: theme.colors.textMuted,
      opacity: 0.5,
    },
    reviewButtonText: {
      fontSize: 18,
      fontWeight: '700',
      color: 'white',
    },
  });
