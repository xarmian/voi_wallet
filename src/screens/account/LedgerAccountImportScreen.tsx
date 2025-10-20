import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { RootStackParamList } from '@/navigation/AppNavigator';
import LedgerConnectionModal from '@/components/ledger/ConnectionModal';
import LedgerAccountImport from '@/components/ledger/AccountImport';
import LedgerAccountPreview from '@/components/ledger/AccountPreview';
import {
  LedgerDeviceInfo,
  ledgerTransportService,
} from '@/services/ledger/transport';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  AccountType,
  ImportLedgerAccountRequest,
  LedgerAccountDiscoveryResult,
} from '@/types/wallet';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  ledgerAlgorandService,
  LedgerAccountDerivation,
} from '@/services/ledger/algorand';
import { useWalletStore } from '@/store/walletStore';
import AuthAccountDiscovery from '@/components/auth-account/AuthAccountDiscovery';
import { AccountSecureStorage } from '@/services/secure';

type ImportState = {
  accounts: LedgerAccountDiscoveryResult[];
  selectedIndexes: Set<number>;
  previewAccount?: LedgerAccountDiscoveryResult;
  isScanning: boolean;
  isImporting: boolean;
  isVerifying: boolean;
  startIndex: number;
  count: number;
  statusMessage: string;
};

type ImportAction =
  | {
      type: 'setAccounts';
      accounts: LedgerAccountDiscoveryResult[];
      selectedIndexes: Set<number>;
      previewAccount?: LedgerAccountDiscoveryResult;
    }
  | { type: 'toggleIndex'; account: LedgerAccountDiscoveryResult }
  | { type: 'setStatus'; message: string }
  | { type: 'setScanning'; value: boolean }
  | { type: 'setImporting'; value: boolean }
  | { type: 'setVerifying'; value: boolean }
  | { type: 'setStartIndex'; value: number }
  | { type: 'setCount'; value: number }
  | { type: 'setPreview'; account?: LedgerAccountDiscoveryResult };

const INITIAL_IMPORT_STATE: ImportState = {
  accounts: [],
  selectedIndexes: new Set<number>(),
  previewAccount: undefined,
  isScanning: false,
  isImporting: false,
  isVerifying: false,
  startIndex: 0,
  count: 5,
  statusMessage: '',
};

function importReducer(state: ImportState, action: ImportAction): ImportState {
  switch (action.type) {
    case 'setAccounts':
      return {
        ...state,
        accounts: action.accounts,
        selectedIndexes: new Set(action.selectedIndexes),
        previewAccount: action.previewAccount,
      };
    case 'toggleIndex': {
      const next = new Set(state.selectedIndexes);
      const index = action.account.derivationIndex;
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return {
        ...state,
        selectedIndexes: next,
        previewAccount: action.account,
      };
    }
    case 'setStatus':
      return {
        ...state,
        statusMessage: action.message,
      };
    case 'setScanning':
      return {
        ...state,
        isScanning: action.value,
      };
    case 'setImporting':
      return {
        ...state,
        isImporting: action.value,
      };
    case 'setVerifying':
      return {
        ...state,
        isVerifying: action.value,
      };
    case 'setStartIndex':
      return {
        ...state,
        startIndex: Math.max(0, action.value),
      };
    case 'setCount':
      return {
        ...state,
        count: Math.max(1, action.value),
      };
    case 'setPreview':
      return {
        ...state,
        previewAccount: action.account,
      };
    default:
      return state;
  }
}

type NavigationProp = StackNavigationProp<
  RootStackParamList,
  'LedgerAccountImport'
>;
type RoutePropType = RouteProp<RootStackParamList, 'LedgerAccountImport'>;

interface Props {
  navigation: NavigationProp;
  route: RoutePropType;
}

