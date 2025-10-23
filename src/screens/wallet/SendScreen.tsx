import React, { useState, useEffect } from 'react';
import algosdk from 'algosdk';
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
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons'; // types provided by Expo runtime
import {
  useRoute,
  useNavigation,
  CommonActions,
  useFocusEffect,
} from '@react-navigation/native';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { TransactionService } from '@/services/transactions';
import VoiNetworkService, { NetworkService } from '@/services/network';
import tokenMappingService from '@/services/token-mapping';
import {
  useActiveAccount,
  useActiveAccountBalance,
  useWalletStore,
  useMultiNetworkBalance,
} from '@/store/walletStore';
import {
  formatNativeBalance,
  formatAssetBalance,
  subtractBigIntSafe,
} from '@/utils/bigint';
import { AccountType, type WalletAccount } from '@/types/wallet';
import { useCurrentNetwork, useCurrentNetworkConfig } from '@/store/networkStore';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { NFTToken } from '@/types/nft';
import {
  resolveAddressOrName,
  isLikelyEnvoiName,
  formatAddress,
} from '@/utils/address';
import { isAlgorandPaymentUri, parseAlgorandUri } from '@/utils/algorandUri';
import EnvoiService, { EnvoiSearchResult } from '@/services/envoi';
import AccountSelector from '@/components/account/AccountSelector';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import AccountRecipientModal from '@/components/account/AccountRecipientModal';
import UniversalHeader from '@/components/common/UniversalHeader';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { SecureKeyManager } from '@/services/secure/keyManager';
import NetworkAssetSelector from '@/components/send/NetworkAssetSelector';

interface SendScreenRouteParams {
  assetName?: string;
  assetId?: number;
  accountId?: string;
  networkId?: string;
  mappingId?: string; // For multi-network assets
  // ARC-72 NFT token for transfer
  nftToken?: NFTToken;
  // Payment request parameters from Algorand URIs
  recipient?: string;
  amount?: string;
  note?: string;
  label?: string;
  asset?: string;
}

