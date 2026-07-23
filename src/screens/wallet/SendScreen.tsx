import React, { useState, useEffect, useMemo } from 'react';
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
  Modal,
  BackHandler,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  useRoute,
  useNavigation,
  CommonActions,
  useFocusEffect,
} from '@react-navigation/native';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { TransactionService } from '@/services/transactions';
import { NetworkService } from '@/services/network';
import tokenMappingService from '@/services/token-mapping';
import type { TokenMapping } from '@/services/token-mapping/types';
import { useActiveAccount, useMultiNetworkBalance } from '@/store/walletStore';
import {
  formatNativeBalance,
  formatAssetBalance,
  parseAmountToBaseUnits,
  formatBaseUnitsToAmount,
  sanitizeAmountInput,
} from '@/utils/bigint';
import {
  AccountType,
  type WalletAccount,
  type AssetBalance,
} from '@/types/wallet';
import {
  useCurrentNetwork,
  useCurrentNetworkConfig,
} from '@/store/networkStore';
import { NetworkId } from '@/types/network';
import { getNetworkConfig } from '@/services/network/config';
import { NFTToken } from '@/types/nft';
import {
  resolveAddressOrName,
  isLikelyEnvoiName,
  formatAddress,
} from '@/utils/address';
import { isAlgorandPaymentUri, parseAlgorandUri } from '@/utils/algorandUri';
import { toErrorAlert } from '@/utils/errorMapping';
import EnvoiService, { EnvoiSearchResult } from '@/services/envoi';
import AccountListModal from '@/components/account/AccountListModal';
import AddAccountModal from '@/components/account/AddAccountModal';
import AccountRecipientModal from '@/components/account/AccountRecipientModal';
import UniversalHeader from '@/components/common/UniversalHeader';
import KeyboardAwareScrollView from '@/components/common/KeyboardAwareScrollView';
import { SecureKeyManager } from '@/services/secure/keyManager';
import NetworkAssetSelector from '@/components/send/NetworkAssetSelector';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassButton } from '@/components/common/GlassButton';
import { BlurredContainer } from '@/components/common/BlurredContainer';

interface SendScreenRouteParams {
  assetName?: string;
  assetId?: number;
  accountId?: string;
  networkId?: string;
  mappingId?: string; // For multi-network assets
  // ARC-72 NFT token for transfer
  nftToken?: NFTToken;
  // Payment request parameters from ARC-0090 URIs
  recipient?: string;
  amount?: string;
  note?: string;
  label?: string;
  asset?: string;
  fee?: string; // Transaction fee in microunits from URI
  isXnote?: boolean; // Whether the note is non-modifiable (xnote)
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
  const [hasLedgerSigner, setHasLedgerSigner] = useState(false);

  const contextAssetName = routeParams?.assetName;
  const contextNftToken = routeParams?.nftToken;
  const contextMappingId = routeParams?.mappingId;

  // State for the network-specific asset ID
  const [networkSpecificAssetId, setNetworkSpecificAssetId] = useState<
    number | null
  >(null);

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
      const mapping = mappings.find((m) =>
        m.tokens.some((t) => t.assetId === initialAssetId)
      );

