import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import algosdk from 'algosdk';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { GlassCard } from '@/components/common/GlassCard';
import UniversalHeader from '@/components/common/UniversalHeader';
import UnifiedTransactionAuthModal from '@/components/UnifiedTransactionAuthModal';
import {
  useTransactionAuthController,
} from '@/services/auth/transactionAuthController';
import { UnifiedTransactionRequest } from '@/services/transactions/unifiedSigner';
import { formatAddress } from '@/utils/address';
import { useWalletStore, useActiveAccount } from '@/store/walletStore';
import { NetworkId } from '@/types/network';
import { WalletAccount } from '@/types/wallet';
import { getNetworkConfig } from '@/services/network/config';
import { decodeBase64Url } from '@/utils/arc0090Uri';
import { RootStackParamList } from '@/navigation/AppNavigator';

// Algorand zero address (used as template placeholder)
const ZERO_ADDRESS =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';

type AppCallConfirmScreenRouteProp = RouteProp<
  RootStackParamList,
  'AppCallConfirm'
>;
type AppCallConfirmScreenNavigationProp = StackNavigationProp<
  RootStackParamList,
  'AppCallConfirm'
>;

export default function AppCallConfirmScreen() {
  const navigation = useNavigation<AppCallConfirmScreenNavigationProp>();
  const route = useRoute<AppCallConfirmScreenRouteProp>();
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

  // Determine the actual sender - if zero address, use active account
  const isTemplateUri = params.senderAddress === ZERO_ADDRESS;
  const senderAddress = isTemplateUri
    ? activeAccount?.address
    : params.senderAddress;

  // Find the account that matches the sender address
  const account = wallet?.accounts.find((acc) => acc.address === senderAddress);

  const networkId = params.networkId || NetworkId.VOI_MAINNET;
  const networkConfig = getNetworkConfig(networkId);

  // Calculate the app's escrow address if payment is specified
  const appEscrowAddress = useMemo(() => {
    if (params.payment && params.payment > 0) {
      return algosdk.getApplicationAddress(params.appId);
    }
    return null;
  }, [params.appId, params.payment]);

  // Format payment amount for display
  const formattedPaymentAmount = useMemo(() => {
    if (!params.payment || params.payment <= 0) return null;
    // Convert atomic units to display units (divide by 1,000,000 for 6 decimals)
    return (params.payment / 1_000_000).toFixed(6);
  }, [params.payment]);

  useEffect(() => {
    return () => {
      authController.cleanup();
    };
  }, [authController]);

  const parseMethodSignature = (
    method: string
  ): { name: string; args: string[]; returnType: string } | null => {
    // Parse ABI method signature like "claim(uint64,uint64)byte[]"
    const match = method.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]*)\)(.*)$/);
    if (!match) return null;

    const [, name, argsStr, returnType] = match;
    const args = argsStr ? argsStr.split(',').map((a) => a.trim()) : [];
    return { name, args, returnType };
  };

  const handleConfirm = useCallback(() => {
    if (!account) {
      Alert.alert(
        'Account Not Found',
        senderAddress
          ? `The address ${formatAddress(senderAddress)} is not in your wallet.`
          : 'No active account found. Please select an account first.'
      );
      return;
    }

    // Build app args from string params
    let appArgs: Uint8Array[] | undefined;
    if (params.args && params.args.length > 0) {
      try {
        appArgs = params.args.map((arg) => {
          try {
            return decodeBase64Url(arg);
          } catch {
            return new Uint8Array(Buffer.from(arg));
          }
        });
      } catch (err) {
        Alert.alert('Invalid Arguments', 'Failed to decode app arguments.');
        return;
      }
    }

    // Build box references
    let boxes: Array<{ appIndex: number; name: Uint8Array }> | undefined;
    if (params.boxes && params.boxes.length > 0) {
      try {
        boxes = params.boxes.map((box) => ({
          appIndex: params.appId,
          name: decodeBase64Url(box),
        }));
      } catch (err) {
        Alert.alert('Invalid Box References', 'Failed to decode box references.');
        return;
      }
    }

    // Create unified transaction request
    const request: UnifiedTransactionRequest = {
      type: 'appl',
      account: account as unknown as WalletAccount,
      applParams: {
        senderAddress: senderAddress!,
        appId: params.appId,
        appArgs,
        foreignApps: params.foreignApps,
        foreignAssets: params.foreignAssets,
        accounts: params.foreignAccounts,
        boxes,
        fee: params.fee,
        note: params.note,
        networkId,
        paymentAmount: params.payment,
      },
      networkId,
    };

    setCurrentRequest(request);
    setShowAuthModal(true);
  }, [account, senderAddress, params, networkId]);

  const handleCancel = useCallback(() => {
    navigation.goBack();
  }, [navigation]);

  const handleAuthComplete = useCallback(
    (success: boolean, result?: any) => {
      setShowAuthModal(false);

      if (success && result?.transactionId) {
        Alert.alert(
          'Success',
          `Application call completed successfully.\nTransaction ID: ${result.transactionId.slice(0, 8)}...`,
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
    [navigation]
  );

  const handleAuthCancel = useCallback(() => {
    setShowAuthModal(false);
    authController.cleanup();
  }, [authController]);

  const parsedMethod = params.method
    ? parseMethodSignature(params.method)
    : null;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <UniversalHeader
        title="Application Call"
        showBackButton
        onBackPress={handleCancel}
        onAccountSelectorPress={() => {}}
        showAccountSelector={false}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {/* App Info */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>Application</Text>
          <View style={styles.appIdContainer}>
            <Ionicons name="cube" size={24} color={colors.primary} />
            <Text style={styles.appIdText}>App #{params.appId}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Network</Text>
            <Text style={styles.infoValue}>{networkConfig.name}</Text>
          </View>
        </GlassCard>

        {/* Payment Info (if payment is specified) */}
        {params.payment && params.payment > 0 && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Payment</Text>
            <View style={styles.paymentAmountContainer}>
              <Ionicons name="send" size={24} color={colors.primary} />
              <Text style={styles.paymentAmountText}>
                {formattedPaymentAmount} {networkConfig.nativeToken}
              </Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>To App Escrow</Text>
              <Text style={styles.infoValue} numberOfLines={1}>
                {appEscrowAddress ? formatAddress(appEscrowAddress) : '-'}
              </Text>
            </View>
            <View style={styles.infoBanner}>
              <Ionicons name="information-circle" size={16} color="#3B82F6" />
              <Text style={styles.infoText}>
                This payment will be sent to the application's escrow account as part of an atomic transaction group
              </Text>
            </View>
          </GlassCard>
        )}

        {/* Method Info */}
        {params.method && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Method Call</Text>
            <View style={styles.methodContainer}>
              <Text style={styles.methodName}>
                {parsedMethod?.name || params.method}
              </Text>
              {parsedMethod && (
                <Text style={styles.methodSignature}>
                  ({parsedMethod.args.join(', ')})
                  {parsedMethod.returnType && ` → ${parsedMethod.returnType}`}
                </Text>
              )}
            </View>
          </GlassCard>
        )}

        {/* Arguments */}
        {params.args && params.args.length > 0 && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>
              Arguments ({params.args.length})
            </Text>
            {params.args.map((arg, index) => (
              <View key={index} style={styles.argRow}>
                <Text style={styles.argIndex}>
                  {parsedMethod?.args[index] || `arg${index}`}
                </Text>
                <Text style={styles.argValue} numberOfLines={1}>
                  {arg.length > 30 ? `${arg.slice(0, 15)}...${arg.slice(-15)}` : arg}
                </Text>
              </View>
            ))}
          </GlassCard>
        )}

        {/* Foreign References */}
        {((params.foreignApps && params.foreignApps.length > 0) ||
          (params.foreignAssets && params.foreignAssets.length > 0) ||
          (params.foreignAccounts && params.foreignAccounts.length > 0) ||
          (params.boxes && params.boxes.length > 0)) && (
          <GlassCard style={styles.card}>
            <Text style={styles.cardTitle}>Foreign References</Text>

            {params.foreignApps && params.foreignApps.length > 0 && (
              <View style={styles.refSection}>
                <Text style={styles.refLabel}>Apps</Text>
                <Text style={styles.refValue}>
                  {params.foreignApps.join(', ')}
                </Text>
              </View>
            )}

            {params.foreignAssets && params.foreignAssets.length > 0 && (
              <View style={styles.refSection}>
                <Text style={styles.refLabel}>Assets</Text>
                <Text style={styles.refValue}>
                  {params.foreignAssets.join(', ')}
                </Text>
              </View>
            )}

            {params.foreignAccounts && params.foreignAccounts.length > 0 && (
              <View style={styles.refSection}>
                <Text style={styles.refLabel}>Accounts</Text>
                {params.foreignAccounts.map((acc, i) => (
                  <Text key={i} style={styles.refValue}>
                    {formatAddress(acc)}
                  </Text>
                ))}
              </View>
            )}

            {params.boxes && params.boxes.length > 0 && (
              <View style={styles.refSection}>
                <Text style={styles.refLabel}>Boxes</Text>
                <Text style={styles.refValue}>
                  {params.boxes.length} box reference(s)
                </Text>
              </View>
            )}
          </GlassCard>
        )}

        {/* Sender Info */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>Sender</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Address</Text>
            <Text style={styles.infoValue}>
              {senderAddress ? formatAddress(senderAddress) : 'None selected'}
            </Text>
          </View>
          {isTemplateUri && (
            <View style={styles.infoBanner}>
              <Ionicons name="information-circle" size={16} color="#3B82F6" />
              <Text style={styles.infoText}>
                Using your active account as sender
              </Text>
            </View>
          )}
          {!account && senderAddress && (
            <View style={styles.warningBanner}>
              <Ionicons name="warning" size={16} color="#F59E0B" />
              <Text style={styles.warningText}>
                This address is not in your wallet
              </Text>
            </View>
          )}
        </GlassCard>

        {/* Transaction Details */}
        <GlassCard style={styles.card}>
          <Text style={styles.cardTitle}>Transaction Details</Text>
          {params.fee && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Fee</Text>
              <Text style={styles.infoValue}>
                {(params.fee / 1_000_000).toFixed(6)} {networkConfig.nativeToken}
              </Text>
            </View>
          )}
          {params.note && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Note</Text>
              <Text style={styles.infoValue} numberOfLines={2}>
                {params.note}
              </Text>
            </View>
          )}
        </GlassCard>

        {/* Warning */}
        <View style={styles.warningCard}>
          <Ionicons name="alert-triangle" size={24} color="#F59E0B" />
          <Text style={styles.warningCardText}>
            Application calls can execute smart contract code. Only proceed if
            you trust the source of this request.
          </Text>
        </View>

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
          <Text style={styles.confirmButtonText}>Execute</Text>
        </TouchableOpacity>
      </View>

      {/* Auth Modal */}
      <UnifiedTransactionAuthModal
        visible={showAuthModal}
        controller={authController}
        request={currentRequest}
        onComplete={handleAuthComplete}
        onCancel={handleAuthCancel}
        title="Confirm Application Call"
        message="Authenticate to sign this application call transaction"
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
    appIdContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
      gap: 12,
    },
    appIdText: {
      fontSize: 24,
      fontWeight: '700',
      color: theme.colors.text,
    },
    paymentAmountContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
      gap: 12,
    },
    paymentAmountText: {
      fontSize: 22,
      fontWeight: '700',
      color: theme.colors.primary,
    },
    methodContainer: {
      backgroundColor: theme.colors.surface,
      padding: 12,
      borderRadius: 8,
    },
    methodName: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.primary,
      fontFamily: 'monospace',
    },
    methodSignature: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      fontFamily: 'monospace',
      marginTop: 4,
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
    argRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      gap: 12,
    },
    argIndex: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      fontFamily: 'monospace',
      width: 80,
    },
    argValue: {
      fontSize: 13,
      color: theme.colors.text,
      fontFamily: 'monospace',
      flex: 1,
    },
    refSection: {
      marginBottom: 12,
    },
    refLabel: {
      fontSize: 13,
      color: theme.colors.textSecondary,
      marginBottom: 4,
    },
    refValue: {
      fontSize: 13,
      color: theme.colors.text,
      fontFamily: 'monospace',
    },
    infoBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(59, 130, 246, 0.15)',
      padding: 12,
      borderRadius: 8,
      marginTop: 12,
      gap: 8,
    },
    infoText: {
      color: '#3B82F6',
      fontSize: 13,
      flex: 1,
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
    warningCard: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: 'rgba(245, 158, 11, 0.1)',
      padding: 16,
      borderRadius: 12,
      marginBottom: 16,
      gap: 12,
    },
    warningCardText: {
      color: '#F59E0B',
      fontSize: 14,
      flex: 1,
      lineHeight: 20,
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
