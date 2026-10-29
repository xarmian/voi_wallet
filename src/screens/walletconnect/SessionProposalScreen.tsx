import React, {
  useState,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  AppState,
} from 'react-native';
import { Image } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { RootStackParamList } from '@/navigation/AppNavigator';
import {
  WalletConnectService,
  SessionProposal,
  getNetworkNameByChainId,
  VOI_CHAIN_DATA,
  ALGORAND_MAINNET_CHAIN_DATA,
} from '@/services/walletconnect';
import { resolveV1Chain } from '@/services/walletconnect/v1/config';
import { WalletConnectV1Client } from '@/services/walletconnect/v1';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountMetadata } from '@/types/wallet';
import UniversalHeader from '@/components/common/UniversalHeader';
import {
  getProposalChains,
  resolveProposalEligibility,
} from '@/services/walletconnect/utils';
import { useExperimentalStore } from '@/store/experimentalStore';
import AccountSelectionItem from '@/components/walletconnect/AccountSelectionItem';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useAuth } from '@/contexts/AuthContext';
import {
  reviewGrant,
  walletConnectRequestKey,
} from '@/services/auth/reviewGrant';
import LockedRequestGate from '@/components/walletconnect/LockedRequestGate';
import {
  useAppSwitcherProtection,
  useSecureScreen,
} from '@/hooks/useSecureScreen';

type SessionProposalScreenNavigationProp = NativeStackNavigationProp<
  RootStackParamList,
  'WalletConnectSessionProposal'
>;
type SessionProposalScreenRouteProp = RouteProp<
  RootStackParamList,
  'WalletConnectSessionProposal'
>;

interface Props {
  navigation: SessionProposalScreenNavigationProp;
  route: SessionProposalScreenRouteProp;
}

