/**
 * Swap Screen
 * Allows users to swap tokens on Voi Network using Snowball DEX aggregator
 */

import React, { useState, useEffect, useRef } from 'react';
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
  Linking,
  BackHandler,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation, CommonActions } from '@react-navigation/native';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { useActiveAccount, useWalletStore } from '@/store/walletStore';
import { AccountBalance } from '@/types/wallet';
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
import WaitingForConfirmationModal from '@/components/common/WaitingForConfirmationModal';
import { SwapService, SwapToken, UnifiedSwapQuote } from '@/services/swap';
import { NetworkId } from '@/types/network';
import { NetworkService } from '@/services/network';
import algosdk from 'algosdk';
import { getTokenImageSource } from '@/utils/tokenImages';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';

interface SwapScreenRouteParams {
  assetName?: string;
  assetId?: number;
  accountId: string;
  networkId?: NetworkId;
}

const NATIVE_TOKEN_ID = 0; // Native token ID for both VOI and ALGO

export default function SwapScreen() {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const navigation = useNavigation();
  const route = useRoute();
  const routeParams = route.params as SwapScreenRouteParams | undefined;
  const delayedRefreshTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Network MUST come from route params
  const currentNetwork = routeParams?.networkId;

  const activeAccount = useActiveAccount();
  const accountId = routeParams?.accountId || activeAccount?.id;

  // Get accounts for address lookup
  const accounts = useWalletStore(state => state.wallet?.accounts);
  const currentAccount = accounts?.find(acc => acc.id === accountId);

  // Get account balance from store (for VOI network)
  const singleNetworkBalance = useWalletStore(state =>
    accountId ? state.accountStates[accountId]?.balance : undefined
  );

  // Network-specific balance state
  const [networkBalance, setNetworkBalance] = useState<AccountBalance | null>(null);

  // Load balance if not available
  const loadAccountBalance = useWalletStore(state => state.loadAccountBalance);

  useEffect(() => {
    if (accountId && !singleNetworkBalance) {
      loadAccountBalance(accountId);
    }
  }, [accountId, singleNetworkBalance, loadAccountBalance]);

  // Load network-specific balance when network or account changes
  useEffect(() => {
    const loadNetworkSpecificBalance = async () => {
      const address = currentAccount?.address;
      if (!address || !currentNetwork) return;

      try {
        // For non-VOI networks, fetch directly from NetworkService
        if (currentNetwork !== NetworkId.VOI_MAINNET) {
          const networkService = NetworkService.getInstance(currentNetwork);
          const balance = await networkService.getAccountBalance(address);
          setNetworkBalance(balance);
        } else {
          // For VOI network, use the store balance
          setNetworkBalance(singleNetworkBalance || null);
        }
      } catch (error) {
        console.error('Error loading network balance:', error);
      }
    };

    loadNetworkSpecificBalance();
  }, [currentAccount, currentNetwork, singleNetworkBalance]);

  // Use network-specific balance - only fall back to store balance for VOI
  const accountBalance = currentNetwork === NetworkId.VOI_MAINNET
    ? (networkBalance || singleNetworkBalance)
    : networkBalance;

  // Token selection state
  const [inputToken, setInputToken] = useState<SwapToken | null>(null);
  const [outputToken, setOutputToken] = useState<SwapToken | null>(null);
  const [showInputTokenSelector, setShowInputTokenSelector] = useState(false);
  const [showOutputTokenSelector, setShowOutputTokenSelector] = useState(false);

  // Amount and quote state
  const [inputAmount, setInputAmount] = useState('');
  const [quote, setQuote] = useState<UnifiedSwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  // Slippage and route modals
  const [slippage, setSlippage] = useState(1.0);
  const [showSlippageModal, setShowSlippageModal] = useState(false);
  const [showRouteModal, setShowRouteModal] = useState(false);

  // Transaction state
  const [isSwapping, setIsSwapping] = useState(false);
  const [isWaitingForConfirmation, setIsWaitingForConfirmation] = useState(false);

  // Account selector state
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);

  // Load initial tokens
  useEffect(() => {
    loadInitialTokens();
    loadStoredSlippage();
  }, [routeParams]);

  useEffect(() => {
    return () => {
      if (delayedRefreshTimeout.current) {
        clearTimeout(delayedRefreshTimeout.current);
        delayedRefreshTimeout.current = null;
      }
    };
  }, []);

  // Handle Android back button for local modals
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // Close modals in order of priority (don't dismiss waiting modal)
      if (showRouteModal) {
        setShowRouteModal(false);
        return true;
      }
      if (showSlippageModal) {
        setShowSlippageModal(false);
        return true;
      }
      if (showOutputTokenSelector) {
        setShowOutputTokenSelector(false);
        return true;
      }
      if (showInputTokenSelector) {
        setShowInputTokenSelector(false);
        return true;
      }
      if (isAccountModalVisible) {
        setIsAccountModalVisible(false);
        return true;
      }
      return false; // Let default back behavior happen
    });

    return () => backHandler.remove();
  }, [showRouteModal, showSlippageModal, showOutputTokenSelector, showInputTokenSelector, isAccountModalVisible]);

  const loadInitialTokens = async () => {
    try {
      const provider = SwapService.getProvider(currentNetwork);

      // Set input token based on route params or default to native token
      if (routeParams?.assetId !== undefined) {
        const token = await provider.getTokenById(routeParams.assetId);
        if (token) {
          setInputToken(token);
        }
      }

      // Default output token to native token if input is not native token
      if (routeParams?.assetId !== NATIVE_TOKEN_ID) {
        const nativeToken = await provider.getTokenById(NATIVE_TOKEN_ID);
        if (nativeToken) {
          setOutputToken(nativeToken);
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
      const provider = SwapService.getProvider(currentNetwork);

      // Convert amount to base units
      const amountInBaseUnits = BigInt(
        Math.floor(amountValue * Math.pow(10, inputToken.decimals))
      ).toString();

      const quoteResponse = await provider.getQuote({
        inputTokenId: inputToken.id,
        outputTokenId: outputToken.id,
        amount: amountInBaseUnits,
        userAddress: activeAccount.address,
        slippageTolerance: slippage, // Unified interface uses percentage
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
    // Get the current output amount to use as new input
    let newInputAmount = '';
    if (quote?.outputAmount && outputToken?.decimals !== undefined) {
      const outputValue = parseFloat(quote.outputAmount) / Math.pow(10, outputToken.decimals);
      // Format without trailing zeros
      newInputAmount = outputValue.toLocaleString('en-US', {
        useGrouping: false,
        minimumFractionDigits: 0,
        maximumFractionDigits: outputToken.decimals,
      });
    }

    // Swap input and output tokens
    const temp = inputToken;
    setInputToken(outputToken);
    setOutputToken(temp);

    // Set the new input amount (previous output) - quote will recalculate via useEffect
    setInputAmount(newInputAmount);
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

      if (inputToken.id === NATIVE_TOKEN_ID) {
        // For native token (VOI/ALGO), account for transaction fees (reserve ~0.1 for fees)
        const balance = BigInt(accountBalance.amount || '0');
        const reserveForFees = BigInt(100000); // 0.1 native token in base units
        const maxBalance = balance > reserveForFees ? balance - reserveForFees : BigInt(0);
        const value = Number(maxBalance) / Math.pow(10, 6);
        maxAmount = value.toFixed(6);
      } else {
        // Find asset by ID - check multiple possible field names
        const asset = accountBalance.assets?.find(a => {
          const assetId = a.assetId ?? a['asset-id'] ?? a.contractId;
          return assetId === inputToken.id;
        });

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

  // Get swap provider info for branding
  const providerInfo = SwapService.getProviderInfo(currentNetwork);

  const handleProviderPress = async () => {
    try {
      const supported = await Linking.canOpenURL(providerInfo.url);
      if (supported) {
        await Linking.openURL(providerInfo.url);
      } else {
        Alert.alert('Error', 'Cannot open this URL');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to open URL');
    }
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
    if (!quote || !inputToken || !outputToken || !activeAccount) {
      Alert.alert('Error', 'Missing required swap information');
      return;
    }

    // Navigate to UniversalTransactionSigning screen with swap transactions
    // Pass outputTokenId so the signing screen can check/handle opt-in
    navigation.navigate('UniversalTransactionSigning', {
      transactions: quote.unsignedTransactions,
      account: activeAccount,
      title: 'Confirm Swap',
      networkId: currentNetwork,
      outputTokenId: outputToken.id !== NATIVE_TOKEN_ID ? outputToken.id : undefined,
      outputTokenSymbol: outputToken.symbol,
      swapProvider: currentNetwork === NetworkId.ALGORAND_MAINNET ? 'deflex' : 'snowball',
      onSuccess: async (result: any) => {
        await handleSwapSuccess(result);
      },
      onReject: async () => {
        // Just navigate back
        navigation.goBack();
      },
    });
  };

  const handleSwapSuccess = async (result: any) => {
    if (!result?.signedTransactions) {
      Alert.alert('Error', 'No signed transactions returned');
      return;
    }

    setIsSwapping(true);
    setIsWaitingForConfirmation(true);

    try {
      const networkService = NetworkService.getInstance(currentNetwork);

      // Convert signed transactions from base64 strings to Uint8Array if needed
      const signedTxns = result.signedTransactions.map((txn: string | Uint8Array) => {
        if (typeof txn === 'string') {
          return new Uint8Array(Buffer.from(txn, 'base64'));
        }
        return txn;
      });

      // Submit transaction group
      const txId = await networkService.submitTransaction(signedTxns);

      const shortTxId =
        txId && txId.length > 12
          ? `${txId.slice(0, 6)}...${txId.slice(-6)}`
          : txId;

      Toast.show({
        type: 'success',
        text1: 'Swap submitted successfully',
        text2: `Transaction ${shortTxId}`,
        visibilityTime: 4500,
        position: 'top',
      });

      // Refresh balances once after a short delay to allow indexer updates
      if (delayedRefreshTimeout.current) {
        clearTimeout(delayedRefreshTimeout.current);
      }
      delayedRefreshTimeout.current = setTimeout(() => {
        const store = useWalletStore.getState();
        if (accountId) {
          store.loadAccountBalance(accountId, true);
        }
        store.refreshAllBalances();
        delayedRefreshTimeout.current = null;
      }, 5000);

      const resolveAssetDetailParams = () => {
        if (!accountId) {
          return null;
        }

        const resolvedAssetId =
          routeParams?.assetId ??
          (inputToken
            ? typeof inputToken.id === 'string'
              ? parseInt(inputToken.id, 10)
              : inputToken.id
            : undefined);

        if (
          resolvedAssetId === undefined ||
          Number.isNaN(Number(resolvedAssetId))
        ) {
          return null;
        }

        return {
          assetName:
            routeParams?.assetName ||
            inputToken?.name ||
            inputToken?.symbol ||
            'Asset',
          assetId: Number(resolvedAssetId),
          accountId,
          networkId: routeParams?.networkId,
        };
      };

      const assetDetailParams = resolveAssetDetailParams();

      navigation.dispatch(state => {
        const routes: Array<{ name: string; params?: Record<string, any> }> = [
          { name: 'HomeMain' },
        ];

        if (assetDetailParams) {
          routes.push({ name: 'AssetDetail', params: assetDetailParams });
        }

        return CommonActions.reset({
          ...state,
          routes,
          index: routes.length - 1,
        });
      });
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
      setIsWaitingForConfirmation(false);
    }
  };

  const getInputBalance = (): string => {
    if (!inputToken || !accountBalance) return '0';

    try {
      const tokenId = inputToken.id;

      // Check for native token (VOI/ALGO)
      if (tokenId === NATIVE_TOKEN_ID || inputToken.symbol === 'VOI' || inputToken.symbol === 'ALGO') {
        const balance = BigInt(accountBalance.amount || '0');
        const value = Number(balance) / Math.pow(10, 6);
        return value.toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 6,
        });
      }

      // Find asset by ID - check multiple possible field names
      const asset = accountBalance.assets?.find(a => {
        const assetId = a.assetId ?? a['asset-id'] ?? a.contractId;
        return assetId === tokenId;
      });

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

  const renderTokenIcon = (token: SwapToken | null) => {
    if (!token) return null;

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
      <View style={styles.tokenIconPlaceholder}>
        <Text style={styles.tokenIconText}>{token.symbol[0]}</Text>
      </View>
    );
  };

  // Skeleton animation for loading state
  const skeletonAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let animation: Animated.CompositeAnimation | null = null;

    if (quoteLoading) {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(skeletonAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(skeletonAnim, {
            toValue: 0,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();
    } else {
      skeletonAnim.setValue(0);
    }

    return () => {
      if (animation) {
        animation.stop();
      }
    };
  }, [quoteLoading, skeletonAnim]);

  const skeletonOpacity = skeletonAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  // Format USD value for display
  const formatUsdValue = (value: number | undefined): string | null => {
    if (value === undefined || value === 0) return null;
    return `~$${value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  // Get USD value for input amount - use usdIn from quote when available
  const getInputUsdValue = (): string | null => {
    if (!inputToken || !inputAmount || !quote) return null;
    const amountValue = parseFloat(inputAmount);
    if (isNaN(amountValue) || amountValue <= 0) return null;

    // Use usdIn directly from quote if available
    if (quote.usdIn !== undefined) {
      return formatUsdValue(quote.usdIn);
    }

    // Fallback to tokenValues calculation for Snowball
    if (quote.tokenValues) {
      const tokenIdStr = String(inputToken.id);
      const usdPerToken = quote.tokenValues[tokenIdStr];
      if (usdPerToken !== undefined) {
        return formatUsdValue(amountValue * usdPerToken);
      }
    }

    return null;
  };

  // Get USD value for output amount - use usdOut from quote when available
  const getOutputUsdValue = (): string | null => {
    if (!outputToken || !quote?.outputAmount) return null;

    // Use usdOut directly from quote if available
    if (quote.usdOut !== undefined) {
      return formatUsdValue(quote.usdOut);
    }

    // Fallback to tokenValues calculation for Snowball
    if (quote.tokenValues) {
      const tokenIdStr = String(outputToken.id);
      const usdPerToken = quote.tokenValues[tokenIdStr];
      if (usdPerToken !== undefined) {
        const outputValue = parseFloat(quote.outputAmount) / Math.pow(10, outputToken.decimals);
        return formatUsdValue(outputValue * usdPerToken);
      }
    }

    return null;
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

  const { theme } = useTheme();

  return (
    <NFTBackground>
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
          <GlassCard variant="medium" style={styles.tokenCard}>
            {/* Top Row: Amount + Token Selector */}
            <View style={styles.mainRow}>
              <View style={styles.amountContainer}>
                <TextInput
                  style={styles.amountInput}
                  value={inputAmount}
                  onChangeText={handleInputAmountChange}
                  placeholder="0.0"
                  placeholderTextColor={themeColors.textMuted}
                  keyboardType="decimal-pad"
                  editable={!!inputToken}
                />
              </View>
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
                  <Text style={styles.selectTokenText}>Select</Text>
                )}
                <Ionicons name="chevron-down" size={18} color={themeColors.text} />
              </TouchableOpacity>
            </View>

            {/* Bottom Row: USD Value + Balance */}
            <View style={styles.bottomRow}>
              <Text style={styles.usdValue}>{getInputUsdValue() || ' '}</Text>
              <View style={styles.balanceRow}>
                {inputToken && (
                  <>
                    <Text style={styles.balanceText}>
                      Bal: {getInputBalance()}
                    </Text>
                    <TouchableOpacity
                      style={styles.maxButton}
                      onPress={handleMaxPress}
                    >
                      <Text style={styles.maxButtonText}>MAX</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </View>
          </GlassCard>
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
          <GlassCard variant="medium" style={styles.tokenCard}>
            {/* Top Row: Amount + Token Selector */}
            <View style={styles.mainRow}>
              <View style={styles.amountContainer}>
                {quoteLoading ? (
                  <Animated.View
                    style={[
                      styles.skeleton,
                      styles.skeletonAmount,
                      { opacity: skeletonOpacity },
                    ]}
                  />
                ) : (
                  <Text style={styles.outputAmount}>
                    {quote && quote.outputAmount && outputToken && outputToken.decimals !== undefined
                      ? (parseFloat(quote.outputAmount) / Math.pow(10, outputToken.decimals)).toLocaleString(undefined, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: Math.min(outputToken.decimals, 6),
                        })
                      : '0.0'}
                  </Text>
                )}
              </View>
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
                  <Text style={styles.selectTokenText}>Select</Text>
                )}
                <Ionicons name="chevron-down" size={18} color={themeColors.text} />
              </TouchableOpacity>
            </View>

            {/* Bottom Row: USD Value */}
            <View style={styles.bottomRow}>
              {quoteLoading ? (
                <Animated.View
                  style={[
                    styles.skeleton,
                    styles.skeletonUsd,
                    { opacity: skeletonOpacity },
                  ]}
                />
              ) : (
                <Text style={styles.usdValue}>{getOutputUsdValue() || ' '}</Text>
              )}
            </View>
          </GlassCard>
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
        <GlassButton
          variant="primary"
          label="Review Swap"
          icon="swap-horizontal"
          loading={isSwapping}
          disabled={isSwapDisabled()}
          onPress={handleReviewSwap}
          fullWidth
          glow
          size="lg"
        />

        {/* Powered by swap provider */}
        <View style={styles.poweredByContainer}>
          <Text style={styles.poweredByText}>Powered by </Text>
          {providerInfo.provider === 'snowball' && (
            <Image
              source={require('../../../assets/snowballSwap.png')}
              style={styles.poweredByLogo}
              resizeMode="contain"
            />
          )}
          <TouchableOpacity onPress={handleProviderPress}>
            <Text style={styles.providerLink}>{providerInfo.name}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAwareScrollView>

      {/* Modals */}
      <TokenSelector
        visible={showInputTokenSelector}
        accountId={accountId!}
        networkId={currentNetwork}
        selectedTokenId={inputToken?.id}
        excludeTokenId={outputToken?.id}
        ownedOnly={true}
        onClose={() => setShowInputTokenSelector(false)}
        onSelect={setInputToken}
      />

      <TokenSelector
        visible={showOutputTokenSelector}
        accountId={accountId!}
        networkId={currentNetwork}
        selectedTokenId={outputToken?.id}
        excludeTokenId={inputToken?.id}
        ownedOnly={false}
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
          estimatedOutput={quote.outputAmount}
          minimumOutput={quote.minimumOutputAmount}
          onClose={() => setShowRouteModal(false)}
        />
      )}

      </SafeAreaView>

      {/* Account List Modal - rendered outside SafeAreaView to ensure proper z-index */}
      <AccountListModal
        isVisible={isAccountModalVisible}
        onClose={handleAccountModalClose}
        onAddAccount={handleAddAccount}
        onAccountSelect={handleAccountSelect}
      />

      <WaitingForConfirmationModal
        visible={isWaitingForConfirmation}
        title="Waiting for confirmation"
        message="Your swap has been submitted. We're waiting for the network to confirm it."
        subMessage="You can safely leave this screen after confirmation."
      />
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.xl,
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
      marginBottom: theme.spacing.xs,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
      // Text shadow for readability over NFT backgrounds
      textShadowColor: theme.mode === 'dark'
        ? 'rgba(0, 0, 0, 0.8)'
        : 'rgba(255, 255, 255, 0.9)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 16,
    },
    tokenCard: {
      borderRadius: theme.borderRadius.lg,
      gap: theme.spacing.xs,
    },
    mainRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    amountContainer: {
      flex: 1,
      marginRight: theme.spacing.sm,
    },
    amountInput: {
      fontSize: 28,
      fontWeight: '600',
      color: theme.colors.text,
    },
    outputAmount: {
      fontSize: 28,
      fontWeight: '600',
      color: theme.colors.text,
    },
    bottomRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    balanceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    usdValue: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    skeleton: {
      backgroundColor: theme.colors.glassBackground,
      borderRadius: theme.borderRadius.md,
    },
    skeletonAmount: {
      height: 34,
      width: '50%',
    },
    skeletonUsd: {
      height: 16,
      width: '25%',
    },
    maxButton: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
      backgroundColor: theme.colors.primary + '20',
      borderRadius: theme.borderRadius.sm,
    },
    maxButtonText: {
      fontSize: 12,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    tokenSelector: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: theme.glass.light.backgroundColor,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
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
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
    swapButtonContainer: {
      alignItems: 'center',
      marginVertical: theme.spacing.xs,
    },
    swapButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: theme.colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: theme.colors.primary,
    },
    reviewButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      borderRadius: theme.borderRadius.lg,
      alignItems: 'center',
      marginTop: theme.spacing.md,
    },
    reviewButtonDisabled: {
      backgroundColor: theme.colors.textMuted,
      opacity: 0.5,
    },
    reviewButtonText: {
      fontSize: 16,
      fontWeight: '700',
      color: 'white',
    },
    poweredByContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.sm,
    },
    poweredByText: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      marginRight: theme.spacing.xs,
    },
    providerLink: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    poweredByLogo: {
      height: 30,
      width: 30,
      marginHorizontal: theme.spacing.xs,
    },
  });
