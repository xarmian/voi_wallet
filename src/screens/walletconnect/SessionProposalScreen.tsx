import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StackNavigationProp } from '@react-navigation/stack';
import { RouteProp } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { RootStackParamList } from '@/navigation/AppNavigator';
import {
  WalletConnectService,
  SessionProposal,
} from '@/services/walletconnect';
import { WalletConnectV1Client, DEFAULT_CHAIN_ID } from '@/services/walletconnect/v1';
import { MultiAccountWalletService } from '@/services/wallet';
import { AccountMetadata } from '@/types/wallet';
import UniversalHeader from '@/components/common/UniversalHeader';
import {
  getSignableAccounts,
  truncateAddress,
} from '@/services/walletconnect/utils';
import AccountSelectionItem from '@/components/walletconnect/AccountSelectionItem';
import { useTheme } from '@/contexts/ThemeContext';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

type SessionProposalScreenNavigationProp = StackNavigationProp<
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

  const [isLoading, setIsLoading] = useState(false);
  const [accounts, setAccounts] = useState<AccountMetadata[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(
    new Set()
  );

  useEffect(() => {
    loadAccounts();
  }, []);

  const loadAccounts = async () => {
    try {
      const allAccounts = await MultiAccountWalletService.getAllAccounts();
      const signableAccounts = getSignableAccounts(allAccounts);
      setAccounts(signableAccounts);
      // Pre-select all signable accounts by default
      const initialSelection = new Set(
        signableAccounts.map((account) => account.id)
      );
      setSelectedAccountIds(initialSelection);
    } catch (error) {
      console.error('Failed to load accounts:', error);
      Alert.alert('Error', 'Failed to load accounts');
    }
  };

  const handleApprove = async () => {
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
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to reject connection'
      );
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
            defaultSource={require('../../../assets/icon.png')}
          />
        )}
        <Text style={styles.dappName}>{metadata.name}</Text>
        <Text style={styles.dappDescription}>
          {metadata.description || 'No description provided'}
        </Text>
        {metadata.url && (
          <Text style={styles.dappUrl}>{metadata.url}</Text>
        )}
      </View>
    );
  };

  const renderPermissions = () => {
    if (isV1) {
      // v1 has simpler permissions - just show algo_signTxn
      return (
        <View style={styles.permissionsContainer}>
          <Text style={styles.sectionTitle}>Requested Permissions</Text>
          <View style={styles.namespaceContainer}>
            <Text style={styles.namespaceTitle}>ALGORAND (v1)</Text>
            <View style={styles.permissionItem}>
              <Ionicons
                name="construct"
                size={16}
                color={theme.colors.textMuted}
              />
              <Text style={styles.permissionText}>
                Methods: algo_signTxn
              </Text>
            </View>
          </View>
        </View>
      );
    }

    // v2 permissions
    const requiredNamespaces = Object.entries(proposal!.requiredNamespaces);

    return (
      <View style={styles.permissionsContainer}>
        <Text style={styles.sectionTitle}>Requested Permissions</Text>
        {requiredNamespaces.map(([namespace, permissions]) => (
          <View key={namespace} style={styles.namespaceContainer}>
            <Text style={styles.namespaceTitle}>{namespace.toUpperCase()}</Text>

            {permissions.chains && (
              <View style={styles.permissionItem}>
                <Ionicons
                  name="link"
                  size={16}
                  color={theme.colors.textMuted}
                />
                <Text style={styles.permissionText}>
                  Networks: {permissions.chains.join(', ')}
                </Text>
              </View>
            )}

            {permissions.methods && (
              <View style={styles.permissionItem}>
                <Ionicons
                  name="construct"
                  size={16}
                  color={theme.colors.textMuted}
                />
                <Text style={styles.permissionText}>
                  Methods: {permissions.methods.join(', ')}
                </Text>
              </View>
            )}
          </View>
        ))}
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

      {accounts.map((account) => (
        <AccountSelectionItem
          key={account.id}
          account={account}
          isSelected={selectedAccountIds.has(account.id)}
          onToggleSelection={handleToggleAccountSelection}
        />
      ))}
    </View>
  );

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <UniversalHeader
        title="Connect to dApp"
        showBackButton
        onBackPress={() => navigation.goBack()}
      />

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
          style={[styles.button, styles.approveButton]}
          onPress={handleApprove}
          disabled={
            isLoading || accounts.length === 0 || selectedAccountIds.size === 0
          }
        >
          {isLoading ? (
            <ActivityIndicator color={theme.colors.buttonText} />
          ) : (
            <Text style={styles.approveButtonText}>Connect</Text>
          )}
        </TouchableOpacity>
      </View>
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
      ...theme.shadows.small,
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
