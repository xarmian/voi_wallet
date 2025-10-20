import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { SettingsStackParamList } from '@/navigation/AppNavigator';
import { useWalletStore } from '@/store/walletStore';
import {
  AccountMetadata,
  AccountType,
  StandardAccountMetadata,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  LedgerSigningInfo,
} from '@/types/wallet';
import { TransactionService } from '@/services/transactions';
import { MultiAccountWalletService } from '@/services/wallet';
import rekeyManager from '@/services/wallet/rekeyManager';
import { formatAddress } from '@/utils/address';
import UniversalHeader from '@/components/common/UniversalHeader';
import AccountAvatar from '@/components/account/AccountAvatar';
import UnifiedTransactionAuthModal from '@/components/UnifiedTransactionAuthModal';
import {
  useTransactionAuthController,
} from '@/services/auth/transactionAuthController';
import {
  UnifiedTransactionRequest,
} from '@/services/transactions/unifiedSigner';
import RekeyToLedger from '@/components/ledger/RekeyToLedger';
import { useTheme } from '@/contexts/ThemeContext';
import { NetworkId } from '@/types/network';
import { getNetworkConfig, NETWORK_CONFIGURATIONS } from '@/services/network/config';
import { NetworkService, RekeyInfo } from '@/services/network';

type RekeyAccountScreenRouteProp = RouteProp<
  SettingsStackParamList,
  'RekeyAccount'
>;
type RekeyAccountScreenNavigationProp = StackNavigationProp<
  SettingsStackParamList,
  'RekeyAccount'
>;

interface RekeyAccountParams {
  accountId: string;
}

type RekeyFlow = 'standard' | 'ledger' | 'reverse';