export default function SendScreen() {
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const navigation = useNavigation();
  const currentNetwork = useCurrentNetwork();
  const currentNetworkConfig = useCurrentNetworkConfig();

  const route = useRoute();
  const routeParams = route.params as SendScreenRouteParams | undefined;

  // Network selection state - defaults to route param or current network
  const [selectedNetworkId, setSelectedNetworkId] = useState<NetworkId>(
    (routeParams?.networkId as NetworkId) || currentNetwork
  );

  // Update selected network when route params change
  useEffect(() => {
    if (routeParams?.networkId) {
      setSelectedNetworkId(routeParams.networkId as NetworkId);
    }
  }, [routeParams?.networkId]);

  const [recipientInput, setRecipientInput] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [recipientInputFocused, setRecipientInputFocused] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [estimatedFee, setEstimatedFee] = useState<number>(0);
  const [isSending, setIsSending] = useState(false);
  const [isAccountModalVisible, setIsAccountModalVisible] = useState(false);
  const [isAddAccountModalVisible, setIsAddAccountModalVisible] =
    useState(false);
  const [isAccountRecipientModalVisible, setIsAccountRecipientModalVisible] =
    useState(false);
  const [isResolvingName, setIsResolvingName] = useState(false);
  const [nameResolutionError, setNameResolutionError] = useState<string | null>(
    null
  );
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<EnvoiSearchResult[]>([]);
  const [isSearchingNames, setIsSearchingNames] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [showAssetSelector, setShowAssetSelector] = useState(false);
  const [qrScannerVisible, setQrScannerVisible] = useState(false);
  const [canSignFromActive, setCanSignFromActive] = useState(false);
  const [hasLedgerSigner, setHasLedgerSigner] = useState(false);

  const contextAssetName = routeParams?.assetName;
  const contextNftToken = routeParams?.nftToken;
  const contextMappingId = routeParams?.mappingId;

  // State for the network-specific asset ID
  const [networkSpecificAssetId, setNetworkSpecificAssetId] = useState<number | null>(null);

  // Resolve the correct assetId for the selected network
  useEffect(() => {
    const resolveAssetId = async () => {
      const initialAssetId = routeParams?.asset
        ? isNaN(parseInt(routeParams.asset, 10))
          ? undefined
          : parseInt(routeParams.asset, 10)
        : routeParams?.assetId;

      if (!initialAssetId) {
        setNetworkSpecificAssetId(null);
        return;
      }

      // Get all mappings
      const mappings = await tokenMappingService.getTokenMappings();

      // Find which mapping contains this asset ID (on ANY network)
      const mapping = mappings.find(m =>
        m.tokens.some(t => t.assetId === initialAssetId)
      );

      if (mapping) {
        // Find the token for the selected network
        const tokenForNetwork = mapping.tokens.find(t => t.networkId === selectedNetworkId);

        if (tokenForNetwork) {
          setNetworkSpecificAssetId(tokenForNetwork.assetId);
          return;
        }
      }

      // Not in a mapping, use the original assetId
      setNetworkSpecificAssetId(initialAssetId ?? null);
    };

    resolveAssetId();
  }, [selectedNetworkId, routeParams?.assetId, routeParams?.asset]);

  const contextAssetId = networkSpecificAssetId;

  // Determine the effective asset ID to use - context takes precedence over selected
  const effectiveAssetId =
    contextAssetId !== undefined && contextAssetId !== null ? contextAssetId : selectedAssetId;
  const hasNoContext = contextAssetId === undefined || contextAssetId === null;

  // Initialize selectedAssetId to native token when no context is provided
  useEffect(() => {
    if (hasNoContext && selectedAssetId === null) {
      setSelectedAssetId(0); // Default to native token
    }
  }, [hasNoContext, selectedAssetId]);

  // Handle network change
  const handleNetworkChange = (networkId: NetworkId) => {
    setSelectedNetworkId(networkId);
    setAmount(''); // Clear amount when network changes
    setEstimatedFee(0);
  };

  // Pre-fill form fields from payment request parameters
  useEffect(() => {
    if (routeParams) {
      if (
        routeParams.recipient &&
        algosdk.isValidAddress(routeParams.recipient)
      ) {
        setRecipientInput(routeParams.recipient);
      }
      if (routeParams.amount && /^\d+$/.test(routeParams.amount)) {
        // Convert from smallest units to display format
        // For native tokens (no asset parameter), use 6 decimals
        // For assets, look up the asset or default to 0
        const assetIdRaw = routeParams.asset ? parseInt(routeParams.asset) : undefined;
        const decimals = assetIdRaw === undefined ? 6 : 0;

        const rawAmount = BigInt(routeParams.amount);
        const divisor = BigInt(10) ** BigInt(decimals);
        const wholePart = rawAmount / divisor;
        const fractionalPart = rawAmount % divisor;

        let displayAmount = wholePart.toString();
        if (fractionalPart > 0) {
          const fractionalStr = fractionalPart
            .toString()
            .padStart(decimals, '0')
            .replace(/0+$/, '');
          if (fractionalStr) {
            displayAmount += '.' + fractionalStr;
          }
        }

        setAmount(displayAmount);
      }
      if (routeParams.note) {
        // Sanitize note to prevent potential issues
        const sanitizedNote = routeParams.note.slice(0, 1000); // Limit length
        setNote(sanitizedNote);
      }
      // label is display only, used for recipient name
      if (routeParams.label && routeParams.recipient) {
        const sanitizedLabel = routeParams.label.slice(0, 100); // Limit label length
        setResolvedName(sanitizedLabel);
      }
    }
  }, [routeParams]);

  const activeAccount = useActiveAccount();
  const refreshAllBalances = useWalletStore(
    (state) => state.refreshAllBalances
  );

  // State for all available versions of this asset across networks
  const [assetOptions, setAssetOptions] = useState<Array<{
    networkId: NetworkId;
    assetId: number;
    balance: bigint;
    decimals: number;
    symbol: string;
    name: string;
    assetType?: 'asa' | 'arc200' | 'arc72';
    contractId?: number;
    imageUrl?: string;
  }>>([]);
  const [isLoadingOptions, setIsLoadingOptions] = useState(false);

  // Selected asset state
  const [selectedAsset, setSelectedAsset] = useState<{
    networkId: NetworkId;
    assetId: number;
  } | null>(null);

  // Balance for the selected asset
  const [accountBalance, setAccountBalance] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { balance: multiNetworkBalance } = useMultiNetworkBalance(activeAccount?.id || '');

  // Fetch all available versions of this asset across networks
  useEffect(() => {
    const fetchAssetOptions = async () => {
      if (!activeAccount) return;

      const initialAssetId = routeParams?.assetId;

      setIsLoadingOptions(true);
      try {
        // Get mappings to find all versions of this asset
        const mappings = await tokenMappingService.getTokenMappings();
        const options = [];

        // When no asset context is provided, show all network tokens (native + bridged)
        if (initialAssetId === undefined) {
          // Find all mappings that contain native tokens (assetId: 0)
          const nativeTokenMappings = mappings.filter(m =>
            m.tokens.some(t => t.assetId === 0)
          );

          // For each native token mapping, get balances from multi-network balance
          for (const mapping of nativeTokenMappings) {
            const mappedAsset = multiNetworkBalance?.assets.find(
              (a) => a.mappingId === mapping.mappingId && a.isMapped
            );

            if (mappedAsset && mappedAsset.sourceBalances) {
              // Add all tokens in this mapping (native + bridged versions)
              for (const source of mappedAsset.sourceBalances) {
                options.push({
                  networkId: source.networkId,
                  assetId: source.balance.assetId,
                  balance: source.balance.amount,
                  decimals: source.balance.decimals,
                  symbol: source.balance.symbol || '',
                  name: source.balance.name || '',
                  imageUrl: source.balance.imageUrl,
                });
              }
            }
          }
        } else {
          // Has asset context - show only versions of this specific asset
          // If mappingId is provided, use it directly (most reliable)
          let mapping = contextMappingId
            ? mappings.find(m => m.mappingId === contextMappingId)
            : mappings.find(m => m.tokens.some(t => t.assetId === initialAssetId));

          if (mapping) {
            // Find the mapped asset in multi-network balance
            const mappedAsset = multiNetworkBalance?.assets.find(
              (a) => a.mappingId === mapping.mappingId && a.isMapped
            );

            if (mappedAsset && mappedAsset.sourceBalances && mappedAsset.sourceBalances.length > 0) {
              // Build options from sourceBalances (includes native tokens with assetId 0)
              for (const source of mappedAsset.sourceBalances) {
                options.push({
                  networkId: source.networkId,
                  assetId: source.balance.assetId,
                  balance: source.balance.amount,
                  decimals: source.balance.decimals,
                  symbol: source.balance.symbol || contextAssetName || '',
                  name: source.balance.name || contextAssetName || '',
                  imageUrl: source.balance.imageUrl,
                });
              }
            } else {
              // Mapped but no balance data - fetch directly from network
              const networkId = (routeParams?.networkId as NetworkId) || currentNetwork;
              const networkService = NetworkService.getInstance(networkId);
              const accountInfo = await networkService.getAlgodClient()
                .accountInformation(activeAccount.address).do();

              // Handle native token (assetId 0)
              if (initialAssetId === 0) {
                const networkConfig = getNetworkConfig(networkId);
                options.push({
                  networkId,
                  assetId: 0,
                  balance: BigInt(accountInfo.amount || 0),
                  decimals: 6,
                  symbol: networkConfig.nativeToken,
                  name: networkConfig.nativeToken,
                  imageUrl: undefined, // Native token images are handled by network config
                });
              } else {
                // Handle ASA token
                const assetHolding = accountInfo.assets?.find((a: any) => a['asset-id'] === initialAssetId);

                if (assetHolding) {
                  const assetInfo = await networkService.getAlgodClient().getAssetByID(initialAssetId).do();

                  options.push({
                    networkId,
                    assetId: initialAssetId,
                    balance: BigInt(assetHolding.amount || 0),
                    decimals: assetInfo.params.decimals || 0,
                    symbol: assetInfo.params.unitName || contextAssetName || '',
                    name: assetInfo.params.name || contextAssetName || '',
                    imageUrl: assetInfo.params.url,
                  });
                }
              }
            }
          } else {
            // Not in a mapping, just show this one asset
            const networkId = (routeParams?.networkId as NetworkId) || currentNetwork;

            // First check if we have this asset in accountBalance (includes ARC-200)
            const balance = await NetworkService.getInstance(networkId).getAccountBalance(activeAccount.address);
            const asset = balance.assets?.find(
              (a) => a.assetId === initialAssetId || (a.assetType === 'arc200' && a.contractId === initialAssetId)
            );

            if (asset) {
              // Found in accountBalance (ASA or ARC-200)
              options.push({
                networkId,
                assetId: asset.assetType === 'arc200' ? asset.contractId : asset.assetId,
                balance: asset.amount,
                decimals: asset.decimals,
                symbol: asset.symbol || contextAssetName || '',
                name: asset.name || contextAssetName || '',
                assetType: asset.assetType,
                contractId: asset.assetType === 'arc200' ? asset.contractId : undefined,
                imageUrl: asset.imageUrl,
              });
            } else if (initialAssetId === 0) {
              // Native token
              const networkConfig = getNetworkConfig(networkId);
              options.push({
                networkId,
                assetId: 0,
                balance: balance.amount,
                decimals: 6,
                symbol: networkConfig.nativeToken,
                name: networkConfig.nativeToken,
                imageUrl: undefined, // Native token images are handled by network config
              });
            }
          }
        }

        setAssetOptions(options);

        // Auto-select based on route params or default to current network's native token
        if (options.length > 0) {
          const routeNetworkId = routeParams?.networkId as NetworkId;

          if (initialAssetId === undefined) {
            // No asset context: default to current network's native token
            const defaultOption = options.find(
              o => o.networkId === currentNetwork && o.assetId === 0
            ) || options[0];

            setSelectedAsset({
              networkId: defaultOption.networkId,
              assetId: defaultOption.assetId,
            });
          } else {
            // Has asset context: match both networkId AND assetId
            let matchingOption = routeNetworkId
              ? options.find(o => o.networkId === routeNetworkId && o.assetId === initialAssetId)
              : null;

            // If no route networkId specified, use the current network
            if (!matchingOption && !routeNetworkId) {
              matchingOption = options.find(o => o.networkId === currentNetwork && o.assetId === initialAssetId);
            }

            // Fallback to first option only if no match found
            const selected = matchingOption || {
              networkId: options[0].networkId,
              assetId: options[0].assetId,
            };

            setSelectedAsset(selected);
          }
        } else {
          console.log('[SendScreen] No options - selectedAsset not set');
        }
      } catch (error) {
        console.error('Failed to fetch asset options:', error);
      } finally {
        setIsLoadingOptions(false);
      }
    };

    fetchAssetOptions();
  }, [activeAccount?.address, routeParams?.assetId, routeParams?.networkId, contextMappingId, multiNetworkBalance?.assets, currentNetwork]);

  // Balance is already in assetOptions - no need to fetch separately

  // Determine signing capability and Ledger signer presence for the active account
  useEffect(() => {
    let isCancelled = false;
    const loadSigningCapability = async () => {
      try {
        if (!activeAccount) {
          if (!isCancelled) {
            setCanSignFromActive(false);
            setHasLedgerSigner(false);
          }
          return;
        }

        const info = await SecureKeyManager.getSigningInfo(
          activeAccount.address
        );
        if (isCancelled) return;
        setCanSignFromActive(Boolean(info?.canSign));

        // Probe for a Ledger signer via id, then signing address, then the account address
        let ledgerFound = false;
        try {
          if (info?.signingAccountId) {
            const li = await SecureKeyManager.getLedgerSigningInfo(
              info.signingAccountId,
              { lookupByAddress: false }
            );
            ledgerFound = Boolean(li);
          }
        } catch {}

        if (!ledgerFound) {
          try {
            if (info?.signingAddress) {
              const li = await SecureKeyManager.getLedgerSigningInfo(
                info.signingAddress,
                { lookupByAddress: true }
              );
              ledgerFound = Boolean(li);
            }
          } catch {}
        }

        if (!ledgerFound) {
          try {
            const li = await SecureKeyManager.getLedgerSigningInfo(
              activeAccount.address,
              { lookupByAddress: true }
            );
            ledgerFound = Boolean(li);
          } catch {}
        }

        if (!isCancelled) {
          setHasLedgerSigner(ledgerFound);
        }
      } catch {
        if (!isCancelled) {
          setCanSignFromActive(false);
          setHasLedgerSigner(false);
        }
      }
    };

    loadSigningCapability();
    return () => {
      isCancelled = true;
    };
  }, [activeAccount?.address]);

  // Get network config for selected network
  const selectedNetworkConfig = React.useMemo(() => {
    return getNetworkConfig(selectedNetworkId);
  }, [selectedNetworkId]);

  // Get network config for the asset being sent (may differ from selectedNetworkId for multi-network assets)
  const transactionNetworkConfig = React.useMemo(() => {
    return getNetworkConfig(selectedAsset?.networkId || selectedNetworkId);
  }, [selectedAsset?.networkId, selectedNetworkId]);

  // Check if Envoi is available on the selected network
  const isEnvoiEnabled = selectedNetworkConfig.features.envoi;

  // Helper functions for asset context
  const getCurrentAssetOption = () => {
    if (!selectedAsset) return null;
    return assetOptions.find(
      (opt) => opt.networkId === selectedAsset.networkId && opt.assetId === selectedAsset.assetId
    );
  };

  const getCurrentAsset = () => {
    if (effectiveAssetId === 0 || !effectiveAssetId) {
      return null; // Native token doesn't have enhanced asset data
    }
    return accountBalance?.assets?.find(
      (a) =>
        a.assetId === effectiveAssetId ||
        (a.assetType === 'arc200' && a.contractId === effectiveAssetId)
    );
  };

  const getAssetBalance = () => {
    // Use selectedAsset if available (for multi-network assets)
    const option = getCurrentAssetOption();
    if (option) {
      return formatAssetBalance(option.balance, option.decimals);
    }

    // Fallback to legacy logic
    if (effectiveAssetId === 0 || !effectiveAssetId) {
      return accountBalance
        ? formatNativeBalance(
            accountBalance.amount,
            selectedNetworkConfig.nativeToken
          )
        : '0.000000';
    }

    const asset = getCurrentAsset();
    if (asset) {
      return formatAssetBalance(asset.amount, asset.decimals);
    }
    return '0';
  };

  const getAssetSymbol = () => {
    // Use selectedAsset if available
    const option = getCurrentAssetOption();
    if (option) {
      return option.symbol;
    }

    // Fallback to legacy logic
    if (effectiveAssetId === 0 || !effectiveAssetId) {
      return selectedNetworkConfig.nativeToken;
    }

    const asset = getCurrentAsset();
    return asset?.symbol || contextAssetName || 'Token';
  };

  const getAssetDecimals = () => {
    // Use selectedAsset if available
    const option = getCurrentAssetOption();
    if (option) {
      return option.decimals;
    }

    // Fallback to legacy logic
    if (effectiveAssetId === 0 || !effectiveAssetId) {
      return 6; // Native tokens have 6 decimals
    }

    const asset = getCurrentAsset();
    return asset?.decimals || 0;
  };

  const getAssetName = () => {
    // Use selectedAsset if available
    const option = getCurrentAssetOption();
    if (option) {
      return option.name;
    }

    // Fallback to legacy logic
    if (effectiveAssetId === 0 || !effectiveAssetId) {
      return selectedNetworkConfig.nativeToken;
    }

    const asset = getCurrentAsset();
    return (
      asset?.name ||
      asset?.symbol ||
      contextAssetName ||
      `Asset ${effectiveAssetId}`
    );
  };

  const convertAmountToBaseUnits = (amount: string): number => {
    const decimals = getAssetDecimals();
    const multiplier = Math.pow(10, decimals);
    return Math.floor(parseFloat(amount) * multiplier);
  };

  // Removed problematic useEffect that was causing infinite balance reloading

  useEffect(() => {
    if (amount && parseFloat(amount) > 0) {
      updateFeeEstimate();
    }
  }, [amount]);

  // Fee estimation for NFT transfers
  useEffect(() => {
    if (contextNftToken && recipientAddress) {
      updateFeeEstimate();
    }
  }, [contextNftToken, recipientAddress]);

  // Name resolution effect with debouncing
  useEffect(() => {
    const resolveRecipient = async () => {
      if (!recipientInput.trim()) {
        setRecipientAddress('');
        setResolvedName(null);
        setNameResolutionError(null);
        setSearchResults([]);
        setIsSearchingNames(false);
        return;
      }

      const input = recipientInput.trim();

      // Skip resolution if we already have a valid address that matches the input
      if (recipientAddress && algosdk.isValidAddress(recipientAddress)) {
        // If the input matches the resolved address or resolved name, don't re-resolve
        if (input === recipientAddress || (resolvedName && input === resolvedName)) {
          return;
        }
      }

      try {
        setIsResolvingName(true);
        setNameResolutionError(null);

        const resolvedAddress = await resolveAddressOrName(input);

        if (resolvedAddress) {
          setRecipientAddress(resolvedAddress);

          // If it was a name that we resolved, save the name for display
          if (isEnvoiEnabled && isLikelyEnvoiName(input)) {
            setResolvedName(input);
          } else {
            setResolvedName(null);
          }
        } else {
          setRecipientAddress('');
          setResolvedName(null);
          if (isEnvoiEnabled && isLikelyEnvoiName(input)) {
            setNameResolutionError('Name not found');
          } else {
            setNameResolutionError('Invalid address');
          }
        }
      } catch (error) {
        console.error('Failed to resolve recipient:', error);
        setRecipientAddress('');
        setResolvedName(null);
        setNameResolutionError('Failed to resolve');
      } finally {
        setIsResolvingName(false);
      }
    };

    // Debounce the resolution
    const timeoutId = setTimeout(resolveRecipient, 500);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [recipientInput, recipientAddress, resolvedName]);

  useEffect(() => {
    const trimmed = recipientInput.trim();

    if (!trimmed || !isEnvoiEnabled) {
      setSearchResults([]);
      setIsSearchingNames(false);
      return;
    }

    const normalized = trimmed.toLowerCase();

    if (resolvedName && resolvedName.toLowerCase() === normalized) {
      setSearchResults([]);
      setIsSearchingNames(false);
      return;
    }

    if (algosdk.isValidAddress(normalized)) {
      setSearchResults([]);
      setIsSearchingNames(false);
      return;
    }

    const looksLikeName =
      /^[a-z0-9-_.]+$/.test(normalized) && normalized.length >= 2;
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
        if (cancelled) {
          return;
        }

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
  }, [recipientInput, resolvedName]);

  const handleSearchResultSelect = (result: EnvoiSearchResult) => {
    setRecipientInput(result.name);
    setResolvedName(result.name);
    setRecipientAddress(result.address);
    setNameResolutionError(null);
    setSearchResults([]);
    setIsSearchingNames(false);
  };

  const handleQRScan = () => {
    (navigation as any).navigate('QRScanner');
  };

  const handleAccountRecipientSelect = (
    address: string,
    accountLabel?: string
  ) => {
    setRecipientInput(address);
    setRecipientAddress(address);
    setResolvedName(accountLabel || null);
    setNameResolutionError(null);
    setSearchResults([]);
    setIsSearchingNames(false);
  };

  const handleAccountRecipientModalOpen = () => {
    setIsAccountRecipientModalVisible(true);
  };

  // Handle QR scan results when returning from QR scanner
  useFocusEffect(
    React.useCallback(() => {
      const handleQRResult = (params: any) => {
        if (params?.qrResult) {
          const qrData = params.qrResult;

          // Handle different QR code formats
          if (isAlgorandPaymentUri(qrData)) {
            // Parse Algorand payment URI
            const parsed = parseAlgorandUri(qrData);
            if (parsed && parsed.isValid && parsed.address) {
              setRecipientInput(parsed.address);
              setRecipientAddress(parsed.address);
              setNameResolutionError(null);

              // If URI contains amount and matches our current asset context
              if (parsed.params.amount && parsed.params.asset) {
                const uriAssetId = parseInt(parsed.params.asset);
                if (uriAssetId === effectiveAssetId) {
                  // Convert from smallest units to display format
                  const decimals = getAssetDecimals();
                  const rawAmount = BigInt(parsed.params.amount);
                  const divisor = BigInt(10) ** BigInt(decimals);
                  const wholePart = rawAmount / divisor;
                  const fractionalPart = rawAmount % divisor;

                  let displayAmount = wholePart.toString();
                  if (fractionalPart > 0) {
                    const fractionalStr = fractionalPart
                      .toString()
                      .padStart(decimals, '0')
                      .replace(/0+$/, '');
                    if (fractionalStr) {
                      displayAmount += '.' + fractionalStr;
                    }
                  }
                  setAmount(displayAmount);
                }
              } else if (
                parsed.params.amount &&
                !parsed.params.asset &&
                (effectiveAssetId === 0 || !effectiveAssetId)
              ) {
                // Native token amount
                const rawAmount = BigInt(parsed.params.amount);
                const divisor = BigInt(10) ** BigInt(6); // Native tokens have 6 decimals
                const wholePart = rawAmount / divisor;
                const fractionalPart = rawAmount % divisor;

                let displayAmount = wholePart.toString();
                if (fractionalPart > 0) {
                  const fractionalStr = fractionalPart
                    .toString()
                    .padStart(6, '0')
                    .replace(/0+$/, '');
                  if (fractionalStr) {
                    displayAmount += '.' + fractionalStr;
                  }
                }
                setAmount(displayAmount);
              }

              // Set note if provided
              if (parsed.params.note || parsed.params.xnote) {
                setNote(parsed.params.xnote || parsed.params.note || '');
              }

              // Set resolved name if label provided
              if (parsed.params.label) {
                setResolvedName(parsed.params.label);
              }
            }
          } else if (algosdk.isValidAddress(qrData)) {
            // Handle plain address
            setRecipientInput(qrData);
            setRecipientAddress(qrData);
            setNameResolutionError(null);
            setResolvedName(null);
          } else if (qrData.match(/^(algorand|voi|perawallet):\/\/(.+)$/)) {
            // Handle address from URI scheme without full payment params
            const match = qrData.match(
              /^(algorand|voi|perawallet):\/\/([A-Z2-7]{58})$/
            );
            if (match && algosdk.isValidAddress(match[2])) {
              setRecipientInput(match[2]);
              setRecipientAddress(match[2]);
              setNameResolutionError(null);
              setResolvedName(null);
            }
          }

          // Clear the qr result from navigation params
          navigation.setParams({ qrResult: undefined } as never);
        }
      };

      // Check if we have QR result in route params
      const params = route.params as any;
      if (params?.qrResult) {
        handleQRResult(params);
      }
    }, [route.params, navigation, effectiveAssetId, getAssetDecimals])
  );

  const updateFeeEstimate = async () => {
    try {
      if (!activeAccount) return;

      // Handle ARC-72 NFT transfer fee estimation
      if (contextNftToken) {
        // For NFTs, ALWAYS use the NFT's network, not the global selected network
        if (!contextNftToken.networkId) {
          console.error('NFT missing networkId:', contextNftToken);
          throw new Error('NFT is missing network information');
        }
        const cost = await TransactionService.estimateTransactionCost({
          from: activeAccount.address,
          to: recipientAddress || 'PLACEHOLDER',
          amount: 0, // NFT transfers don't use amount
          note: note || undefined,
          assetType: 'arc72',
          contractId: contextNftToken.contractId,
          tokenId: contextNftToken.tokenId,
          networkId: contextNftToken.networkId as NetworkId,
        });
        setEstimatedFee(cost.fee);
        return;
      }

      if (!amount) return;

      const amountInBaseUnits = convertAmountToBaseUnits(amount);
      const assetOption = getCurrentAssetOption();
      const assetType =
        effectiveAssetId === 0 || !effectiveAssetId
          ? 'voi'
          : assetOption?.assetType === 'arc200'
            ? 'arc200'
            : 'asa';
      const contractId = assetOption?.contractId;

      const cost = await TransactionService.estimateTransactionCost({
        from: activeAccount.address,
        to: recipientAddress || 'PLACEHOLDER',
        amount: amountInBaseUnits,
        note: note || undefined,
        assetId: assetType === 'asa' ? (effectiveAssetId ?? undefined) : undefined,
        assetType,
        contractId,
        networkId: selectedAsset?.networkId || selectedNetworkId,
      });

      setEstimatedFee(cost.fee);
    } catch (error) {
      console.error('Failed to estimate fee:', error);
    }
  };

  const handleSend = async () => {
    if (!activeAccount) {
      Alert.alert('Error', 'Wallet not loaded');
      return;
    }

    // Block only if watch account without a Ledger signer available
    if (activeAccount.type === AccountType.WATCH && !hasLedgerSigner) {
      Alert.alert(
        'Cannot Send from Watch Account',
        'Watch accounts are read-only and cannot send transactions. Switch to a standard account to send funds.',
        [{ text: 'OK' }]
      );
      return;
    }

    if (!recipientInput.trim()) {
      Alert.alert('Error', 'Please enter recipient address or name');
      return;
    }

    if (!recipientAddress.trim()) {
      Alert.alert(
        'Error',
        nameResolutionError || 'Invalid recipient address or name'
      );
      return;
    }

    if (isResolvingName) {
      Alert.alert('Please wait', 'Resolving recipient name...');
      return;
    }

    // Set loading state
    setIsSending(true);

    try {
      // Handle ARC-72 NFT transfer
      if (contextNftToken) {
        // For NFTs, ALWAYS use the NFT's network, not the global selected network
        if (!contextNftToken.networkId) {
          Alert.alert('Error', 'NFT is missing network information');
          return;
        }

        const validationErrors = await TransactionService.validateTransaction(
          {
            from: activeAccount.address,
            to: recipientAddress.trim(),
            amount: 0, // NFT transfers don't use amount
            note: note || undefined,
            assetType: 'arc72',
            contractId: contextNftToken.contractId,
            tokenId: contextNftToken.tokenId,
            networkId: contextNftToken.networkId as NetworkId,
          },
          (activeAccount as unknown as WalletAccount)
        );

        if (validationErrors.length > 0) {
          Alert.alert('Transaction Error', validationErrors.join('\n'));
          return;
        }

        // Navigate to transaction confirmation screen for NFT
        (navigation as any).navigate('TransactionConfirmation', {
          recipient: recipientAddress.trim(),
          recipientName: resolvedName || undefined,
          amount: '1', // Display as 1 NFT
          assetSymbol: contextNftToken.metadata.name || `Token #${contextNftToken.tokenId}`,
          assetId: undefined,
          assetType: 'arc72',
          contractId: contextNftToken.contractId,
          tokenId: contextNftToken.tokenId,
          assetDecimals: 0, // NFTs have 0 decimals
          note: note || undefined,
          estimatedFee: estimatedFee,
          fromAccount: (activeAccount as unknown as WalletAccount),
          nftToken: contextNftToken,
          networkId: contextNftToken.networkId as NetworkId,
          assetImageUrl: contextNftToken.imageUrl, // Pass NFT image
        });
        return;
      }

      // Skip amount validation for NFT transfers
      if (!contextNftToken && (!amount || parseFloat(amount) <= 0)) {
        Alert.alert('Error', 'Please enter a valid amount');
        return;
      }

      // Skip regular token processing for NFT transfers (already handled above)
      if (contextNftToken) {
        return;
      }

      if (!selectedAsset) {
        Alert.alert('Error', 'Asset not selected');
        return;
      }

      // Get the actual asset option for this network
      const assetOption = getCurrentAssetOption();
      if (!assetOption) {
        Alert.alert('Error', 'Asset information not available');
        return;
      }

      const amountInBaseUnits = convertAmountToBaseUnits(amount);

      // Determine asset type from assetOption (which now includes assetType)
      const isNativeToken = assetOption.assetId === 0;
      const assetType = isNativeToken
        ? 'voi'
        : assetOption.assetType === 'arc200'
          ? 'arc200'
          : 'asa';
      const contractId = assetOption.contractId;
      const assetImageUrl = assetOption.imageUrl;

      // Validate transaction
      const validationErrors = await TransactionService.validateTransaction(
        {
          from: activeAccount.address,
          to: recipientAddress.trim(),
          amount: amountInBaseUnits,
          note: note || undefined,
          assetId: assetType === 'asa' ? assetOption.assetId : undefined,
          assetType,
          contractId,
          networkId: selectedAsset.networkId,
        },
        (activeAccount as unknown as WalletAccount)
      );

      if (validationErrors.length > 0) {
        Alert.alert('Transaction Error', validationErrors.join('\n'));
        return;
      }

      // Get mapping ID if this asset is part of a multi-network mapping
      const mappingId = contextMappingId ||
        multiNetworkBalance?.assets.find(
          a => a.assetId === assetOption.assetId && a.networkId === selectedAsset.networkId
        )?.mappingId;

      // Navigate to transaction confirmation screen
      (navigation as any).navigate('TransactionConfirmation', {
          recipient: recipientAddress.trim(),
          recipientName: resolvedName || undefined,
          amount: amount,
          assetSymbol: getAssetSymbol(),
          assetId: assetOption.assetId === 0 ? undefined : assetOption.assetId,
          assetType: assetType,
          contractId: contractId,
          assetDecimals: getAssetDecimals(),
          note: note || undefined,
          estimatedFee: estimatedFee,
          fromAccount: (activeAccount as unknown as WalletAccount),
          networkId: selectedAsset.networkId,
          assetImageUrl: assetImageUrl,
          mappingId: mappingId,
      });
    } catch (error) {
      console.error('Error preparing transaction:', error);
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to prepare transaction'
      );
    } finally {
      setIsSending(false);
    }
  };

  const resetForm = async () => {
    setRecipientAddress('');
    setAmount('');
    setNote('');
    setEstimatedFee(0);
    // Balance will auto-refresh via the useEffect watching selectedNetworkId
  };

  const formatBalance = (amount: number | bigint) => {
    return formatNativeBalance(amount, selectedNetworkConfig.nativeToken);
  };

  const handleAccountSelectorPress = () => {
    console.log('ACCOUNT SELECTOR PRESSED - OPENING MODAL');
    setIsAccountModalVisible(true);
  };

  const handleAccountModalClose = () => {
    setIsAccountModalVisible(false);
  };

  const handleAddAccount = () => {
    setIsAccountModalVisible(false);
    setIsAddAccountModalVisible(true);
  };

  const handleAssetSelect = (assetId: number) => {
    setSelectedAssetId(assetId);
    setShowAssetSelector(false);
    // Clear amount when asset changes to avoid confusion
    setAmount('');
  };

  const getAvailableAssets = () => {
    if (!accountBalance?.assets)
      return [
        {
          id: 0,
          name: selectedNetworkConfig.nativeToken,
          symbol: selectedNetworkConfig.nativeToken,
          balance: getAssetBalance(),
        },
      ];

    const nativeAsset = {
      id: 0,
      name: selectedNetworkConfig.nativeToken,
      symbol: selectedNetworkConfig.nativeToken,
      balance: formatNativeBalance(
        accountBalance.amount,
        selectedNetworkConfig.nativeToken
      ),
    };
    const otherAssets = accountBalance.assets.map((asset) => ({
      id: asset.assetType === 'arc200' ? asset.contractId : asset.assetId,
      name: asset.name || asset.symbol || `Asset ${asset.assetId}`,
      symbol: asset.symbol || 'TOKEN',
      balance: formatAssetBalance(asset.amount, asset.decimals),
      decimals: asset.decimals,
      assetType: asset.assetType,
    }));

    return [nativeAsset, ...otherAssets];
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title={
          contextNftToken
            ? 'Send NFT'
            : hasNoContext
              ? 'Send'
              : contextAssetName
                ? `Send ${contextAssetName}`
                : `Send ${currentNetworkConfig.nativeToken}`
        }
        subtitle={
          contextNftToken
            ? `Send ${contextNftToken.metadata.name || `Token #${contextNftToken.tokenId}`}`
            : hasNoContext
              ? 'Send tokens to another address'
              : contextAssetName
                ? `Send ${contextAssetName} tokens`
                : `Send ${currentNetworkConfig.nativeToken} to another address`
        }
        onAccountSelectorPress={handleAccountSelectorPress}
        showBackButton={true}
        onBackPress={() => navigation.goBack()}
      />

      <KeyboardAwareScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.content}>
            {/* NFT Token Details (shown at top when NFT is present) */}
            {contextNftToken && (
              <View style={styles.nftTokenContainer}>
                <Text style={styles.inputLabel}>NFT Token</Text>
                <View style={styles.nftTokenDetails}>
                  {contextNftToken.imageUrl && (
                    <Image
                      source={{ uri: contextNftToken.imageUrl }}
                      style={styles.nftTokenImage}
                    />
                  )}
                  <View style={styles.nftTokenInfo}>
                    <Text style={styles.nftTokenName}>
                      {contextNftToken.metadata.name || `Token #${contextNftToken.tokenId}`}
                    </Text>
                    <Text style={styles.nftTokenId}>
                      Token ID: {contextNftToken.tokenId}
                    </Text>
                    <Text style={styles.nftTokenContract}>
                      Contract: {contextNftToken.contractId}
                    </Text>
                    {contextNftToken.metadata.description && (
                      <Text style={styles.nftTokenDescription}>
                        {contextNftToken.metadata.description}
                      </Text>
                    )}
                  </View>
                </View>
              </View>
            )}

            {/* Asset Selector - show all available versions of this asset or network tokens */}
            {!contextNftToken && assetOptions.length > 0 && (
              <NetworkAssetSelector
                tokenName={hasNoContext ? 'Network Tokens' : (contextAssetName || 'Asset')}
                options={assetOptions}
                selectedAssetId={selectedAsset?.assetId}
                selectedNetworkId={selectedAsset?.networkId}
                onSelect={(networkId, assetId) => {
                  setSelectedAsset({ networkId, assetId });
                  setAmount(''); // Clear amount when switching assets
                  setEstimatedFee(0); // Reset fee estimate
                }}
                disabled={isSending}
              />
            )}

            <View style={styles.inputContainer}>
              <Text style={styles.inputLabel}>Recipient Address or Name</Text>
              <View style={styles.inputWithButton}>
                <TextInput
                  style={[
                    styles.textInputWithButton,
                    nameResolutionError && styles.textInputError,
                    recipientAddress &&
                      !nameResolutionError &&
                      styles.textInputSuccess,
                  ]}
                  placeholder="Enter address"
                  placeholderTextColor={themeColors.placeholder}
                  value={recipientInput}
                  onChangeText={setRecipientInput}
                  onFocus={() => setRecipientInputFocused(true)}
                  onBlur={() => setRecipientInputFocused(false)}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isSending}
                />
                <View style={styles.inputButtonsContainer}>
                  <TouchableOpacity
                    style={styles.inputButton}
                    onPress={handleAccountRecipientModalOpen}
                    disabled={isSending}
                  >
                    <Ionicons
                      name="people"
                      size={22}
                      color={themeColors.primary}
                    />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.inputButton}
                    onPress={handleQRScan}
                    disabled={isSending}
                  >
                    <Ionicons
                      name="qr-code"
                      size={22}
                      color={themeColors.primary}
                    />
                  </TouchableOpacity>
                </View>
              </View>
              {isResolvingName && (
                <View style={styles.resolutionStatus}>
                  <ActivityIndicator size="small" color={themeColors.primary} />
                  <Text style={styles.resolutionText}>Resolving name...</Text>
                </View>
              )}
              {isEnvoiEnabled && isSearchingNames && (
                <View style={styles.searchStatus}>
                  <ActivityIndicator size="small" color={themeColors.primary} />
                  <Text style={styles.searchStatusText}>
                    Searching Envoi...
                  </Text>
                </View>
              )}
              {nameResolutionError && !recipientInputFocused && (
                <Text style={styles.errorText}>{nameResolutionError}</Text>
              )}
              {isEnvoiEnabled && resolvedName && recipientAddress && (
                <Text style={styles.successText}>
                  Resolved: {resolvedName} → {recipientAddress.slice(0, 6)}...
                  {recipientAddress.slice(-4)}
                </Text>
              )}
              {!resolvedName &&
                recipientAddress &&
                (!isEnvoiEnabled || !isLikelyEnvoiName(recipientInput)) && (
                  <Text style={styles.addressText}>
                    {recipientAddress.slice(0, 6)}...
                    {recipientAddress.slice(-4)}
                  </Text>
                )}
              {searchResults.length > 0 && (
                <View style={styles.searchResults}>
                  {searchResults.map((result, index) => (
                    <TouchableOpacity
                      key={`${result.name}-${result.address}`}
                      style={[
                        styles.searchResultItem,
                        index === searchResults.length - 1 &&
                          styles.searchResultItemLast,
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
                        <Text style={styles.searchResultName}>
                          {result.name}
                        </Text>
                        <Text style={styles.searchResultAddress}>
                          {formatAddress(result.address)}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Amount Input (hidden when NFT is present) */}
            {!contextNftToken && (
              <View style={styles.inputContainer}>
                <Text style={styles.inputLabel}>Amount ({getAssetSymbol()})</Text>
                <TextInput
                  style={styles.textInput}
                  placeholder={`0.${'0'.repeat(getAssetDecimals())}`}
                  placeholderTextColor={themeColors.placeholder}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                  editable={!isSending}
                />
                {amount && parseFloat(amount) > 0 && (
                  <Text style={styles.maxButton}>
                    Max:{' '}
                    {(() => {
                      const option = getCurrentAssetOption();
                      if (option) {
                        // For native tokens, subtract the estimated fee
                        if (option.assetId === 0) {
                          const maxAmount = subtractBigIntSafe(option.balance, estimatedFee);
                          return `${formatAssetBalance(maxAmount, option.decimals)} ${option.symbol}`;
                        }
                        // For non-native tokens, show full balance
                        return `${formatAssetBalance(option.balance, option.decimals)} ${option.symbol}`;
                      }

                      // Fallback to legacy logic
                      if (accountBalance) {
                        if (effectiveAssetId === 0 || !effectiveAssetId) {
                          return `${formatBalance(subtractBigIntSafe(accountBalance.amount, estimatedFee))} ${transactionNetworkConfig.nativeToken}`;
                        } else {
                          const asset = getCurrentAsset();
                          if (asset) {
                            return `${formatAssetBalance(asset.amount, asset.decimals)} ${getAssetSymbol()}`;
                          }
                        }
                      }
                      return `0 ${getAssetSymbol()}`;
                    })()}
                  </Text>
                )}
              </View>
            )}

            <View style={styles.inputContainer}>
              <Text style={styles.inputLabel}>Note (Optional)</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Add a note..."
                placeholderTextColor={themeColors.placeholder}
                value={note}
                onChangeText={setNote}
                multiline
                numberOfLines={3}
                editable={!isSending}
              />
            </View>

            {estimatedFee > 0 && (
              <View style={styles.feeContainer}>
                <Text style={styles.feeLabel}>
                  Estimated Fee: {formatBalance(estimatedFee)}{' '}
                  {transactionNetworkConfig.nativeToken}
                </Text>
                {contextNftToken ? (
                  <Text style={styles.totalLabel}>
                    NFT Transfer + Fee: {(estimatedFee / 1000000).toFixed(6)} {transactionNetworkConfig.nativeToken}
                  </Text>
                ) : amount && parseFloat(amount) > 0 ? (
                  (() => {
                    const assetOption = getCurrentAssetOption();
                    const isNativeToken = assetOption ? assetOption.assetId === 0 : (effectiveAssetId === 0 || !effectiveAssetId);

                    if (isNativeToken) {
                      // For native tokens, show combined total
                      return (
                        <Text style={styles.totalLabel}>
                          Total: {(parseFloat(amount) + estimatedFee / 1000000).toFixed(6)} {transactionNetworkConfig.nativeToken}
                        </Text>
                      );
                    } else {
                      // For ASAs, show amount and fee separately with asset ID
                      const assetId = assetOption?.assetId;
                      return (
                        <Text style={styles.totalLabel}>
                          Amount: {amount} {getAssetSymbol()}{assetId ? ` (ID: ${assetId})` : ''} + Fee: {(estimatedFee / 1000000).toFixed(6)} {transactionNetworkConfig.nativeToken}
                        </Text>
                      );
                    }
                  })()
                ) : null}
              </View>
            )}

            {/* Watch Account Status */}
            {activeAccount?.type === AccountType.WATCH && (
              <View style={styles.watchAccountWarning}>
                {hasLedgerSigner ? (
                  <Text style={styles.watchAccountWarningText}>
                    🔐 Ledger signer detected for this account. You can send
                    transactions using your Ledger device.
                  </Text>
                ) : (
                  <Text style={styles.watchAccountWarningText}>
                    🔍 This is a watch-only account. You cannot send
                    transactions from this account.
                  </Text>
                )}
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.sendButton,
                {
                  opacity:
                    recipientAddress &&
                    (contextNftToken || amount) &&
                    !isSending &&
                    !(activeAccount?.type === AccountType.WATCH && !hasLedgerSigner)
                      ? 1
                      : 0.5,
                  backgroundColor:
                    activeAccount?.type === AccountType.WATCH && !hasLedgerSigner
                      ? themeColors.textMuted
                      : isSending
                        ? themeColors.textMuted
                        : themeColors.primary,
                },
              ]}
              onPress={handleSend}
              disabled={
                !recipientAddress ||
                (!contextNftToken && !amount) ||
                isSending ||
                (activeAccount?.type === AccountType.WATCH && !hasLedgerSigner)
              }
            >
              {isSending ? (
                <View style={styles.sendingContainer}>
                  <ActivityIndicator size="small" color="white" />
                  <Text style={styles.sendButtonText}>Sending...</Text>
                </View>
              ) : (
                <Text style={styles.sendButtonText}>Send Transaction</Text>
              )}
            </TouchableOpacity>
        </View>
      </KeyboardAwareScrollView>

      {/* Account List Modal */}
      <AccountListModal
        isVisible={isAccountModalVisible}
        onClose={handleAccountModalClose}
        onAddAccount={handleAddAccount}
      />

      {/* Add Account Modal */}
      <AddAccountModal
        isVisible={isAddAccountModalVisible}
        onClose={() => setIsAddAccountModalVisible(false)}
        onCreateAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.dispatch(
            CommonActions.navigate({
              name: 'Settings',
              params: {
                screen: 'CreateAccount',
              },
            })
          );
        }}
        onImportAccount={() => {
          setIsAddAccountModalVisible(false);
          navigation.dispatch(
            CommonActions.navigate({
              name: 'Settings',
              params: {
                screen: 'MnemonicImport',
              },
            })
          );
        }}
        onImportLedgerAccount={() => {
          setIsAddAccountModalVisible(false);
          (navigation as any).navigate('LedgerAccountImport');
        }}
        onImportQRAccount={() => {
          setIsAddAccountModalVisible(false);
          (navigation as any).navigate('QRAccountImport');
        }}
        onAddWatchAccount={() => {
          setIsAddAccountModalVisible(false);
          (navigation as any).navigate('Settings', { screen: 'AddWatchAccount' });
        }}
      />

      {/* Account Recipient Modal */}
      <AccountRecipientModal
        isVisible={isAccountRecipientModalVisible}
        onClose={() => setIsAccountRecipientModalVisible(false)}
        onAccountSelect={handleAccountRecipientSelect}
      />

      {/* Asset Selector Modal */}
      <Modal
        visible={showAssetSelector}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowAssetSelector(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.assetSelectorModal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Asset</Text>
              <TouchableOpacity
                onPress={() => setShowAssetSelector(false)}
                style={styles.modalCloseButton}
              >
                <Ionicons
                  name="close"
                  size={24}
                  color={themeColors.textSecondary}
                />
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.assetList}>
              {getAvailableAssets().map((asset) => (
                  <TouchableOpacity
                    key={String(asset.id)}
                  style={[
                    styles.assetOption,
                    effectiveAssetId === asset.id && styles.assetOptionSelected,
                  ]}
                onPress={() => handleAssetSelect(Number(asset.id))}
                >
                  <View style={styles.assetOptionContent}>
                    <Text style={styles.assetOptionName}>{asset.name}</Text>
                    <Text style={styles.assetOptionSymbol}>{asset.symbol}</Text>
                  </View>
                  <Text style={styles.assetOptionBalance}>{asset.balance}</Text>
                  {effectiveAssetId === asset.id && (
                    <Ionicons
                      name="checkmark"
                      size={20}
                      color={themeColors.primary}
                    />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      flexGrow: 1,
    },
    content: {
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.md,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    loadingText: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginTop: theme.spacing.sm,
    },
    balanceContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      alignItems: 'center',
      ...theme.shadows.sm,
    },
    balanceLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
    },
    balanceAmount: {
      fontSize: 18,
      fontWeight: 'bold',
      color: theme.colors.text,
    },
    balanceLoadingContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    balanceLoadingText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    inputContainer: {
      marginBottom: theme.spacing.lg,
    },
    inputLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    textInput: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      fontSize: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
      color: theme.colors.text,
    },
    inputWithButton: {
      flexDirection: 'row',
      alignItems: 'center',
      position: 'relative',
    },
    textInputWithButton: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      paddingRight: 100, // Make room for both buttons
      fontSize: 16,
      borderWidth: 1,
      borderColor: theme.colors.border,
      flex: 1,
      color: theme.colors.text,
    },
    inputButtonsContainer: {
      position: 'absolute',
      right: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
    },
    inputButton: {
      padding: theme.spacing.xs,
      marginLeft: theme.spacing.xs,
      justifyContent: 'center',
      alignItems: 'center',
    },
    sendButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      borderRadius: theme.borderRadius.md,
      marginTop: theme.spacing.sm,
      ...theme.shadows.sm,
    },
    sendButtonText: {
      color: 'white',
      fontSize: 18,
      fontWeight: '600',
      textAlign: 'center',
    },
    maxButton: {
      fontSize: 12,
      color: theme.colors.primary,
      marginTop: theme.spacing.xs,
      textAlign: 'right',
    },
    feeContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      ...theme.shadows.sm,
    },
    feeLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
    },
    totalLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    sendingContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
    },
    watchAccountWarning: {
      backgroundColor: theme.colors.surface,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
    },
    watchAccountWarningText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: 20,
    },
    textInputError: {
      borderColor: theme.colors.error,
      borderWidth: 2,
    },
    textInputSuccess: {
      borderColor: theme.colors.success,
      borderWidth: 2,
    },
    resolutionStatus: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: theme.spacing.xs,
    },
    resolutionText: {
      fontSize: 14,
      color: theme.colors.primary,
      marginLeft: theme.spacing.xs,
    },
    searchStatus: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: theme.spacing.xs,
    },
    searchStatusText: {
      fontSize: 14,
      color: theme.colors.primary,
      marginLeft: theme.spacing.xs,
    },
    errorText: {
      fontSize: 14,
      color: theme.colors.error,
      marginTop: theme.spacing.xs,
    },
    successText: {
      fontSize: 14,
      color: theme.colors.success,
      marginTop: theme.spacing.xs,
      fontWeight: '500',
    },
    addressText: {
      fontSize: 14,
      color: theme.colors.textMuted,
      marginTop: theme.spacing.xs,
      fontFamily: 'monospace',
    },
    searchResults: {
      marginTop: theme.spacing.sm,
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      overflow: 'hidden',
      ...theme.shadows.sm,
    },
    searchResultItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.borderLight,
    },
    searchResultItemLast: {
      borderBottomWidth: 0,
    },
    searchResultAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      marginRight: theme.spacing.sm,
      backgroundColor: theme.colors.surface,
    },
    searchResultFallbackAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      marginRight: theme.spacing.sm,
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
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.text,
    },
    searchResultAddress: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginTop: 2,
      fontFamily: 'monospace',
    },
    assetSelector: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginTop: theme.spacing.xs,
      ...theme.shadows.sm,
    },
    assetSelectorText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      flex: 1,
    },
    assetSelectorBalance: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginRight: theme.spacing.xs,
    },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
    },
    assetSelectorModal: {
      backgroundColor: theme.colors.card,
      borderTopLeftRadius: theme.borderRadius.lg,
      borderTopRightRadius: theme.borderRadius.lg,
      maxHeight: '70%',
    },
    modalHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: theme.spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    modalTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    modalCloseButton: {
      padding: theme.spacing.xs,
    },
    assetList: {
      paddingHorizontal: theme.spacing.lg,
    },
    assetOption: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      marginVertical: theme.spacing.xs,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface,
    },
    assetOptionSelected: {
      backgroundColor: theme.colors.surface,
      borderWidth: 2,
      borderColor: theme.colors.primary,
    },
    assetOptionContent: {
      flex: 1,
    },
    assetOptionName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    assetOptionSymbol: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginTop: 2,
    },
    assetOptionBalance: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginRight: theme.spacing.xs,
      textAlign: 'right',
    },
    // Network Indicator Styles
    networkIndicatorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      marginBottom: theme.spacing.md,
      gap: theme.spacing.xs,
    },
    networkDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    networkIndicatorText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    // NFT Token Styles
    nftTokenContainer: {
      marginBottom: theme.spacing.lg,
    },
    nftTokenDetails: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'flex-start',
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    nftTokenImage: {
      width: 80,
      height: 80,
      borderRadius: theme.borderRadius.sm,
      marginRight: theme.spacing.md,
      backgroundColor: theme.colors.surface,
    },
    nftTokenInfo: {
      flex: 1,
    },
    nftTokenName: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.xs,
    },
    nftTokenId: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
    },
    nftTokenContract: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.xs,
    },
    nftTokenDescription: {
      fontSize: 14,
      color: theme.colors.text,
      lineHeight: 20,
      marginTop: theme.spacing.xs,
    },
  });