export default function SessionProposalScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const styles = useThemedStyles(createStyles);

  // Check for v1 or v2 proposal
  const proposal = route?.params?.proposal as SessionProposal | undefined;
  const version = route?.params?.version as number | undefined;
  const v1SessionRequest = route?.params?.sessionRequest;

  // Determine which version we're handling
  const isV1 = version === 1 || v1SessionRequest;

  // TASK-438: while the wallet is locked the connect screen shows only the
  // gate (dApp name and icon, URL host, requested networks; Unlock to review /
  // Reject). Accounts are not loaded, probed or mounted until the review
  // sitting covers this proposal. The sitting is TASK-437's: one unlock covers
  // everything in it, and it ends on background, idle, re-lock or queue end.
  useSecureScreen();
  useAppSwitcherProtection();
  const { authState } = useAuth();
  const requestKey = proposal
    ? walletConnectRequestKey(proposal.pairingTopic, `proposal-${proposal.id}`)
    : walletConnectRequestKey(
        'v1',
        `proposal-${v1SessionRequest?.peerId ?? ''}`
      );
  const requiresReviewUnlock = authState.isLocked || !authState.isAuthenticated;
  const grantValid = useSyncExternalStore(reviewGrant.subscribe, () =>
    reviewGrant.isValid(requestKey)
  );
  const [foreground, setForeground] = useState(
    AppState.currentState !== 'background' &&
      AppState.currentState !== 'inactive'
  );
  const canReview = !requiresReviewUnlock || (grantValid && foreground);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active');
      if (state === 'background') reviewGrant.revoke();
    });
    return () => subscription.remove();
  }, []);

  // However the screen is left, this proposal leaves the sitting.
  useEffect(() => () => reviewGrant.leave(requestKey), [requestKey]);
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () =>
        reviewGrant.leave(requestKey)
      ),
    [navigation, requestKey]
  );

  const [probing, setProbing] = useState(true);
  const [eligibility, setEligibility] = useState<
    Awaited<ReturnType<typeof resolveProposalEligibility>>
  >([]);
  const [approvedChains, setApprovedChains] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [accounts, setAccounts] = useState<AccountMetadata[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    new Set()
  );

  const generation = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    // Only load accounts when there's actually a proposal to act on. The
    // no-proposal early return now sits below the hooks (to keep hook order
    // unconditional), so without this guard loadAccounts() — and its error
    // Alerts — would fire on the "No proposal data" screen too.
    if (!proposal && !v1SessionRequest) return;
    // TASK-438: no account read or keystore probe before review is allowed.
    if (!canReview) return;
    loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the proposal changes or review becomes allowed
  }, [proposal, v1SessionRequest, canReview]);

  const loadAccounts = async () => {
    const current = ++generation.current;
    inFlight.current = true;
    setProbing(true);
    try {
      const allAccounts = await MultiAccountWalletService.getAllAccounts();
      const v1Chain = resolveV1Chain(v1SessionRequest?.chainId);
      const chains = isV1
        ? v1Chain
          ? [v1Chain.chainId]
          : []
        : getProposalChains(
            proposal!,
            useExperimentalStore.getState().allowUnsupportedNetworks
          );
      const result = await resolveProposalEligibility(allAccounts, chains);
      if (current !== generation.current) return;
      setApprovedChains(chains);
      setEligibility(result);
      const signableAccounts = result
        .filter((entry) => entry.eligibleChains.length)
        .map((entry) => entry.account);
      setAccounts(signableAccounts);
      // Pre-select all signable accounts by default
      const initialSelection = new Set(
        signableAccounts.map((account) => account.id)
      );
      setSelectedAccountIds(initialSelection);
    } catch (error) {
      if (current !== generation.current) return;
      console.error('Failed to load accounts:', error);
      Alert.alert('Error', 'Failed to load accounts');
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        setProbing(false);
      }
    }
  };

  const handleApprove = async () => {
    // TASK-438: connecting shares account addresses, so it needs review access.
    if (requiresReviewUnlock && !reviewGrant.isValid(requestKey)) return;
    if (accounts.length === 0) {
      Alert.alert('Error', 'No signable accounts available');
      return;
    }

    if (selectedAccountIds.size === 0) {
      Alert.alert('Error', 'Please select at least one account to connect');
      return;
    }

    setIsLoading(true);
    try {
      const selectedAccounts = accounts.filter((account) =>
        selectedAccountIds.has(account.id)
      );

      if (isV1) {
        // Handle v1 session approval
        const v1Client = WalletConnectV1Client.getInstance();
        const accountAddresses = selectedAccounts.map((acc) => acc.address);
        // Don't pass chainId - let the client use the dApp's requested chainId
        await v1Client.approveSession(accountAddresses);
      } else {
        // Handle v2 session approval
        const wcService = WalletConnectService.getInstance();
        await wcService.approveSession(proposal!, selectedAccounts);
      }

      Alert.alert('Success', 'Successfully connected to dApp', [
        {
          text: 'OK',
          onPress: () => navigation.navigate('Main'),
        },
      ]);
    } catch (error) {
      console.error('Failed to approve session:', error);
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to connect to dApp'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleReject = async () => {
    setIsLoading(true);
    try {
      if (isV1) {
        // Handle v1 session rejection
        const v1Client = WalletConnectV1Client.getInstance();
        await v1Client.rejectSession();
      } else {
        // Handle v2 session rejection
        const wcService = WalletConnectService.getInstance();
        await wcService.rejectSession(proposal!);
      }

      navigation.goBack();
    } catch (error) {
      console.error('Failed to reject session:', error);
      // If rejection fails (e.g., proposal no longer exists), just navigate back
      // This can happen if the dApp closed the connection before we rejected
      navigation.goBack();
    } finally {
      setIsLoading(false);
    }
  };

  const renderDAppInfo = () => {
    // Get metadata from v1 or v2 proposal
    const metadata = isV1
      ? v1SessionRequest?.peerMeta
      : proposal?.proposer.metadata;

    if (!metadata) return null;

    return (
      <View style={styles.dappContainer}>
        {metadata.icons && metadata.icons.length > 0 && (
          <Image
            source={{ uri: metadata.icons[0] }}
            style={styles.dappIcon}
            contentFit="cover"
            cachePolicy="memory-disk"
            placeholder={require('../../../assets/icon.png')}
          />
        )}
        <Text style={styles.dappName}>{metadata.name}</Text>
        <Text style={styles.dappDescription}>
          {metadata.description || 'No description provided'}
        </Text>
        {metadata.url && <Text style={styles.dappUrl}>{metadata.url}</Text>}
      </View>
    );
  };

  const renderPermissions = () => {
    if (isV1) {
      // v1 has simpler permissions - just show algo_signTxn
      return (
        <View style={styles.permissionsContainer}>
          <Text style={styles.sectionTitle}>
            Requested Permissions and Networks
          </Text>
          <View style={styles.permissionItem}>
            <Ionicons name="link" size={16} color={theme.colors.textMuted} />
            <Text style={styles.permissionText}>Networks: Voi Network</Text>
          </View>
          <View style={styles.permissionItem}>
            <Ionicons
              name="construct"
              size={16}
              color={theme.colors.textMuted}
            />
            <Text style={styles.permissionText}>Methods: algo_signTxn</Text>
          </View>
        </View>
      );
    }

    // v2 permissions - collect all chains and methods across namespaces
    const allChains = new Set<string>();
    const allRequestedChains = new Set<string>(); // For debug logging
    const allMethods = new Set<string>();
    const supportedChainIds = [
      VOI_CHAIN_DATA.chainId,
      ALGORAND_MAINNET_CHAIN_DATA.chainId,
    ];

    // Collect from required namespaces
    if (proposal!.requiredNamespaces) {
      Object.values(proposal!.requiredNamespaces).forEach((namespace) => {
        if (namespace.chains) {
          namespace.chains.forEach((chain: string) => {
            allRequestedChains.add(chain); // Track all requested chains
            // Only add supported chains
            if (supportedChainIds.includes(chain)) {
              allChains.add(chain);
            }
          });
        }
        if (namespace.methods) {
          namespace.methods.forEach((method: string) => allMethods.add(method));
        }
      });
    }

    // Collect from optional namespaces
    if (proposal!.optionalNamespaces) {
      Object.values(proposal!.optionalNamespaces).forEach((namespace) => {
        if (namespace.chains) {
          namespace.chains.forEach((chain: string) => {
            allRequestedChains.add(chain); // Track all requested chains
            // Only add supported chains
            if (supportedChainIds.includes(chain)) {
              allChains.add(chain);
            }
          });
        }
        if (namespace.methods) {
          namespace.methods.forEach((method: string) => allMethods.add(method));
        }
      });
    }

    // Debug output
    console.log(
      '[WalletConnect] dApp requested chains:',
      Array.from(allRequestedChains)
    );
    console.log('[WalletConnect] Supported chains:', Array.from(allChains));
    console.log(
      '[WalletConnect] Required namespaces:',
      proposal!.requiredNamespaces
    );
    console.log(
      '[WalletConnect] Optional namespaces:',
      proposal!.optionalNamespaces
    );

    // Convert chain IDs to readable names (all chains in the set are already supported)
    const chainNames = Array.from(allChains).map((chainId) =>
      getNetworkNameByChainId(chainId)
    );
    const methods = Array.from(allMethods);

    return (
      <View style={styles.permissionsContainer}>
        <Text style={styles.sectionTitle}>
          Requested Permissions and Networks
        </Text>

        {chainNames.length > 0 && (
          <View style={styles.permissionItem}>
            <Ionicons name="link" size={16} color={theme.colors.textMuted} />
            <Text style={styles.permissionText}>
              Networks: {chainNames.join(', ')}
            </Text>
          </View>
        )}

        {methods.length > 0 && (
          <View style={styles.permissionItem}>
            <Ionicons
              name="construct"
              size={16}
              color={theme.colors.textMuted}
            />
            <Text style={styles.permissionText}>
              Methods: {methods.join(', ')}
            </Text>
          </View>
        )}
      </View>
    );
  };

  const handleToggleAccountSelection = (accountId: string) => {
    setSelectedAccountIds((prev) => {
      const newSelection = new Set(prev);
      if (newSelection.has(accountId)) {
        newSelection.delete(accountId);
      } else {
        newSelection.add(accountId);
      }
      return newSelection;
    });
  };

  const handleSelectAll = () => {
    if (selectedAccountIds.size === accounts.length) {
      // Deselect all
      setSelectedAccountIds(new Set());
    } else {
      // Select all
      setSelectedAccountIds(new Set(accounts.map((account) => account.id)));
    }
  };

  const renderAccounts = () => (
    <View style={styles.accountsContainer}>
      <View style={styles.accountsHeader}>
        <Text style={styles.sectionTitle}>Accounts to Connect</Text>
        <TouchableOpacity
          onPress={handleSelectAll}
          style={styles.selectAllButton}
        >
          <Text style={styles.selectAllText}>
            {selectedAccountIds.size === accounts.length
              ? 'Deselect All'
              : 'Select All'}
          </Text>
        </TouchableOpacity>
      </View>

      {selectedAccountIds.size === 0 && (
        <View style={styles.warningBanner}>
          <Ionicons name="warning" size={16} color={theme.colors.warning} />
          <Text style={styles.warningBannerText}>
            Please select at least one account to connect
          </Text>
        </View>
      )}

      {probing && (
        <ActivityIndicator accessibilityLabel="Checking signing authority" />
      )}
      {eligibility.some((entry) => entry.errorChains.length > 0) && (
        <View>
          <Text style={styles.permissionText}>
            {"Couldn't check signing authority for "}
            {
              eligibility.filter((entry) => entry.errorChains.length > 0).length
            }{' '}
            account(s)
          </Text>
          <TouchableOpacity
            onPress={() => {
              if (!inFlight.current) void loadAccounts();
            }}
            disabled={probing || isLoading}
          >
            <Text style={styles.selectAllText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
      {accounts.map((account) => (
        <View key={account.id}>
          <AccountSelectionItem
            account={account}
            isSelected={selectedAccountIds.has(account.id)}
            onToggleSelection={handleToggleAccountSelection}
          />
          {(() => {
            const chains =
              eligibility.find((entry) => entry.account.id === account.id)
                ?.eligibleChains ?? [];
            return (
              chains.length < approvedChains.length && (
                <Text style={styles.permissionText}>
                  Only on {chains.map(getNetworkNameByChainId).join(', ')}
                </Text>
              )
            );
          })()}
        </View>
      ))}
    </View>
  );

  if (!proposal && !v1SessionRequest) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <UniversalHeader
          title="WalletConnect"
          showBackButton
          onBackPress={() => navigation.goBack()}
        />
        <View style={[styles.scrollView, { justifyContent: 'center' }]}>
          <View style={{ alignItems: 'center' }}>
            <Ionicons name="warning" size={32} color={theme.colors.error} />
            <Text style={[styles.sectionTitle, { marginTop: 12 }]}>
              No proposal data
            </Text>
            <Text
              style={{ color: theme.colors.textMuted, textAlign: 'center' }}
            >
              Waiting for a WalletConnect session proposal...
            </Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Gate display: proposal metadata only (no account or network lookups).
  const gateMetadata = isV1
    ? v1SessionRequest?.peerMeta
    : proposal?.proposer.metadata;
  const gateNetworks = (() => {
    if (isV1) {
      const v1Chain = resolveV1Chain(v1SessionRequest?.chainId);
      return v1Chain ? getNetworkNameByChainId(v1Chain.chainId) : 'Unknown';
    }
    return (
      getProposalChains(
        proposal!,
        useExperimentalStore.getState().allowUnsupportedNetworks
      )
        .map(getNetworkNameByChainId)
        .join(', ') || 'Unknown'
    );
  })();

  return (
    <SafeAreaView
      onTouchStart={() => reviewGrant.touch()}
      style={styles.container}
      edges={['top', 'bottom']}
    >
      <UniversalHeader
        title="Connect to dApp"
        showBackButton
        onBackPress={() => navigation.goBack()}
      />

      {!canReview ? (
        <LockedRequestGate
          requestKey={requestKey}
          dapp={
            gateMetadata
              ? {
                  name: gateMetadata.name,
                  url: gateMetadata.url,
                  icon: gateMetadata.icons?.[0],
                }
              : undefined
          }
          network={gateNetworks}
          biometricEnabled={authState.biometricEnabled}
          onReject={handleReject}
        />
      ) : (
        <>
          <ScrollView
            style={styles.scrollView}
            showsVerticalScrollIndicator={false}
          >
            {renderDAppInfo()}
            {renderPermissions()}
            {renderAccounts()}

            <View style={styles.warningContainer}>
              <Ionicons name="warning" size={24} color={theme.colors.warning} />
              <Text style={styles.warningText}>
                Only connect to dApps you trust. Connected dApps will be able to
                view your account addresses and request transaction signatures.
              </Text>
            </View>
          </ScrollView>

          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={[styles.button, styles.rejectButton]}
              onPress={handleReject}
              disabled={isLoading}
            >
              <Text style={styles.rejectButtonText}>Reject</Text>
            </TouchableOpacity>

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Connect"
              style={[styles.button, styles.approveButton]}
              onPress={handleApprove}
              disabled={
                probing ||
                isLoading ||
                accounts.length === 0 ||
                selectedAccountIds.size === 0
              }
            >
              {isLoading || probing ? (
                <ActivityIndicator color={theme.colors.buttonText} />
              ) : (
                <Text style={styles.approveButtonText}>Connect</Text>
              )}
            </TouchableOpacity>
          </View>
        </>
      )}
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
      padding: 16,
    },
    dappContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 20,
      marginBottom: 16,
      alignItems: 'center',
      ...theme.shadows.sm,
    },
    dappIcon: {
      width: 64,
      height: 64,
      borderRadius: 12,
      marginBottom: 12,
    },
    dappName: {
      fontSize: 20,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 8,
      textAlign: 'center',
    },
    dappDescription: {
      fontSize: 14,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginBottom: 8,
      lineHeight: 20,
    },
    dappUrl: {
      fontSize: 12,
      color: theme.colors.primary,
      textAlign: 'center',
    },
    permissionsContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      ...theme.shadows.sm,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    namespaceContainer: {
      marginBottom: 12,
    },
    namespaceTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 8,
    },
    permissionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
    },
    permissionText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      marginLeft: 8,
      flex: 1,
    },
    accountsContainer: {
      backgroundColor: theme.colors.surface,
      borderRadius: 12,
      marginBottom: 16,
      ...theme.shadows.sm,
      overflow: 'hidden',
    },
    accountsHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 16,
      paddingBottom: 8,
    },
    selectAllButton: {
      paddingVertical: 4,
      paddingHorizontal: 8,
    },
    selectAllText: {
      fontSize: 14,
      color: theme.colors.primary,
      fontWeight: '600',
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.warning + '20',
      paddingHorizontal: 16,
      paddingVertical: 8,
      marginHorizontal: 16,
      marginBottom: 8,
      borderRadius: 8,
    },
    warningBannerText: {
      fontSize: 12,
      color: theme.colors.warning,
      marginLeft: 6,
      flex: 1,
    },
    warningContainer: {
      flexDirection: 'row',
      backgroundColor: theme.colors.warning + '20',
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
    },
    warningText: {
      flex: 1,
      fontSize: 14,
      color: theme.colors.warning,
      marginLeft: 12,
      lineHeight: 20,
    },
    buttonContainer: {
      flexDirection: 'row',
      padding: 16,
      paddingTop: 8,
      backgroundColor: theme.colors.surface,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    button: {
      flex: 1,
      height: 48,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
      marginHorizontal: 8,
    },
    rejectButton: {
      backgroundColor: theme.colors.surfaceVariant,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    rejectButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.textMuted,
    },
    approveButton: {
      backgroundColor: theme.colors.primary,
    },
    approveButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
  });