      if (mapping) {
        // Find the token for the selected network
        const tokenForNetwork = mapping.tokens.find(
          (t) => t.networkId === selectedNetworkId
        );

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
    contextAssetId !== undefined && contextAssetId !== null
      ? contextAssetId
      : selectedAssetId;
  const hasNoContext = contextAssetId === undefined || contextAssetId === null;

  // Initialize selectedAssetId to native token when no context is provided
  useEffect(() => {
    if (hasNoContext && selectedAssetId === null) {
      setSelectedAssetId(0); // Default to native token
    }
  }, [hasNoContext, selectedAssetId]);

  // Track if note is non-modifiable (xnote from ARC-0090)
  const [isNoteReadOnly, setIsNoteReadOnly] = useState(false);

  // Pre-fill form fields from payment request parameters
  useEffect(() => {
    let cancelled = false;
    if (routeParams) {
      if (
        routeParams.recipient &&
        algosdk.isValidAddress(routeParams.recipient)
      ) {
        setRecipientInput(routeParams.recipient);
      }
      if (routeParams.amount && /^\d+$/.test(routeParams.amount)) {
        // routeParams.amount is RAW base units. Resolve the asset's real
        // decimals and convert base -> display exactly once. Native tokens
        // (no asset / asset 0) use 6 decimals; otherwise look up the ASA.
        const assetIdRaw = routeParams.asset
          ? parseInt(routeParams.asset)
          : undefined;
        const rawAmount = BigInt(routeParams.amount);

        (async () => {
          let decimals: number;
          if (assetIdRaw === undefined || assetIdRaw === 0) {
            decimals = 6;
          } else {
            try {
              const info =
                await NetworkService.getInstance(
                  selectedNetworkId
                ).getAssetInfo(assetIdRaw);
              const rawDecimals = info?.params?.decimals;
              if (rawDecimals === undefined || rawDecimals === null) {
                // Params unavailable (e.g. a 404 resolves to null): don't
                // prefill a wrong-magnitude amount.
                return;
              }
              decimals = Number(rawDecimals);
            } catch {
              // Don't guess a wrong value: leave the field empty on failure.
              return;
            }
          }

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

          if (!cancelled) {
            setAmount(displayAmount);
          }
        })();
      }
      if (routeParams.note) {
        // Sanitize note to prevent potential issues
        const sanitizedNote = routeParams.note.slice(0, 1000); // Limit length
        setNote(sanitizedNote);
        // If isXnote is set, make note field read-only
        if (routeParams.isXnote) {
          setIsNoteReadOnly(true);
        }
      }
      // label is display only, used for recipient name
      if (routeParams.label && routeParams.recipient) {
        const sanitizedLabel = routeParams.label.slice(0, 100); // Limit label length
        setResolvedName(sanitizedLabel);
      }
      // Fee parameter from ARC-0090 URI
      if (routeParams.fee && /^\d+$/.test(routeParams.fee)) {
        const feeInMicrounits = parseInt(routeParams.fee);
        if (feeInMicrounits >= 1000) {
          // Minimum fee is 1000 microunits
          setEstimatedFee(feeInMicrounits);
        }
      }
    }
    return () => {
      cancelled = true;
    };
  }, [routeParams]);

  const activeAccount = useActiveAccount();

  // State for all available versions of this asset across networks
  const [assetOptions, setAssetOptions] = useState<
    {
      networkId: NetworkId;
      assetId: number;
      balance: bigint;
      decimals: number;
      symbol: string;
      name: string;
      assetType?: 'asa' | 'arc200' | 'arc72';
      contractId?: number;
      imageUrl?: string;
    }[]
  >([]);

  // Selected asset state
  const [selectedAsset, setSelectedAsset] = useState<{
    networkId: NetworkId;
    assetId: number;
  } | null>(null);

  // Balance for the selected asset
  const [accountBalance, setAccountBalance] = useState<any>(null);

  const { balance: multiNetworkBalance } = useMultiNetworkBalance(
    activeAccount?.id || ''
  );

  // The asset the send flow is scoped to (parsed from the route). Depended on
  // by the option builder below, so keep it memoized (and reactive to BOTH
  // `asset` and `assetId` route params).
  const initialAssetId = useMemo(() => {
    return routeParams?.asset
      ? isNaN(parseInt(routeParams.asset, 10))
        ? undefined
        : parseInt(routeParams.asset, 10)
      : routeParams?.assetId;
  }, [routeParams?.asset, routeParams?.assetId]);

  // Token mappings, held in state so the option builder (both the narrowing
  // memo below and the effect) reacts to them loading. Seed synchronously from
  // the cache (bundled defaults at worst — never empty) so there's no empty
  // window, then refresh from the (possibly newer) fetched mappings. Using one
  // state value for both keeps the memo and the effect from diverging.
  const [tokenMappings, setTokenMappings] = useState<TokenMapping[]>(() =>
    tokenMappingService.getCachedMappings()
  );
  useEffect(() => {
    let cancelled = false;
    tokenMappingService
      .getTokenMappings()
      .then((mappings) => {
        if (!cancelled) setTokenMappings(mappings);
      })
      .catch(() => {
        // Keep the seeded cache/defaults on failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Narrow the multi-network balance down to only the mapped asset(s) the
  // option builder needs, serialized to a stable string. multiNetworkBalance
  // gets a fresh object reference on every balance refresh (screen focus,
  // pull-to-refresh, post-transaction), so depending the effect directly on it
  // re-runs the whole builder — and re-fetches — while the user is composing.
  // Keying off the serialized relevant slice instead means the effect only
  // re-runs when the data it actually consumes changes.
  const relevantBalanceKey = useMemo(() => {
    const assets = multiNetworkBalance?.assets;
    if (!assets || assets.length === 0) return '[]';

    const mappings = tokenMappings;

    const relevant =
      initialAssetId === undefined
        ? // No asset context: every native-token mapping (native = assetId 0).
          (() => {
            const nativeMappingIds = new Set(
              mappings
                .filter((m) => m.tokens.some((t) => t.assetId === 0))
                .map((m) => m.mappingId)
            );
            return assets.filter(
              (a) =>
                a.isMapped && !!a.mappingId && nativeMappingIds.has(a.mappingId)
            );
          })()
        : // Scoped to one asset: just its mapping's balance entry.
          (() => {
            const mapping = contextMappingId
              ? mappings.find((m) => m.mappingId === contextMappingId)
              : mappings.find((m) =>
                  m.tokens.some((t) => t.assetId === initialAssetId)
                );
            return mapping
              ? assets.filter(
                  (a) => a.isMapped && a.mappingId === mapping.mappingId
                )
              : [];
          })();

    const slim = relevant.map((a) => ({
      mappingId: a.mappingId,
      sourceBalances: (a.sourceBalances ?? []).map((s) => ({
        networkId: s.networkId,
        assetId: s.balance.assetId,
        // bigint amounts don't survive JSON; keep as string and BigInt() later.
        amount: s.balance.amount.toString(),
        decimals: s.balance.decimals,
        symbol: s.balance.symbol ?? '',
        name: s.balance.name ?? '',
        imageUrl: s.balance.imageUrl,
      })),
    }));
    return JSON.stringify(slim);
  }, [
    multiNetworkBalance?.assets,
    initialAssetId,
    contextMappingId,
    tokenMappings,
  ]);

  // Parsed form of the narrowed slice. Derived solely from the string key, so
  // its reference stays stable across balance refreshes with identical data.
  const relevantMappedAssets = useMemo(
    () =>
      JSON.parse(relevantBalanceKey) as {
        mappingId?: string;
        sourceBalances: {
          networkId: NetworkId;
          assetId: number;
          amount: string;
          decimals: number;
          symbol: string;
          name: string;
          imageUrl?: string;
        }[];
      }[],
    [relevantBalanceKey]
  );

  // Fetch all available versions of this asset across networks
  useEffect(() => {
    // Guard against a stale async run overwriting fresher state. This effect
    // can start a new run (mappings loading, balance changing) before an
    // earlier run's awaited lookups resolve; without this, an older
    // (e.g. direct/unmapped) result could land after a newer one and clobber
    // good options — even replacing them with []. Cleanup flips this flag, so
    // the superseded run bails before any setState.
    let cancelled = false;

    const fetchAssetOptions = async () => {
      if (!activeAccount) {
        return;
      }

      try {
        // Same mappings the narrowing memo used (see relevantMappedAssets), so
        // the mapping lookup below stays consistent with the pre-narrowed slice.
        const mappings = tokenMappings;
        const options = [];

        // When no asset context is provided, show all network tokens (native + bridged)
        if (initialAssetId === undefined) {
          // Build from the narrowed native-token mapped assets.
          for (const mappedAsset of relevantMappedAssets) {
            // Add all tokens in this mapping (native + bridged versions)
            for (const source of mappedAsset.sourceBalances) {
              options.push({
                networkId: source.networkId,
                assetId: source.assetId,
                balance: BigInt(source.amount),
                decimals: source.decimals,
                symbol: source.symbol,
                name: source.name,
                imageUrl: source.imageUrl,
              });
            }
          }
        } else {
          // Has asset context - show only versions of this specific asset
          // If mappingId is provided, use it directly (most reliable)
          let mapping = contextMappingId
            ? mappings.find((m) => m.mappingId === contextMappingId)
            : mappings.find((m) =>
                m.tokens.some((t) => t.assetId === initialAssetId)
              );

          if (mapping) {
            // Find the mapped asset in the narrowed multi-network balance
            const mappedAsset = relevantMappedAssets.find(
              (a) => a.mappingId === mapping.mappingId
            );

            if (mappedAsset && mappedAsset.sourceBalances.length > 0) {
              // Build options from sourceBalances (includes native tokens with assetId 0)
              for (const source of mappedAsset.sourceBalances) {
                options.push({
                  networkId: source.networkId,
                  assetId: source.assetId,
                  balance: BigInt(source.amount),
                  decimals: source.decimals,
                  symbol: source.symbol || contextAssetName || '',
                  name: source.name || contextAssetName || '',
                  imageUrl: source.imageUrl,
                });
              }
            } else {
              // Mapped but no balance data - fetch directly from network
              const networkId =
                (routeParams?.networkId as NetworkId) || currentNetwork;
              const networkService = NetworkService.getInstance(networkId);
              const accountInfo = await networkService
                .getAlgodClient()
                .accountInformation(activeAccount.address)
                .do();

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
                // algosdk v3: asset holdings expose `assetId` (a uint64 bigint),
                // not the legacy 'asset-id'. Compare as strings so large IDs
                // aren't collapsed by a lossy Number() cast.
                const assetHolding = accountInfo.assets?.find(
                  (a: any) => String(a.assetId) === String(initialAssetId)
                );

                if (assetHolding) {
                  const assetInfo = await networkService
                    .getAlgodClient()
                    .getAssetByID(initialAssetId)
                    .do();

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
            // Not in a mapping, just show this one asset. Use a targeted lookup
            // instead of the full getAccountBalance pipeline (pricing, rekey
            // info, and a per-holding metadata loop) just to locate one asset.
            // getSingleAssetBalance still discovers unmapped ARC-200 assets via
            // Mimir, so this doesn't regress ARC-200 support.
            const networkId =
              (routeParams?.networkId as NetworkId) || currentNetwork;
            const networkService = NetworkService.getInstance(networkId);

            const asset = initialAssetId
              ? await networkService.getSingleAssetBalance(
                  activeAccount.address,
                  initialAssetId
                )
              : null;

            if (asset) {
              // Found (ASA or ARC-200)
              options.push({
                networkId,
                assetId:
                  (asset.assetType === 'arc200'
                    ? asset.contractId
                    : asset.assetId) ?? 0,
                balance: BigInt(asset.amount),
                decimals: asset.decimals,
                symbol: asset.symbol || contextAssetName || '',
                name: asset.name || contextAssetName || '',
                assetType: asset.assetType,
                contractId:
                  asset.assetType === 'arc200' ? asset.contractId : undefined,
                imageUrl: asset.imageUrl,
              });
            } else if (initialAssetId === 0) {
              // Native token — resolve the native balance directly
              // (getSingleAssetBalance intentionally doesn't handle assetId 0).
              const networkConfig = getNetworkConfig(networkId);
              const accountInfo = await networkService
                .getAlgodClient()
                .accountInformation(activeAccount.address)
                .do();
              options.push({
                networkId,
                assetId: 0,
                balance: BigInt(accountInfo.amount || 0),
                decimals: 6,
                symbol: networkConfig.nativeToken,
                name: networkConfig.nativeToken,
                imageUrl: undefined, // Native token images are handled by network config
              });
            }
          }
        }

        // A newer run has superseded this one — don't clobber its state.
        if (cancelled) return;

        setAssetOptions(options);

        // Auto-select based on route params or default to current network's native token
        if (options.length > 0) {
          const routeNetworkId = routeParams?.networkId as NetworkId;

          if (initialAssetId === undefined) {
            // No asset context: default to current network's native token
            const defaultOption =
              options.find(
                (o) => o.networkId === currentNetwork && o.assetId === 0
              ) || options[0];

            setSelectedAsset({
              networkId: defaultOption.networkId,
              assetId: defaultOption.assetId,
            });
          } else {
            // Has asset context: match both networkId AND assetId
            let matchingOption = routeNetworkId
              ? options.find(
                  (o) =>
                    o.networkId === routeNetworkId &&
                    o.assetId === initialAssetId
                )
              : null;

            // If no route networkId specified, use the current network
            if (!matchingOption && !routeNetworkId) {
              matchingOption = options.find(
                (o) =>
                  o.networkId === currentNetwork && o.assetId === initialAssetId
              );
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
      }
    };

    fetchAssetOptions();

    return () => {
      cancelled = true;
    };
  }, [
    activeAccount?.address,
    initialAssetId,
    routeParams?.networkId,
    contextMappingId,
    contextAssetName,
    currentNetwork,
    tokenMappings,
    // Content-stable slice of the balance (see relevantBalanceKey) — replaces
    // the whole multiNetworkBalance.assets array so the builder doesn't re-run
    // on every balance refresh.
    relevantMappedAssets,
  ]);

  // Balance is already in assetOptions - no need to fetch separately

  // Handle Android back button for local modals
  useEffect(() => {
    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        // Close modals in order of priority (most recently likely opened first)
        if (showAssetSelector) {
          setShowAssetSelector(false);
          return true;
        }
        if (isAddAccountModalVisible) {
          setIsAddAccountModalVisible(false);
          return true;
        }
        if (isAccountRecipientModalVisible) {
          setIsAccountRecipientModalVisible(false);
          return true;
        }
        if (isAccountModalVisible) {
          setIsAccountModalVisible(false);
          return true;
        }
        return false; // Let default back behavior happen
      }
    );

    return () => backHandler.remove();
  }, [
    isAccountModalVisible,
    isAddAccountModalVisible,
    isAccountRecipientModalVisible,
    showAssetSelector,
  ]);

  // Determine signing capability and Ledger signer presence for the active account
  useEffect(() => {
    let isCancelled = false;
    const loadSigningCapability = async () => {
      try {
        if (!activeAccount) {
          if (!isCancelled) {
            setHasLedgerSigner(false);
          }
          return;
        }

        const info = await SecureKeyManager.getSigningInfo(
          activeAccount.address
        );
        if (isCancelled) return;

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
      (opt) =>
        opt.networkId === selectedAsset.networkId &&
        opt.assetId === selectedAsset.assetId
    );
  };

  const getCurrentAsset = () => {
    if (effectiveAssetId === 0 || !effectiveAssetId) {
      return null; // Native token doesn't have enhanced asset data
    }
    return accountBalance?.assets?.find(
      (a: AssetBalance) =>
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

  const convertAmountToBaseUnits = (amount: string): bigint => {
    // Exact string -> base-units conversion (no float precision loss).
    return parseAmountToBaseUnits(amount, getAssetDecimals());
  };

  // Exact spendable base-unit amount for the currently-selected asset.
  const getSpendableBase = (): bigint => {
    const option = getCurrentAssetOption();
    // Native token: spendable = balance - fee - minBalance (minBalance grows with
    // opt-ins). Asset: full balance (the fee is paid in the native token).
    const isNative = option
      ? option.assetId === 0
      : effectiveAssetId === 0 || !effectiveAssetId;
    try {
      if (isNative) {
        const bal = BigInt(option?.balance ?? accountBalance?.amount ?? 0);
        const minBal = BigInt(accountBalance?.minBalance ?? 0);
        const fee = BigInt(Math.trunc(estimatedFee || 0));
        const spendable = bal - fee - minBal;
        return spendable > 0n ? spendable : 0n;
      }
      const bal = option?.balance ?? getCurrentAsset()?.amount ?? 0;
      return BigInt(bal);
    } catch {
      return 0n;
    }
  };

  // Inline (as-you-type) amount validation — mirrors the recipient inline-error
  // pattern. Exact BigInt comparison against the spendable base-unit amount.
  const amountError = React.useMemo<string | null>(() => {
    if (!amount) return null;
    const option = getCurrentAssetOption();
    const isNative = option
      ? option.assetId === 0
      : effectiveAssetId === 0 || !effectiveAssetId;
    try {
      const parsed = parseAmountToBaseUnits(amount, getAssetDecimals());
      if (parsed <= 0n) return 'Enter an amount greater than 0';
      if (parsed > getSpendableBase()) {
        return isNative
          ? 'Amount exceeds spendable balance (after fees & minimum balance)'
          : 'Amount exceeds your balance';
      }
      return null;
    } catch {
      return 'Enter a valid amount';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps hand-mirror the inputs of the helpers this memo calls (getCurrentAssetOption / getAssetDecimals / getSpendableBase): amount, accountBalance, estimatedFee, effectiveAssetId, selectedAsset, assetOptions. Those helpers are read at the current commit; mirror any new read they gain here.
  }, [
    amount,
    accountBalance,
    estimatedFee,
    effectiveAssetId,
    selectedAsset,
    assetOptions,
  ]);

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
        if (
          input === recipientAddress ||
          (resolvedName && input === resolvedName)
        ) {
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
        assetId:
          assetType === 'asa' ? (effectiveAssetId ?? undefined) : undefined,
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
          activeAccount as unknown as WalletAccount
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
          assetSymbol:
            contextNftToken.metadata.name ||
            `Token #${contextNftToken.tokenId}`,
          assetId: undefined,
          assetType: 'arc72',
          contractId: contextNftToken.contractId,
          tokenId: contextNftToken.tokenId,
          assetDecimals: 0, // NFTs have 0 decimals
          note: note || undefined,
          estimatedFee: estimatedFee,
          fromAccount: activeAccount as unknown as WalletAccount,
          nftToken: contextNftToken,
          networkId: contextNftToken.networkId as NetworkId,
          assetImageUrl: contextNftToken.imageUrl, // Pass NFT image
        });
        return;
      }

      // Skip amount validation for NFT transfers
      // Use !(x > 0) rather than (x <= 0) so a NaN amount (e.g. a bare '.')
      // is rejected instead of slipping through as a zero-value transfer.
      if (!contextNftToken && (!amount || !(parseFloat(amount) > 0))) {
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
        activeAccount as unknown as WalletAccount
      );

      if (validationErrors.length > 0) {
        Alert.alert('Transaction Error', validationErrors.join('\n'));
        return;
      }

      // Get mapping ID if this asset is part of a multi-network mapping.
      // Match against the mapped asset's source balances (the aggregate's
      // top-level assetId/primaryNetwork only describe the first source, so a
      // non-primary selected version would otherwise never match).
      const mappingId =
        contextMappingId ||
        multiNetworkBalance?.assets.find(
          (a) =>
            a.isMapped &&
            a.sourceBalances.some(
              (s) =>
                s.networkId === selectedAsset.networkId &&
                s.balance.assetId === assetOption.assetId
            )
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
        fromAccount: activeAccount as unknown as WalletAccount,
        networkId: selectedAsset.networkId,
        assetImageUrl: assetImageUrl,
        mappingId: mappingId,
      });
    } catch (error) {
      console.error('Error preparing transaction:', error);
      // TASK-41: never surface the raw SDK/algod message here — it produces
      // strings like "TransactionPool.Remember: ... overspend ..." at the most
      // stressful moment in the app.
      const { title, message } = toErrorAlert(error, {
        fallbackMessage: "We couldn't prepare this transaction.",
      });
      Alert.alert(title, message);
    } finally {
      setIsSending(false);
    }
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
    const otherAssets = accountBalance.assets.map((asset: AssetBalance) => ({
      id: asset.assetType === 'arc200' ? asset.contractId : asset.assetId,
      name: asset.name || asset.symbol || `Asset ${asset.assetId}`,
      symbol: asset.symbol || 'TOKEN',
      balance: formatAssetBalance(asset.amount, asset.decimals),
      decimals: asset.decimals,
      assetType: asset.assetType,
    }));

    return [nativeAsset, ...otherAssets];
  };

  const { theme } = useTheme();

  return (
    <NFTBackground>
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
                      contentFit="cover"
                      cachePolicy="memory-disk"
                      recyclingKey={contextNftToken.imageUrl}
                    />
                  )}
                  <View style={styles.nftTokenInfo}>
                    <Text style={styles.nftTokenName}>
                      {contextNftToken.metadata.name ||
                        `Token #${contextNftToken.tokenId}`}
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
                tokenName={
                  hasNoContext ? 'Network Tokens' : contextAssetName || 'Asset'
                }
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

            <BlurredContainer
              variant="light"
              borderRadius={theme.borderRadius.md}
              style={styles.inputContainer}
            >
              <Text style={styles.inputLabelInContainer}>
                Recipient Address or Name
              </Text>
              <View style={styles.inputWithButton}>
                <TextInput
                  style={[
                    styles.textInputWithButtonInContainer,
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
                    accessibilityRole="button"
                    accessibilityLabel="Choose recipient from accounts and contacts"
                    accessibilityState={{ disabled: isSending }}
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
                    accessibilityRole="button"
                    accessibilityLabel="Scan recipient QR code"
                    accessibilityState={{ disabled: isSending }}
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
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={`${result.name}, ${result.address}`}
                      accessibilityHint="Selects this address as the recipient"
                    >
                      {result.avatar ? (
                        <Image
                          source={{ uri: result.avatar }}
                          style={styles.searchResultAvatar}
                          contentFit="cover"
                          cachePolicy="memory-disk"
                          recyclingKey={result.avatar}
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
            </BlurredContainer>

            {/* Amount Input (hidden when NFT is present) */}
            {!contextNftToken && (
              <BlurredContainer
                variant="light"
                borderRadius={theme.borderRadius.md}
                style={styles.inputContainer}
              >
                <Text style={styles.inputLabelInContainer}>
                  Amount ({getAssetSymbol()})
                </Text>
                <TextInput
                  style={[
                    styles.textInputInContainer,
                    amountError && styles.textInputError,
                  ]}
                  placeholder={`0.${'0'.repeat(getAssetDecimals())}`}
                  placeholderTextColor={themeColors.placeholder}
                  value={amount}
                  onChangeText={(t) =>
                    setAmount((prev) => sanitizeAmountInput(t) ?? prev)
                  }
                  keyboardType="decimal-pad"
                  editable={!isSending}
                />
                {amountError && (
                  <Text style={styles.errorText}>{amountError}</Text>
                )}
                {getSpendableBase() > 0n && (
                  <TouchableOpacity
                    onPress={() =>
                      setAmount(
                        formatBaseUnitsToAmount(
                          getSpendableBase(),
                          getAssetDecimals()
                        )
                      )
                    }
                    disabled={isSending}
                    accessibilityRole="button"
                    accessibilityLabel="Send maximum spendable amount"
                    accessibilityState={{ disabled: isSending }}
                  >
                    <Text style={styles.maxButton}>
                      Max:{' '}
                      {formatBaseUnitsToAmount(
                        getSpendableBase(),
                        getAssetDecimals()
                      )}{' '}
                      {getAssetSymbol()}
                    </Text>
                  </TouchableOpacity>
                )}
              </BlurredContainer>
            )}

            <BlurredContainer
              variant="light"
              borderRadius={theme.borderRadius.md}
              style={styles.inputContainer}
            >
              <Text style={styles.inputLabelInContainer}>
                Note (Optional){isNoteReadOnly ? ' - Fixed' : ''}
              </Text>
              <TextInput
                style={[
                  styles.textInputInContainer,
                  isNoteReadOnly && styles.readOnlyInput,
                ]}
                placeholder="Add a note..."
                placeholderTextColor={themeColors.placeholder}
                value={note}
                onChangeText={isNoteReadOnly ? undefined : setNote}
                multiline
                numberOfLines={3}
                editable={!isSending && !isNoteReadOnly}
              />
            </BlurredContainer>

            {estimatedFee > 0 && (
              <BlurredContainer
                variant="light"
                borderRadius={theme.borderRadius.md}
                style={styles.feeContainer}
              >
                <Text style={styles.feeLabel}>
                  Estimated Fee: {formatBalance(estimatedFee)}{' '}
                  {transactionNetworkConfig.nativeToken}
                </Text>
                {contextNftToken ? (
                  <Text style={styles.totalLabel}>
                    NFT Transfer + Fee: {(estimatedFee / 1000000).toFixed(6)}{' '}
                    {transactionNetworkConfig.nativeToken}
                  </Text>
                ) : amount && parseFloat(amount) > 0 ? (
                  (() => {
                    const assetOption = getCurrentAssetOption();
                    const isNativeToken = assetOption
                      ? assetOption.assetId === 0
                      : effectiveAssetId === 0 || !effectiveAssetId;

                    if (isNativeToken) {
                      // For native tokens, show combined total
                      return (
                        <Text style={styles.totalLabel}>
                          Total:{' '}
                          {(
                            parseFloat(amount) +
                            estimatedFee / 1000000
                          ).toFixed(6)}{' '}
                          {transactionNetworkConfig.nativeToken}
                        </Text>
                      );
                    } else {
                      // For ASAs, show amount and fee separately with asset ID
                      const assetId = assetOption?.assetId;
                      return (
                        <Text style={styles.totalLabel}>
                          Amount: {amount} {getAssetSymbol()}
                          {assetId ? ` (ID: ${assetId})` : ''} + Fee:{' '}
                          {(estimatedFee / 1000000).toFixed(6)}{' '}
                          {transactionNetworkConfig.nativeToken}
                        </Text>
                      );
                    }
                  })()
                ) : null}
              </BlurredContainer>
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

            <GlassButton
              variant={
                activeAccount?.type === AccountType.WATCH && !hasLedgerSigner
                  ? 'secondary'
                  : 'primary'
              }
              label={isSending ? 'Sending...' : 'Send Transaction'}
              icon={isSending ? undefined : 'paper-plane'}
              loading={isSending}
              disabled={
                !recipientAddress ||
                (!contextNftToken && !amount) ||
                !!amountError ||
                isSending ||
                (activeAccount?.type === AccountType.WATCH && !hasLedgerSigner)
              }
              onPress={handleSend}
              fullWidth
              glow
              size="lg"
            />
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
            (navigation as any).navigate('Settings', {
              screen: 'AddWatchAccount',
            });
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
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  accessibilityRole="button"
                  accessibilityLabel="Close asset selector"
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
                      effectiveAssetId === asset.id &&
                        styles.assetOptionSelected,
                    ]}
                    onPress={() => handleAssetSelect(Number(asset.id))}
                    accessible
                    accessibilityRole="radio"
                    accessibilityLabel={`${asset.name}, ${asset.symbol}`}
                    // A radio reports its chosen state through `checked`;
                    // `selected` is for tabs/list selection and is not
                    // announced for this role.
                    accessibilityState={{
                      checked: effectiveAssetId === asset.id,
                    }}
                  >
                    <View style={styles.assetOptionContent}>
                      <Text style={styles.assetOptionName}>{asset.name}</Text>
                      <Text style={styles.assetOptionSymbol}>
                        {asset.symbol}
                      </Text>
                    </View>
                    <Text style={styles.assetOptionBalance}>
                      {asset.balance}
                    </Text>
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
    </NFTBackground>
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
      padding: theme.spacing.md,
    },
    inputLabel: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
      // Text shadow for readability over NFT backgrounds
      textShadowColor:
        theme.mode === 'dark'
          ? 'rgba(0, 0, 0, 1.0)'
          : 'rgba(255, 255, 255, 1.0)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 16,
    },
    // Label style for inside BlurredContainer (no shadow needed)
    inputLabelInContainer: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    textInput: {
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.1)'
          : 'rgba(255, 255, 255, 0.4)',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      fontSize: 16,
      borderWidth: 1,
      borderColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.15)'
          : 'rgba(255, 255, 255, 0.5)',
      color: theme.colors.text,
    },
    // TextInput style for inside BlurredContainer (subtle inner styling)
    textInputInContainer: {
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(0, 0, 0, 0.2)'
          : 'rgba(255, 255, 255, 0.3)',
      borderRadius: theme.borderRadius.sm,
      padding: theme.spacing.md,
      fontSize: 16,
      borderWidth: 1,
      borderColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.1)'
          : 'rgba(0, 0, 0, 0.05)',
      color: theme.colors.text,
    },
    // Style for read-only inputs (e.g., xnote from ARC-0090)
    readOnlyInput: {
      backgroundColor:
        theme.mode === 'dark' ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.05)',
      opacity: 0.8,
    },
    inputWithButton: {
      flexDirection: 'row',
      alignItems: 'center',
      position: 'relative',
    },
    textInputWithButton: {
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.1)'
          : 'rgba(255, 255, 255, 0.4)',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      paddingRight: 100, // Make room for both buttons
      fontSize: 16,
      borderWidth: 1,
      borderColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.15)'
          : 'rgba(255, 255, 255, 0.5)',
      flex: 1,
      color: theme.colors.text,
    },
    // TextInput with button style for inside BlurredContainer
    textInputWithButtonInContainer: {
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(0, 0, 0, 0.2)'
          : 'rgba(255, 255, 255, 0.3)',
      borderRadius: theme.borderRadius.sm,
      padding: theme.spacing.md,
      // Room for the absolute button cluster: right:16 + (44 + 4)*2 = 112.
      paddingRight: 112,
      fontSize: 16,
      borderWidth: 1,
      borderColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.1)'
          : 'rgba(0, 0, 0, 0.05)',
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
      // 44x44 minimum touch target (contacts + QR buttons sit side by side, so
      // a real min-size beats hitSlop, which would overlap across the 4pt gap).
      minWidth: 44,
      minHeight: 44,
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
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
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
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.08)'
          : 'rgba(255, 255, 255, 0.35)',
      borderWidth: 1,
      borderColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.12)'
          : 'rgba(255, 255, 255, 0.45)',
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
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(30, 30, 40, 0.9)'
          : 'rgba(255, 255, 255, 0.85)',
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.15)'
          : 'rgba(255, 255, 255, 0.5)',
      overflow: 'hidden',
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
      backgroundColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.1)'
          : 'rgba(255, 255, 255, 0.4)',
      borderRadius: theme.borderRadius.md,
      padding: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'flex-start',
      borderWidth: 1,
      borderColor:
        theme.mode === 'dark'
          ? 'rgba(255, 255, 255, 0.15)'
          : 'rgba(255, 255, 255, 0.5)',
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