export default function RekeyAccountScreen() {
  const route = useRoute<RekeyAccountScreenRouteProp>();
  const navigation = useNavigation<RekeyAccountScreenNavigationProp>();
  const params = route.params as RekeyAccountParams;
  const { theme } = useTheme();

  const wallet = useWalletStore((state) => state.wallet);
  const loadAccountBalance = useWalletStore(
    (state) => state.loadAccountBalance
  );
  const [selectedNetworkId, setSelectedNetworkId] = useState<NetworkId>('voi-mainnet');
  const [rekeyFlow, setRekeyFlow] = useState<RekeyFlow>('standard');
  const [selectedStandardAccount, setSelectedStandardAccount] =
    useState<StandardAccountMetadata | null>(null);
  const [selectedLedgerAccount, setSelectedLedgerAccount] =
    useState<LedgerAccountMetadata | null>(null);
  const [isLedgerReady, setIsLedgerReady] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [currentRequest, setCurrentRequest] = useState<UnifiedTransactionRequest | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [networkRekeyInfo, setNetworkRekeyInfo] = useState<any>(null);
  const [loadingRekeyInfo, setLoadingRekeyInfo] = useState(false);

  // Use the unified auth controller
  const authController = useTransactionAuthController();

  const sourceAccount = wallet?.accounts.find(
    (acc) => acc.id === params.accountId
  );
  const standardAccounts = wallet?.accounts.filter(
    (acc) => acc.type === AccountType.STANDARD && acc.id !== params.accountId
  ) as StandardAccountMetadata[];
  const ledgerAccounts = (wallet?.accounts.filter(
    (acc) => acc.type === AccountType.LEDGER
  ) ?? []) as LedgerAccountMetadata[];

  // Check if source account is rekeyed on the selected network
  const isSourceRekeyed = networkRekeyInfo?.isRekeyed === true;
  const networkAuthAddress = networkRekeyInfo?.authAddress;

  // For reverse rekey, we need:
  // 1. The auth address (current controller) in our wallet to sign the rekey transaction
  // 2. The source account itself in our wallet to ensure we can control it after reverting
  const authSignerAccount = isSourceRekeyed && networkAuthAddress ?
    wallet?.accounts.find(
      (acc) => acc.address.toUpperCase() === networkAuthAddress.toUpperCase() &&
      (acc.type === AccountType.STANDARD || acc.type === AccountType.LEDGER)
    ) : undefined;

  // Check if we have the source account in our wallet (to maintain control after rekey)
  const hasSourceAccount = !!sourceAccount;

  // We can reverse rekey if we have both the auth signer AND the source account
  const canReverseRekey = !!authSignerAccount && hasSourceAccount;

  const matchingLedgerSigner = authSignerAccount?.type === AccountType.LEDGER
    ? (authSignerAccount as LedgerAccountMetadata)
    : undefined;

  const isReverseFlow = rekeyFlow === 'reverse';
  const isLedgerFlow = rekeyFlow === 'ledger';
  const hasTargetSelection =
    rekeyFlow === 'standard'
      ? !!selectedStandardAccount
      : rekeyFlow === 'ledger'
      ? !!selectedLedgerAccount
      : true;
  const isProceedDisabled =
    (rekeyFlow !== 'reverse' && !hasTargetSelection) ||
    validationErrors.length > 0 ||
    isValidating;
  const proceedLabel = isReverseFlow
    ? 'Remove Rekey'
    : isLedgerFlow
    ? 'Rekey to Ledger'
    : 'Rekey Account';

  useEffect(() => {
    return () => {
      authController.cleanup();
    };
  }, [authController]);

  // Fetch network-specific rekey info when network or source account changes
  useEffect(() => {
    if (!sourceAccount) {
      return;
    }

    let isCancelled = false;

    const fetchRekeyInfo = async () => {
      setLoadingRekeyInfo(true);
      try {
        const networkService = NetworkService.getInstance(selectedNetworkId);
        const rekeyInfo = await networkService.getAccountRekeyInfo(
          sourceAccount.address
        );

        if (!isCancelled) {
          setNetworkRekeyInfo(rekeyInfo);

          // If we're in reverse flow but the account is not rekeyed on this network,
          // reset to standard flow
          if (rekeyFlow === 'reverse' && !rekeyInfo.isRekeyed) {
            setRekeyFlow('standard');
          }
        }
      } catch (error) {
        console.error('Failed to fetch rekey info:', error);
        if (!isCancelled) {
          setNetworkRekeyInfo(null);
          // Reset to standard flow on error
          if (rekeyFlow === 'reverse') {
            setRekeyFlow('standard');
          }
        }
      } finally {
        if (!isCancelled) {
          setLoadingRekeyInfo(false);
        }
      }
    };

    fetchRekeyInfo();

    return () => {
      isCancelled = true;
    };
  }, [sourceAccount, selectedNetworkId, rekeyFlow]);

  useEffect(() => {
    if (!sourceAccount || !wallet) {
      return;
    }

    // For reverse rekey, we validate by rekeying back to self
    let targetAddress: string;
    if (rekeyFlow === 'reverse') {
      targetAddress = sourceAccount.address; // Rekey back to self
    } else {
      const targetAccount =
        rekeyFlow === 'ledger' ? selectedLedgerAccount : selectedStandardAccount;
      if (!targetAccount) {
        setValidationErrors([]);
        return;
      }
      targetAddress = targetAccount.address;
    }

    let isCancelled = false;

    const runValidation = async () => {
      setIsValidating(true);
      try {
        const errors = await TransactionService.validateRekeyTransaction(
          sourceAccount.address,
          targetAddress,
          wallet,
          selectedNetworkId
        );
        if (!isCancelled) {
          setValidationErrors(errors);
        }
      } catch (error) {
        console.error('Validation failed:', error);
        if (!isCancelled) {
          setValidationErrors(['Failed to validate rekey transaction']);
        }
      } finally {
        if (!isCancelled) {
          setIsValidating(false);
        }
      }
    };

    runValidation();

    return () => {
      isCancelled = true;
    };
  }, [
    rekeyFlow,
    selectedLedgerAccount,
    selectedStandardAccount,
    sourceAccount,
    wallet,
    isLedgerReady,
    selectedNetworkId,
  ]);

  useEffect(() => {
    if (
      rekeyFlow === 'ledger' &&
      !selectedLedgerAccount &&
      ledgerAccounts.length === 1
    ) {
      setSelectedLedgerAccount(ledgerAccounts[0]);
    }
  }, [ledgerAccounts, rekeyFlow, selectedLedgerAccount]);

  const handleStandardAccountSelect = (account: StandardAccountMetadata) => {
    setSelectedStandardAccount(account);
  };

  const handleLedgerAccountSelect = (account: LedgerAccountMetadata | null) => {
    setSelectedLedgerAccount(account);
  };

  const handleLedgerStatusUpdate = useCallback(
    ({ isReady }: { info: LedgerSigningInfo | null; isReady: boolean }) => {
      setIsLedgerReady((previous) => (previous === isReady ? previous : isReady));
    },
    []
  );

  const handleProceed = () => {
    if (!sourceAccount) {
      return;
    }

    if (rekeyFlow !== 'reverse' && validationErrors.length > 0) {
      Alert.alert('Validation Errors', validationErrors.join('\n'));
      return;
    }

    if (rekeyFlow === 'reverse') {
      Alert.alert(
        'Confirm Reverse Rekey',
        `Are you sure you want to remove the rekey from this account?\n\nThis will return signing authority back to:\n${formatAddress(sourceAccount.address)}\n\nYou will regain full control of this account.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove Rekey',
            style: 'destructive',
            onPress: () => handleStartRekey(),
          },
        ]
      );
      return;
    }

    const targetAccount =
      rekeyFlow === 'ledger' ? selectedLedgerAccount : selectedStandardAccount;

    if (!targetAccount) {
      Alert.alert(
        'Select Account',
        rekeyFlow === 'ledger'
          ? 'Select a Ledger account to continue.'
          : 'Select a signing account to continue.'
      );
      return;
    }

    const ledgerNotice =
      rekeyFlow === 'ledger'
        ? '\n\nAfter rekeying, future transactions must be approved with your Ledger device.'
        : '\n\nThis action can be reversed later.';

    Alert.alert(
      'Confirm Rekey Operation',
      `Are you sure you want to rekey this account?\n\nThis will transfer signing authority from:\n${formatAddress(
        sourceAccount.address
      )}\n\nTo:\n${formatAddress(targetAccount.address)}${ledgerNotice}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => handleStartRekey(),
        },
      ]
    );
  };

  const handleReverseRekey = () => {
    const errors: string[] = [];

    if (!isSourceRekeyed) {
      errors.push('Account is not currently rekeyed');
    }

    if (!canReverseRekey && !matchingLedgerSigner) {
      errors.push('You do not have signing authority for this rekeyed account');
    }

    if (errors.length > 0) {
      Alert.alert('Cannot Remove Rekey', errors.join('\n'));
      return;
    }

    setRekeyFlow('reverse');
    setValidationErrors([]);
  };

  const handleStandardRekey = () => {
    setRekeyFlow('standard');
    setValidationErrors([]);
  };

  const handleLedgerRekey = () => {
    setRekeyFlow('ledger');
    setValidationErrors([]);
  };

  const applyLedgerMetadataUpdate = useCallback(
    async (account: AccountMetadata, ledgerAccount: LedgerAccountMetadata) => {
      if (!wallet) {
        return;
      }

      try {
        const updatedAccount = await rekeyManager.rekeyToLedger(
          account,
          ledgerAccount,
          wallet
        );

        await MultiAccountWalletService.updateAccountMetadata(updatedAccount);

        const currentState = useWalletStore.getState();
        if (currentState.wallet) {
          useWalletStore.setState({
            wallet: {
              ...currentState.wallet,
              accounts: currentState.wallet.accounts.map((candidate) =>
                candidate.id === updatedAccount.id ? updatedAccount : candidate
              ),
            },
          });
        }
      } catch (metadataError) {
        console.warn('Failed to update Ledger rekey metadata immediately:', metadataError);
      }
    },
    [wallet]
  );

  const handleStartRekey = () => {
    if (!sourceAccount) {
      return;
    }

    const targetAccount =
      rekeyFlow === 'ledger' ? selectedLedgerAccount : selectedStandardAccount;

    // Create unified transaction request
    const request: UnifiedTransactionRequest = {
      type: rekeyFlow === 'reverse' ? 'rekey_reverse' : 'rekey',
      account: sourceAccount,
      networkId: selectedNetworkId,
      rekeyParams: {
        fromAddress: sourceAccount.address,
        rekeyToAddress: rekeyFlow === 'reverse' ? undefined : targetAccount?.address,
        note: rekeyFlow === 'reverse'
          ? 'Remove rekey - return to self'
          : `Rekey to ${targetAccount?.label || 'account'}`,
        networkId: selectedNetworkId,
      },
    };

    setCurrentRequest(request);
    setShowAuthModal(true);
  };

  const handleAuthComplete = async (success: boolean, result?: any) => {
    setShowAuthModal(false);
    setCurrentRequest(null);

    if (success && result?.transactionId) {
      // Apply Ledger metadata update if needed
      if (rekeyFlow === 'ledger' && selectedLedgerAccount && sourceAccount) {
        try {
          await applyLedgerMetadataUpdate(sourceAccount, selectedLedgerAccount);
        } catch (metadataError) {
          console.warn('Failed to update Ledger rekey metadata:', metadataError);
        }
      }

      // Refresh account data
      if (sourceAccount) {
        setTimeout(async () => {
          try {
            await loadAccountBalance(sourceAccount.id, true); // Force refresh after rekey
          } catch (refreshError) {
            console.warn('Failed to refresh account data:', refreshError);
          }
        }, 3000);
      }

      const title =
        rekeyFlow === 'reverse'
          ? 'Rekey Removed'
          : rekeyFlow === 'ledger'
          ? 'Ledger Rekey Successful'
          : 'Rekey Successful';

      const message =
        rekeyFlow === 'reverse'
          ? `Account rekey has been removed successfully!\n\nYou now have full control of this account again.\n\nTransaction ID: ${result.transactionId.slice(0, 8)}...`
          : rekeyFlow === 'ledger'
          ? `Account has been rekeyed to your Ledger device successfully!\n\nTransaction ID: ${result.transactionId.slice(0, 8)}...`
          : `Account has been rekeyed successfully!\n\nTransaction ID: ${result.transactionId.slice(0, 8)}...`;

      Alert.alert(title, message, [
        {
          text: 'OK',
          onPress: () => navigation.goBack(),
        },
      ]);
    } else {
      // Handle error
      let errorMessage =
        result instanceof Error ? result.message : 'Unknown error occurred';

      if (rekeyFlow === 'reverse') {
        if (errorMessage.includes('auth')) {
          errorMessage +=
            '\n\nTip: Make sure you have signing authority for this account.';
        } else if (errorMessage.includes('insufficient funds')) {
          errorMessage +=
            '\n\nTip: You need a small amount of VOI to pay for the transaction fee.';
        }
      }

      Alert.alert(
        rekeyFlow === 'reverse' ? 'Remove Rekey Failed' : 'Rekey Failed',
        errorMessage
      );
    }
  };

  const handleAuthCancel = () => {
    setShowAuthModal(false);
    authController.resetAfterDismiss();
    setCurrentRequest(null);
  };

  if (!sourceAccount) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        edges={['top']}
      >
        <Text style={[styles.errorText, { color: theme.colors.error }]}>
          Account not found
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top']}
    >
      <UniversalHeader
        title="Rekey Account"
        subtitle={
          isReverseFlow
            ? 'Remove rekey and return control to account'
            : isLedgerFlow
            ? 'Transfer signing authority to a Ledger account'
            : 'Transfer signing authority to another account'
        }
        showBackButton
        onBackPress={() => navigation.goBack()}
        showAccountSelector={false}
        onAccountSelectorPress={() => {}}
      />

      <ScrollView
        style={[styles.content, { backgroundColor: theme.colors.background }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Source Account */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            Account to {isReverseFlow ? 'Remove Rekey From' : 'Rekey'}
          </Text>
          <View
            style={[
              styles.accountCard,
              {
                backgroundColor: theme.colors.card,
                borderColor: theme.colors.border,
              },
            ]}
          >
            <AccountAvatar address={sourceAccount.address} size={40} />
            <View style={styles.accountInfo}>
              <Text style={[styles.accountName, { color: theme.colors.text }]}>
                {sourceAccount.label || 'Account'}
              </Text>
              <Text
                style={[
                  styles.accountAddress,
                  { color: theme.colors.textSecondary },
                ]}
              >
                {formatAddress(sourceAccount.address)}
              </Text>
              {loadingRekeyInfo ? (
                <View style={styles.rekeyStatusContainer}>
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                  <Text
                    style={[
                      styles.rekeyStatusText,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    Checking rekey status...
                  </Text>
                </View>
              ) : isSourceRekeyed && networkAuthAddress ? (
                <View style={styles.rekeyStatusContainer}>
                  <Ionicons
                    name={canReverseRekey ? 'key' : 'lock-closed'}
                    size={14}
                    color={canReverseRekey ? '#10B981' : '#F59E0B'}
                  />
                  <Text
                    style={[
                      styles.rekeyStatusText,
                      { color: theme.colors.textSecondary },
                    ]}
                  >
                    Currently rekeyed to:{' '}
                    {formatAddress(networkAuthAddress)}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>

        {/* Network Selector */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            Network
          </Text>
          <Text
            style={[
              styles.sectionSubtitle,
              { color: theme.colors.textSecondary },
            ]}
          >
            Select the network where the rekey operation will be performed
          </Text>
          <View style={styles.networkSelectorContainer}>
            {Object.values(NETWORK_CONFIGURATIONS).map((config) => (
              <TouchableOpacity
                key={config.id}
                style={[
                  styles.networkOption,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                  },
                  selectedNetworkId === config.id && {
                    borderColor: theme.colors.primary,
                    backgroundColor: theme.colors.primaryLight,
                  },
                ]}
                onPress={() => {
                  setSelectedNetworkId(config.id);
                  // Reset validation when network changes
                  setValidationErrors([]);
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
                    { color: theme.colors.text },
                    selectedNetworkId === config.id && {
                      color: theme.colors.primary,
                      fontWeight: '600',
                    },
                  ]}
                >
                  {config.name}
                </Text>
                {selectedNetworkId === config.id && (
                  <Ionicons
                    name="checkmark-circle"
                    size={20}
                    color={theme.colors.primary}
                  />
                )}
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Rekey Method Selection */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            Rekey Method
          </Text>
          <View style={styles.rekeyTypeContainer}>
            <TouchableOpacity
              style={[
                styles.rekeyTypeOption,
                {
                  backgroundColor: theme.colors.card,
                  borderColor: theme.colors.border,
                },
                rekeyFlow === 'standard' && {
                  borderColor: theme.colors.primary,
                  backgroundColor: theme.colors.primaryLight,
                },
              ]}
              onPress={handleStandardRekey}
            >
              <Ionicons
                name="swap-horizontal"
                size={20}
                color={
                  rekeyFlow === 'standard' ? theme.colors.primary : '#6B7280'
                }
              />
              <Text
                style={[
                  styles.rekeyTypeText,
                  {
                    color:
                      rekeyFlow === 'standard'
                        ? theme.colors.primary
                        : theme.colors.textSecondary,
                  },
                ]}
              >
                Rekey to Wallet Account
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.rekeyTypeOption,
                {
                  backgroundColor: theme.colors.card,
                  borderColor: theme.colors.border,
                },
                rekeyFlow === 'ledger' && {
                  borderColor: theme.colors.primary,
                  backgroundColor: theme.colors.primaryLight,
                },
              ]}
              onPress={handleLedgerRekey}
            >
              <Ionicons
                name="hardware-chip-outline"
                size={20}
                color={
                  rekeyFlow === 'ledger' ? theme.colors.primary : '#6B7280'
                }
              />
              <Text
                style={[
                  styles.rekeyTypeText,
                  {
                    color:
                      rekeyFlow === 'ledger'
                        ? theme.colors.primary
                        : theme.colors.textSecondary,
                  },
                ]}
              >
                Rekey to Ledger Device
              </Text>
            </TouchableOpacity>

            {isSourceRekeyed ? (
              <TouchableOpacity
                style={[
                  styles.rekeyTypeOption,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                  },
                  rekeyFlow === 'reverse' && {
                    borderColor: theme.colors.primary,
                    backgroundColor: theme.colors.primaryLight,
                  },
                ]}
                onPress={handleReverseRekey}
              >
                <Ionicons
                  name="return-up-back"
                  size={20}
                  color={
                    rekeyFlow === 'reverse'
                      ? theme.colors.primary
                      : '#6B7280'
                  }
                />
                <Text
                  style={[
                    styles.rekeyTypeText,
                    {
                      color:
                        rekeyFlow === 'reverse'
                          ? theme.colors.primary
                          : theme.colors.textSecondary,
                    },
                  ]}
                >
                  Remove Rekey (Return to Self)
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>

        {rekeyFlow === 'standard' && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
              Select New Signing Account
            </Text>
            <Text
              style={[
                styles.sectionSubtitle,
                { color: theme.colors.textSecondary },
              ]}
            >
              Choose which account in your wallet will have signing authority
            </Text>

            {standardAccounts.length === 0 ? (
              <View
                style={[
                  styles.noAccountsContainer,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                  },
                ]}
              >
                <Ionicons
                  name="warning"
                  size={48}
                  color={theme.colors.warning}
                />
                <Text
                  style={[
                    styles.noAccountsText,
                    { color: theme.colors.textSecondary },
                  ]}
                >
                  No other standard accounts available for rekeying
                </Text>
              </View>
            ) : (
              standardAccounts.map((account) => (
                <TouchableOpacity
                  key={account.id}
                  style={[
                    styles.targetAccountCard,
                    {
                      backgroundColor: theme.colors.card,
                      borderColor: theme.colors.border,
                    },
                    selectedStandardAccount?.id === account.id && {
                      borderColor: theme.colors.success,
                      backgroundColor: theme.colors.successLight,
                    },
                  ]}
                  onPress={() => handleStandardAccountSelect(account)}
                >
                  <AccountAvatar address={account.address} size={36} />
                  <View style={styles.accountInfo}>
                    <Text
                      style={[
                        styles.targetAccountName,
                        { color: theme.colors.text },
                      ]}
                    >
                      {account.label || 'Account'}
                    </Text>
                    <Text
                      style={[
                        styles.targetAccountAddress,
                        { color: theme.colors.textSecondary },
                      ]}
                    >
                      {formatAddress(account.address)}
                    </Text>
                  </View>
                  {selectedStandardAccount?.id === account.id && (
                    <Ionicons
                      name="checkmark-circle"
                      size={24}
                      color="#10B981"
                    />
                  )}
                </TouchableOpacity>
              ))
            )}
          </View>
        )}

        {rekeyFlow === 'ledger' && (
          <View style={styles.section}>
            <RekeyToLedger
              ledgerAccounts={ledgerAccounts}
              selectedAccountId={selectedLedgerAccount?.id ?? null}
              onSelectAccount={handleLedgerAccountSelect}
              onStatusUpdate={handleLedgerStatusUpdate}
              onImportLedgerAccounts={() =>
                navigation.getParent()?.navigate(
                  'LedgerAccountImport' as never
                )
              }
              isBusy={isProcessing}
            />
          </View>
        )}

        {/* Reverse Rekey Explanation */}
        {isReverseFlow && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
              Remove Rekey
            </Text>
            <View
              style={[
                styles.reverseRekeyInfo,
                { backgroundColor: theme.colors.infoLight },
              ]}
            >
              <Ionicons
                name="information-circle"
                size={20}
                color={theme.colors.info}
              />
              <Text
                style={[
                  styles.reverseRekeyInfoText,
                  { color: theme.colors.info },
                ]}
              >
                This will remove the current rekey and return full signing
                authority back to the account itself. You will regain complete
                control without needing another account to sign transactions.
              </Text>
            </View>
          </View>
        )}

        {/* Validation Results */}
        {hasTargetSelection && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
              Validation
            </Text>
            {isValidating ? (
              <View
                style={[
                  styles.validationLoading,
                  { backgroundColor: theme.colors.infoLight },
                ]}
              >
                <ActivityIndicator size="small" color={theme.colors.primary} />
                <Text
                  style={[
                    styles.validationText,
                    { color: theme.colors.primary },
                  ]}
                >
                  Validating rekey transaction...
                </Text>
              </View>
            ) : validationErrors.length > 0 ? (
              <View
                style={[
                  styles.validationErrors,
                  {
                    backgroundColor: theme.colors.errorLight,
                    borderColor: theme.colors.error,
                  },
                ]}
              >
                {validationErrors.map((error, index) => (
                  <View key={index} style={styles.errorRow}>
                    <Ionicons
                      name="close-circle"
                      size={16}
                      color={theme.colors.error}
                    />
                    <Text
                      style={[styles.errorText, { color: theme.colors.error }]}
                    >
                      {error}
                    </Text>
                  </View>
                ))}
              </View>
            ) : (
              <View
                style={[
                  styles.validationSuccess,
                  { backgroundColor: theme.colors.successLight },
                ]}
              >
                <Ionicons
                  name="checkmark-circle"
                  size={16}
                  color={theme.colors.success}
                />
                <Text
                  style={[styles.successText, { color: theme.colors.success }]}
                >
                  {isReverseFlow
                    ? 'Ready to remove rekey'
                    : isLedgerFlow
                    ? 'Ledger device ready for rekey'
                    : 'Ready to proceed with rekey'}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Warning Section */}
        <View
          style={[
            styles.warningSection,
            {
              backgroundColor: theme.colors.warningLight,
              borderColor: theme.colors.warning,
            },
          ]}
        >
          <View style={styles.warningHeader}>
            <Ionicons name="warning" size={20} color={theme.colors.warning} />
            <Text
              style={[styles.warningTitle, { color: theme.colors.warning }]}
            >
              Important Notes
            </Text>
          </View>
          <Text style={[styles.warningText, { color: theme.colors.warning }]}>
            {isReverseFlow
              ? '• This will remove the current rekey and return control to the original account\n• You will regain full signing authority\n• The account address will remain the same\n• This action can be undone by rekeying again later'
              : isLedgerFlow
              ? '• This will transfer signing authority to your Ledger device\n• Keep the Ledger account available to sign future transactions\n• The account address remains the same\n• You can rekey back to a wallet account later if needed'
              : '• This will transfer signing authority to the selected account\n• The account address will remain the same\n• You can reverse this operation later if needed\n• Both accounts must remain in your wallet for full functionality'}
          </Text>
        </View>
      </ScrollView>

      {/* Action Buttons */}
      <View
        style={[
          styles.buttonContainer,
          { backgroundColor: theme.colors.background },
        ]}
      >
        <TouchableOpacity
          style={[
            styles.cancelButton,
            {
              backgroundColor: theme.colors.card,
              borderColor: theme.colors.border,
            },
          ]}
          onPress={() => navigation.goBack()}
        >
          <Text
            style={[
              styles.cancelButtonText,
              { color: theme.colors.textSecondary },
            ]}
          >
            Cancel
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.proceedButton,
            { backgroundColor: theme.colors.error },
            isProceedDisabled && { backgroundColor: theme.colors.disabled },
          ]}
          onPress={handleProceed}
          disabled={isProceedDisabled}
        >
          <Text
            style={[
              styles.proceedButtonText,
              { color: theme.colors.background },
            ]}
          >
            {proceedLabel}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Auth Modal */}
      <UnifiedTransactionAuthModal
        visible={showAuthModal}
        controller={authController}
        request={currentRequest}
        onComplete={handleAuthComplete}
        onCancel={handleAuthCancel}
        title="Confirm Rekey"
        message="Authenticate to confirm the rekey transaction"
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  sectionSubtitle: {
    fontSize: 14,
    marginBottom: 16,
  },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  accountInfo: {
    flex: 1,
    marginLeft: 12,
  },
  accountName: {
    fontSize: 16,
    fontWeight: '500',
  },
  accountAddress: {
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  targetAccountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    marginBottom: 8,
  },
  targetAccountName: {
    fontSize: 15,
    fontWeight: '500',
  },
  targetAccountAddress: {
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  noAccountsContainer: {
    alignItems: 'center',
    padding: 32,
    borderRadius: 12,
    borderWidth: 1,
  },
  noAccountsText: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 12,
  },
  validationLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 8,
  },
  validationText: {
    fontSize: 14,
    marginLeft: 8,
  },
  validationErrors: {
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  errorText: {
    fontSize: 14,
    marginLeft: 8,
    flex: 1,
  },
  validationSuccess: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 8,
  },
  successText: {
    fontSize: 14,
    marginLeft: 8,
  },
  warningSection: {
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  warningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  warningTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  warningText: {
    fontSize: 14,
    lineHeight: 20,
  },
  buttonContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
  },
  proceedButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  proceedButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  rekeyStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  rekeyStatusText: {
    fontSize: 12,
    marginLeft: 6,
    fontFamily: 'monospace',
  },
  rekeyTypeContainer: {
    gap: 12,
  },
  rekeyTypeOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
  },
  rekeyTypeText: {
    fontSize: 15,
    fontWeight: '500',
    marginLeft: 12,
  },
  reverseRekeyInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    borderRadius: 8,
  },
  reverseRekeyInfoText: {
    fontSize: 14,
    marginLeft: 12,
    flex: 1,
    lineHeight: 20,
  },
  networkSelectorContainer: {
    flexDirection: 'row',
    gap: 12,
  },
  networkOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    gap: 8,
  },
  networkDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  networkOptionText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
  },
});