const LedgerAccountImportScreen: React.FC<Props> = ({ navigation, route }) => {
  const { theme } = useTheme();
  const colors = useThemeColors();
  const styles = useThemedStyles(createStyles);
  const refreshWallet = useWalletStore((state) => state.refresh);
  const isOnboarding = route.params?.isOnboarding ?? false;

  const [connectionModalVisible, setConnectionModalVisible] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<LedgerDeviceInfo | null>(
    () => {
      const fromRoute = route.params?.deviceId
        ? (ledgerTransportService
            .getDevices()
            .find((device) => device.id === route.params?.deviceId) ?? null)
        : null;
      return fromRoute || ledgerTransportService.getConnectedDevice() || null;
    }
  );
  const [importState, dispatch] = useReducer(importReducer, INITIAL_IMPORT_STATE);
  const [showAuthDiscovery, setShowAuthDiscovery] = useState(false);
  const [importedLedgerAccounts, setImportedLedgerAccounts] = useState<LedgerAccountDiscoveryResult[]>([]);
  const [accountLabels, setAccountLabels] = useState<Record<number, string>>({});

  const {
    accounts,
    selectedIndexes,
    previewAccount,
    isScanning,
    isImporting,
    isVerifying,
    startIndex,
    count,
    statusMessage,
  } = importState;

  useEffect(() => {
    navigation.setOptions({ headerShown: false });
  }, [navigation]);

  useEffect(() => {
    setAccountLabels((prev) => {
      const next: Record<number, string> = {};
      accounts.forEach((account) => {
        const existing = prev[account.derivationIndex];
        next[account.derivationIndex] =
          existing !== undefined
            ? existing
            : account.accountLabel ?? '';
      });
      return next;
    });
  }, [accounts]);

  const ensureDeviceConnected = useCallback(() => {
    const connected = ledgerTransportService.getConnectedDevice();
    if (connected && (!selectedDevice || connected.id !== selectedDevice.id)) {
      setSelectedDevice(connected);
      return connected;
    }
    return selectedDevice;
  }, [selectedDevice]);

  useEffect(() => {
    if (selectedDevice) {
      ensureDeviceConnected();
    }
  }, [ensureDeviceConnected, selectedDevice]);

  const handleDeviceConnected = useCallback(
    (device: LedgerDeviceInfo) => {
      setSelectedDevice(device);
      setConnectionModalVisible(false);
      dispatch({ type: 'setStatus', message: '' });
    },
    [dispatch]
  );

  const handleDeviceDisconnect = useCallback(() => {
    dispatch({ type: 'setStatus', message: 'Ledger device disconnected' });
  }, [dispatch]);

  const completeAfterImport = useCallback(async () => {
    if (!isOnboarding) {
      navigation.goBack();
      return;
    }

    try {
      const hasPin = await AccountSecureStorage.hasPin();
      if (!hasPin) {
        navigation.replace('SecuritySetup', { source: 'ledger' });
      } else {
        navigation.navigate('Main');
      }
    } catch (error) {
      console.error('Failed to finalize ledger onboarding:', error);
      navigation.replace('SecuritySetup', { source: 'ledger' });
    }
  }, [isOnboarding, navigation]);

  const handleScanAccounts = useCallback(async () => {
    const device = ensureDeviceConnected();
    if (!device) {
      setConnectionModalVisible(true);
      dispatch({ type: 'setStatus', message: 'Connect your Ledger device to continue' });
      return;
    }

    dispatch({ type: 'setScanning', value: true });
    dispatch({ type: 'setStatus', message: 'Scanning for Ledger accounts...' });

    try {
      const result = await MultiAccountWalletService.detectLedgerAccounts(
        device,
        {
          startIndex,
          count,
          displayFirst: true,
        }
      );

      const selectable = result.filter((item) => !item.existsInWallet);
      const nextSelected = new Set<number>();
      let preview: LedgerAccountDiscoveryResult | undefined;
      if (selectable.length > 0) {
        nextSelected.add(selectable[0].derivationIndex);
        preview = selectable[0];
      } else if (result.length > 0) {
        preview = result[0];
      }

      dispatch({
        type: 'setAccounts',
        accounts: result,
        selectedIndexes: nextSelected,
        previewAccount: preview,
      });
      dispatch({
        type: 'setStatus',
        message: `Found ${result.length} account${result.length === 1 ? '' : 's'} in this range.`,
      });
    } catch (error) {
      console.error('Failed to detect Ledger accounts:', error);
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to detect Ledger accounts';
      Alert.alert('Ledger Scan Failed', message);
      dispatch({ type: 'setStatus', message: '' });
    } finally {
      dispatch({ type: 'setScanning', value: false });
    }
  }, [count, ensureDeviceConnected, startIndex, dispatch]);

  useEffect(() => {
    if (selectedDevice && accounts.length === 0) {
      handleScanAccounts().catch(() => undefined);
    }
  }, [accounts.length, handleScanAccounts, selectedDevice]);

  const handleToggleAccount = useCallback(
    (account: LedgerAccountDiscoveryResult) => {
      if (account.existsInWallet) {
        Alert.alert(
          'Already Imported',
          'This account is already present in your wallet.'
        );
        return;
      }

      dispatch({ type: 'toggleIndex', account });
    },
    [dispatch]
  );

  const handleAccountLabelChange = useCallback((index: number, value: string) => {
    setAccountLabels((prev) => ({
      ...prev,
      [index]: value,
    }));
  }, []);

  const handleVerifyAddress = useCallback(
    async (account: LedgerAccountDiscoveryResult) => {
      const device = ensureDeviceConnected();
      if (!device) {
        setConnectionModalVisible(true);
        return;
      }

      dispatch({ type: 'setVerifying', value: true });
      try {
        await ledgerAlgorandService.deriveAccount(account.derivationIndex, {
          displayOnDevice: true,
        });
        Alert.alert(
          'Verify on Ledger',
          'Check your Ledger device to compare the displayed address.'
        );
      } catch (error) {
        console.error('Failed to verify address on Ledger:', error);
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to verify address on Ledger device.';
        Alert.alert('Verification Failed', message);
      } finally {
        dispatch({ type: 'setVerifying', value: false });
      }
    },
    [dispatch, ensureDeviceConnected]
  );

  const handleImportAccounts = useCallback(async () => {
    const device = ensureDeviceConnected();
    if (!device) {
      setConnectionModalVisible(true);
      return;
    }

    const toImport = accounts.filter(
      (account) =>
        selectedIndexes.has(account.derivationIndex) && !account.existsInWallet
    );

    // Store the accounts being imported for auth discovery
    setImportedLedgerAccounts(toImport);

    if (toImport.length === 0) {
      Alert.alert(
        'No Accounts Selected',
        'Select at least one Ledger account to import.'
      );
      return;
    }

    dispatch({ type: 'setImporting', value: true });

    const results = {
      imported: 0,
      skipped: accounts.length - toImport.length,
      failed: 0,
    };

    try {
      for (const account of toImport) {
        try {
          const derivedFromScan: LedgerAccountDerivation = {
            derivationIndex: account.derivationIndex,
            derivationPath: account.derivationPath,
            address: account.address,
            publicKey: account.publicKey,
          };

          const normalizedLabel =
            (accountLabels[account.derivationIndex] ?? account.accountLabel ?? '')
              .trim();

          const importRequest: ImportLedgerAccountRequest = {
            type: AccountType.LEDGER,
            deviceId: device.id,
            deviceName: device.name,
            derivationIndex: account.derivationIndex,
            derivationPath: account.derivationPath,
            label:
              normalizedLabel ||
              `Ledger Account ${account.derivationIndex}`,
          };

          await MultiAccountWalletService.importLedgerAccount(
            importRequest,
            derivedFromScan
          );
          results.imported += 1;
        } catch (error) {
          results.failed += 1;
          console.error('Failed to import Ledger account:', error);
        }
      }

      await refreshWallet();
      await handleScanAccounts();

      const alertButtons = [
        {
          text: 'Search for Rekeyed Accounts',
          onPress: () => {
            // Navigate to auth account discovery step
            setShowAuthDiscovery(true);
          },
        },
      ];

      if (isOnboarding) {
        alertButtons.unshift({
          text: 'Continue',
          onPress: () => {
            completeAfterImport().catch((error) => {
              console.error('Ledger onboarding completion failed:', error);
            });
          },
        });
      }

      Alert.alert(
        'Ledger Import Complete',
        `Imported ${results.imported} Ledger account${results.imported === 1 ? '' : 's'}${results.failed ? `\nFailed: ${results.failed}` : ''}\n\nNext: We'll search for accounts that are rekeyed to your Ledger.`,
        alertButtons
      );
    } catch (error) {
      console.error('Ledger import error:', error);
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to import Ledger accounts';
      Alert.alert('Import Failed', message);
    } finally {
      dispatch({ type: 'setImporting', value: false });
    }
  }, [
    accountLabels,
    accounts,
    completeAfterImport,
    dispatch,
    ensureDeviceConnected,
    handleScanAccounts,
    isOnboarding,
    refreshWallet,
    selectedIndexes,
  ]);

  const selectedCount = selectedIndexes.size;
  const previewAccountLabel = previewAccount
    ? accountLabels[previewAccount.derivationIndex] ??
      previewAccount.accountLabel ??
      ''
    : '';

  const updateStartIndex = useCallback((value: number) => {
    dispatch({ type: 'setStartIndex', value });
  }, [dispatch]);

  const updateCount = useCallback((value: number) => {
    dispatch({ type: 'setCount', value });
  }, [dispatch]);

  const handlePreviewAccount = useCallback(
    (account?: LedgerAccountDiscoveryResult) => {
      dispatch({ type: 'setPreview', account });
    },
    [dispatch]
  );

  const handleAuthDiscoveryComplete = useCallback(
    (importedCount: number) => {
      const message = `Successfully imported Ledger accounts and ${importedCount} auth account${importedCount === 1 ? '' : 's'}.`;

      if (isOnboarding) {
        Alert.alert('All Done!', message, [
          {
            text: 'Continue',
            onPress: () => {
              completeAfterImport().catch((error) => {
                console.error('Ledger onboarding completion failed:', error);
              });
            },
          },
        ]);
      } else {
        Alert.alert('All Done!', message, [
          { text: 'Done', onPress: () => navigation.goBack() },
        ]);
      }
    },
    [completeAfterImport, isOnboarding, navigation]
  );

  const handleSkipAuthDiscovery = useCallback(() => {
    Alert.alert(
      'Skip Auth Discovery',
      'Are you sure you want to skip searching for auth accounts? You can always add them later.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isOnboarding ? 'Skip and Continue' : 'Skip',
          onPress: () => {
            completeAfterImport().catch((error) => {
              console.error('Ledger onboarding completion failed:', error);
            });
          },
        },
      ]
    );
  }, [completeAfterImport, isOnboarding]);

  const deviceSummary = useMemo(() => {
    if (!selectedDevice) {
      return 'No device connected';
    }
    const connectionStatus = selectedDevice.connected
      ? 'Connected'
      : 'Ready to connect';
    return `${selectedDevice.name || 'Ledger Device'} · ${connectionStatus}`;
  }, [selectedDevice]);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      edges={['top']}
    >
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => {
              if (showAuthDiscovery) {
                setShowAuthDiscovery(false);
              } else {
                navigation.goBack();
              }
            }}
            style={styles.backButton}
          >
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>
            {showAuthDiscovery ? 'Find Rekeyed Accounts' : 'Import from Ledger'}
          </Text>
          <View style={{ width: 24 }} />
        </View>

        {!showAuthDiscovery && (
          <LedgerAccountImport
            headerComponent={
              <View style={styles.importHeader}>
                <TouchableOpacity
                  style={styles.deviceBanner}
                  onPress={() => setConnectionModalVisible(true)}
                >
                  <View>
                    <Text style={styles.deviceBannerTitle}>Ledger Device</Text>
                    <Text style={styles.deviceBannerSubtitle}>{deviceSummary}</Text>
                  </View>
                  <Ionicons name="swap-horizontal" size={20} color={colors.textMuted} />
                </TouchableOpacity>

                {statusMessage ? (
                  <Text style={styles.statusMessage}>{statusMessage}</Text>
                ) : null}
              </View>
            }
            footerComponent={
              <LedgerAccountPreview
                account={previewAccount}
                device={selectedDevice}
                selectedCount={selectedCount}
                onVerifyAddress={handleVerifyAddress}
                onImportAccounts={handleImportAccounts}
                isVerifying={isVerifying}
                isImporting={isImporting}
                importDisabled={accounts.every((account) => account.existsInWallet)}
                accountLabel={previewAccountLabel}
                onAccountLabelChange={
                  previewAccount
                    ? (value) =>
                        handleAccountLabelChange(
                          previewAccount.derivationIndex,
                          value
                        )
                    : undefined
                }
              />
            }
            range={{
              startIndex,
              count,
              onChangeStart: updateStartIndex,
              onChangeCount: updateCount,
              onScan: handleScanAccounts,
              isScanning,
            }}
            list={{
              accounts,
              selectedIndexes,
              onToggleSelect: handleToggleAccount,
              onPreviewAccount: handlePreviewAccount,
              isScanning,
            }}
          />
        )}

        {showAuthDiscovery && (
          <AuthAccountDiscovery
            ledgerAccounts={importedLedgerAccounts}
            onImportComplete={handleAuthDiscoveryComplete}
            onSkip={handleSkipAuthDiscovery}
            isVisible={showAuthDiscovery}
          />
        )}
      </View>

      <LedgerConnectionModal
        visible={connectionModalVisible}
        onClose={() => setConnectionModalVisible(false)}
        onConnected={handleDeviceConnected}
        onDisconnected={handleDeviceDisconnect}
        initialDeviceId={selectedDevice?.id}
      />
    </SafeAreaView>
  );
};

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    content: {
      flex: 1,
      padding: theme.spacing.sm,
      gap: theme.spacing.lg,
    },
    importHeader: {
      gap: theme.spacing.lg,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    backButton: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 16,
      backgroundColor: theme.colors.card,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    deviceBanner: {
      borderRadius: theme.borderRadius.lg,
      borderWidth: 1,
      borderColor: theme.colors.borderLight,
      padding: theme.spacing.md,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: theme.colors.card,
    },
    deviceBannerTitle: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      marginBottom: 4,
    },
    deviceBannerSubtitle: {
      fontSize: 15,
      fontWeight: '600',
      color: theme.colors.text,
    },
    statusMessage: {
      fontSize: 13,
      color: theme.colors.textSecondary,
    },
  });

export default LedgerAccountImportScreen;
