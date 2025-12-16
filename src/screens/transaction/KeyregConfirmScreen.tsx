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
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import UniversalHeader from '@/components/common/UniversalHeader';
import UnifiedTransactionAuthModal from '@/components/UnifiedTransactionAuthModal';
import {
  useTransactionAuthController,
  TransactionAuthController,
} from '@/services/auth/transactionAuthController';
import { UnifiedTransactionRequest } from '@/services/transactions/unifiedSigner';
import { formatAddress } from '@/utils/address';
import { useWalletStore, useActiveAccount } from '@/store/walletStore';
import { NetworkId } from '@/types/network';
import { WalletAccount } from '@/types/wallet';
import { getNetworkConfig } from '@/services/network/config';
import { decodeBase64Url } from '@/utils/arc0090Uri';
import { RootStackParamList } from '@/navigation/AppNavigator';

type KeyregConfirmScreenRouteProp = RouteProp<
  RootStackParamList,
  'KeyregConfirm'
>;
type KeyregConfirmScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'KeyregConfirm'
>;

export default function KeyregConfirmScreen() {
  const navigation = useNavigation<KeyregConfirmScreenNavigationProp>();
  const route = useRoute<KeyregConfirmScreenRouteProp>();
  const params = route.params;
  const styles = useThemedStyles(createStyles);
  const colors = useThemeColors();

  const { wallet } = useWalletStore();
  const activeAccount = useActiveAccount();
  const authController = useTransactionAuthController();

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [currentRequest, setCurrentRequest] =
    useState<UnifiedTransactionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Find the account that matches the address
  const account = wallet?.accounts.find(
    (acc) => acc.address === params.address
  );

  const networkId = params.networkId || NetworkId.VOI_MAINNET;
  const networkConfig = getNetworkConfig(networkId);

  useEffect(() => {
    return () => {
      authController.cleanup();
    };
  }, [authController]);

  const handleConfirm = useCallback(() => {
    if (!account) {
      Alert.alert(
        'Account Not Found',
        `The address ${formatAddress(params.address)} is not in your wallet. You can only sign key registration transactions for accounts you control.`
      );
      return;
    }

    // Decode participation keys if provided
    let voteKey: Uint8Array | undefined;
    let selectionKey: Uint8Array | undefined;
    let stateProofKey: Uint8Array | undefined;

    try {
      if (params.votekey) {
        voteKey = decodeBase64Url(params.votekey);
      }
      if (params.selkey) {
        selectionKey = decodeBase64Url(params.selkey);
      }
      if (params.sprfkey) {
        stateProofKey = decodeBase64Url(params.sprfkey);
      }
    } catch (err) {
      Alert.alert('Invalid Keys', 'Failed to decode participation keys.');
      return;
    }

    // Create unified transaction request
    const request: UnifiedTransactionRequest = {
      type: 'keyreg',
      account: account as unknown as WalletAccount,
      keyregParams: {
        address: params.address,
        voteKey,
        selectionKey,
        stateProofKey,
        voteFirst: params.votefst,
        voteLast: params.votelst,
        voteKeyDilution: params.votekd,
        nonParticipation: !params.isOnline,
        fee: params.fee,
        note: params.note,
        networkId,
      },
      networkId,
    };

    setCurrentRequest(request);
    setShowAuthModal(true);
  }, [account, params, networkId]);

  const handleCancel = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleAuthComplete = useCallback(
    (success: boolean, result?: any) => {
      setShowAuthModal(false);

      if (success && result?.transactionId) {
        Alert.alert(
          'Success',
          params.isOnline
            ? 'Your account is now registered for consensus participation.'
            : 'Your account has been taken offline from consensus participation.',
          [
            {
              text: 'OK',
              onPress: () => navigation.goBack(),
            },
          ]
        );
      } else if (!success && result?.error) {
        setError(result.error.message || 'Transaction failed');
        Alert.alert(
          'Transaction Failed',
          result.error.message || 'Failed to submit transaction'
        );
      }
    },
    [params.isOnline, navigation]
  );

  const handleAuthCancel = useCallback(() => {
    setShowAuthModal(false);
    authController.cleanup();
  }, [authController]);

  const renderKeyInfo = (label: string, value: string | undefined) => {
    if (!value) return null;

    // Truncate long keys for display
    const displayValue =
      value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-12)}` : value;

    return (
      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue} numberOfLines={1}>
          {displayValue}
        </Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title="Key Registration"
        showBackButton
        onBackPress={handleCancel}
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Status Badge */}
        <View style={styles.statusContainer}>
          <View
            style={[
              styles.statusBadge,
              params.isOnline ? styles.onlineBadge : styles.offlineBadge,
            ]}
          >
            <Ionicons
              name={params.isOnline ? 'cloud-upload' : 'cloud-offline'}
              size={20}
              color={params.isOnline ? '#10B981' : '#EF4444'}
            />
            <Text
              style={[
                styles.statusText,
                params.isOnline
                  ? styles.onlineStatusText
                  : styles.offlineStatusText,
              ]}
            >
              {params.isOnline ? 'Go Online' : 'Go Offline'}
            </Text>
          </View>
        </View>

        {/* Description */}
        <GlassCard style={styles.card}>
          <Text style={styles.description}>
            {params.isOnline
              ? 'This will register your participation keys for consensus. Your account will begin participating in block production.'
              : 'This will remove your participation keys. Your account will stop participating in consensus.'}
          </Text>
        </GlassCard>

        {/* Account Info */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>Account</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Address</Text>
            <Text style={styles.infoValue}>
              {formatAddress(params.address)}
            </Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Network</Text>
            <Text style={styles.infoValue}>{networkConfig.name}</Text>
          </View>
          {!account && (
            <View style={styles.warningBanner}>
              <Ionicons name="warning" size={16} color="#F59E0B" />
              <Text style={styles.warningText}>
                This address is not in your wallet
              </Text>
            </View>
          )}
        </GlassCard>

        {/* Participation Keys (for online registration) */}
        {params.isOnline && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Participation Keys</Text>
            {renderKeyInfo('Vote Key', params.votekey)}
            {renderKeyInfo('Selection Key', params.selkey)}
            {renderKeyInfo('State Proof Key', params.sprfkey)}
          </GlassCard>
        )}

        {/* Validity Period (for online registration) */}
        {params.isOnline && params.votefst && params.votelst && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Validity Period</Text>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>First Round</Text>
              <Text style={styles.infoValue}>
                {params.votefst.toLocaleString()}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Last Round</Text>
              <Text style={styles.infoValue}>
                {params.votelst.toLocaleString()}
              </Text>
            </View>
            {params.votekd && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Key Dilution</Text>
                <Text style={styles.infoValue}>
                  {params.votekd.toLocaleString()}
                </Text>
              </View>
            )}
          </GlassCard>
        )}

        {/* Transaction Details */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>Transaction Details</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Transaction Type</Text>
            <Text style={styles.infoValue}>Key Registration</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Fee</Text>
            <Text style={styles.infoValue}>
              {params.fee
                ? `${(params.fee / 1_000_000).toFixed(6)} ${networkConfig.nativeToken}`
                : `~0.001 ${networkConfig.nativeToken} (minimum)`}
            </Text>
          </View>
          {params.note && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Note</Text>
              <Text style={styles.infoValue} numberOfLines={2}>
                {params.note}
              </Text>
            </View>
          )}
        </GlassCard>

        {error && (
          <View style={styles.errorBanner}>
            <Ionicons name="alert-circle" size={20} color="#EF4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>

      {/* Action Buttons */}
      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={handleCancel}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.confirmButton,
            !account && styles.disabledButton,
          ]}
          onPress={handleConfirm}
          disabled={!account}
        >
          <Text style={styles.confirmButtonText}>
            {params.isOnline ? 'Go Online' : 'Go Offline'}
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
        title={
          params.isOnline ? 'Confirm Go Online' : 'Confirm Go Offline'
        }
        message="Authenticate to sign this key registration transaction"
      />
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
      padding: 16,
      paddingBottom: 100,
    },
    statusContainer: {
      alignItems: 'center',
      marginBottom: 16,
    },
    statusBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 20,
      gap: 8,
    },
    onlineBadge: {
      backgroundColor: 'rgba(16, 185, 129, 0.15)',
    },
    offlineBadge: {
      backgroundColor: 'rgba(239, 68, 68, 0.15)',
    },
    statusText: {
      fontSize: 16,
      fontWeight: '600',
    },
    onlineStatusText: {
      color: '#10B981',
    },
    offlineStatusText: {
      color: '#EF4444',
    },
    card: {
      marginBottom: 16,
      padding: 16,
    },
    cardTitle: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.textSecondary,
      marginBottom: 12,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    description: {
      fontSize: 15,
      color: theme.colors.text,
      lineHeight: 22,
    },
    infoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    infoLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      flex: 1,
    },
    infoValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
      flex: 2,
      textAlign: 'right',
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(245, 158, 11, 0.15)',
      padding: 12,
      borderRadius: 8,
      marginTop: 12,
      gap: 8,
    },
    warningText: {
      color: '#F59E0B',
      fontSize: 13,
      flex: 1,
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(239, 68, 68, 0.15)',
      padding: 12,
      borderRadius: 8,
      marginTop: 8,
      gap: 8,
    },
    errorText: {
      color: '#EF4444',
      fontSize: 13,
      flex: 1,
    },
    buttonContainer: {
      flexDirection: 'row',
      padding: 16,
      paddingBottom: 32,
      gap: 12,
      backgroundColor: theme.colors.background,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    cancelButton: {
      flex: 1,
      paddingVertical: 16,
      borderRadius: 12,
      backgroundColor: theme.colors.card,
      alignItems: 'center',
    },
    cancelButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
    },
    confirmButton: {
      flex: 2,
      paddingVertical: 16,
      borderRadius: 12,
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
    },
    confirmButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: '#FFFFFF',
    },
    disabledButton: {
      opacity: 0.5,
    },
  });
