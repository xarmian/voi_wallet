import React, { useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute, useNavigation, RouteProp } from '@react-navigation/native';
import { StackNavigationProp } from '@react-navigation/stack';
import { Ionicons } from '@expo/vector-icons';
import { formatAddress } from '@/utils/address';
import { formatVoiBalance } from '@/utils/bigint';
import UniversalHeader from '@/components/common/UniversalHeader';
import { WalletStackParamList } from '@/navigation/AppNavigator';
import { copyToClipboard } from '@/utils/clipboard';
import { getTransactionUrl } from '@/utils/blockExplorer';
import { hapticNotify } from '@/utils/haptics';
import { NetworkId } from '@/types/network';
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import { useTheme } from '@/contexts/ThemeContext';
import { NFTBackground } from '@/components/common/NFTBackground';
import { GlassCard } from '@/components/common/GlassCard';
import { GlassButton } from '@/components/common/GlassButton';

type TransactionResultScreenRouteProp = RouteProp<
  WalletStackParamList,
  'TransactionResult'
>;
type TransactionResultScreenNavigationProp = StackNavigationProp<
  WalletStackParamList,
  'TransactionResult'
>;

interface TransactionResultParams {
  transactionId?: string;
  recipient: string;
  recipientName?: string;
  amount: string;
  assetSymbol: string;
  assetId?: number;
  fee?: number;
  isSuccess: boolean;
  // Whether the tx was confirmed within the round window. Only meaningful when
  // isSuccess is true: `false` => submitted but still pending (distinct UI);
  // `undefined`/true => treat as confirmed success (backward-compatible default).
  confirmed?: boolean;
  errorMessage?: string;
  homeRoute?: string; // Route to navigate back to (e.g., 'HomeMain' or 'NFTMain')
  networkId?: string;
}

export default function TransactionResultScreen() {
  const route = useRoute<TransactionResultScreenRouteProp>();
  const navigation = useNavigation<TransactionResultScreenNavigationProp>();
  const params = route.params as TransactionResultParams;
  const styles = useThemedStyles(createStyles);
  const { theme } = useTheme();

  // One-time outcome haptic on mount, matching the screen's success/failure UI
  // (params.isSuccess drives the icon/title/color below). Fire-and-forget.
  useEffect(() => {
    hapticNotify(params.isSuccess ? 'success' : 'error');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once on mount; result params are fixed for a given screen instance, so params.isSuccess never changes under this instance.
  }, []);

  const handleViewInExplorer = async () => {
    if (!params.transactionId) return;

    const url = getTransactionUrl(
      params.transactionId,
      params.networkId as NetworkId | undefined
    );
    const supported = await Linking.canOpenURL(url);

    if (supported) {
      await Linking.openURL(url);
    }
  };

  const handleCopyTransactionId = () => {
    if (params.transactionId) {
      copyToClipboard(
        params.transactionId,
        'Transaction ID copied to clipboard'
      );
    }
  };

  const handleBackToHome = () => {
    const homeRoute = params.homeRoute || 'HomeMain';
    // Reset navigation stack to prevent back navigation to completed transaction
    navigation.reset({
      index: 0,
      routes: [{ name: homeRoute as keyof WalletStackParamList }],
    });
  };

  // Pending = submitted successfully but not yet confirmed within the round
  // window. Only `confirmed === false` triggers this; undefined/true keep the
  // existing "Transaction Sent!" success UI (backward-compatible default).
  const isPending = params.isSuccess === true && params.confirmed === false;

  const getStatusIcon = () => {
    if (isPending) return 'time';
    return params.isSuccess ? 'checkmark-circle' : 'close-circle';
  };

  const getStatusTitle = () => {
    if (isPending) return 'Transaction Pending';
    return params.isSuccess ? 'Transaction Sent!' : 'Transaction Failed';
  };

  const getStatusMessage = () => {
    if (isPending) {
      return 'Submitted — waiting for confirmation. It may still confirm; check your history.';
    }
    if (params.isSuccess) {
      return 'Your transaction has been submitted to the network and will be confirmed shortly.';
    }
    return (
      params.errorMessage ||
      'An error occurred while processing your transaction.'
    );
  };

  const statusColor = isPending
    ? theme.colors.warning
    : params.isSuccess
      ? theme.colors.success
      : theme.colors.error;

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <UniversalHeader
          title={getStatusTitle()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
        />

        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
        >
          {/* Status Icon and Message */}
          <GlassCard
            variant="medium"
            style={styles.statusContainer}
            borderGlow
            glowColor={statusColor}
          >
            <View
              style={[
                styles.statusIconContainer,
                { backgroundColor: `${statusColor}20` },
              ]}
            >
              <Ionicons name={getStatusIcon()} size={48} color={statusColor} />
            </View>
            <Text style={[styles.statusTitle, { color: theme.colors.text }]}>
              {getStatusTitle()}
            </Text>
            <Text
              style={[styles.statusMessage, { color: theme.colors.textMuted }]}
            >
              {getStatusMessage()}
            </Text>
          </GlassCard>

          {/* Transaction Details */}
          <GlassCard variant="light" style={styles.detailsContainer}>
            <Text style={[styles.detailsTitle, { color: theme.colors.text }]}>
              Transaction Details
            </Text>

            <View style={styles.detailRow}>
              <Text
                style={[styles.detailLabel, { color: theme.colors.textMuted }]}
              >
                Amount
              </Text>
              <Text style={[styles.detailValue, { color: theme.colors.text }]}>
                {params.amount} {params.assetSymbol}
              </Text>
            </View>

            <View style={styles.detailRow}>
              <Text
                style={[styles.detailLabel, { color: theme.colors.textMuted }]}
              >
                To
              </Text>
              <Text style={[styles.detailValue, { color: theme.colors.text }]}>
                {params.recipientName || formatAddress(params.recipient)}
              </Text>
            </View>

            {params.fee && (
              <View style={styles.detailRow}>
                <Text
                  style={[
                    styles.detailLabel,
                    { color: theme.colors.textMuted },
                  ]}
                >
                  Fee
                </Text>
                <Text
                  style={[styles.detailValue, { color: theme.colors.text }]}
                >
                  {formatVoiBalance(params.fee)} VOI
                </Text>
              </View>
            )}

            {params.transactionId && (
              <View style={styles.detailRow}>
                <Text
                  style={[
                    styles.detailLabel,
                    { color: theme.colors.textMuted },
                  ]}
                >
                  Transaction ID
                </Text>
                <TouchableOpacity
                  style={styles.transactionIdContainer}
                  onPress={handleCopyTransactionId}
                >
                  <Text
                    style={[
                      styles.transactionIdText,
                      { color: theme.colors.primary },
                    ]}
                  >
                    {params.transactionId.slice(0, 8)}...
                    {params.transactionId.slice(-8)}
                  </Text>
                  <Ionicons
                    name="copy-outline"
                    size={14}
                    color={theme.colors.primary}
                  />
                </TouchableOpacity>
              </View>
            )}
          </GlassCard>

          {/* Action Buttons */}
          {params.isSuccess && params.transactionId && (
            <GlassButton
              variant="secondary"
              label="View in Block Explorer"
              icon="open-outline"
              onPress={handleViewInExplorer}
              fullWidth
            />
          )}
        </ScrollView>

        {/* Bottom Action */}
        <View style={styles.buttonContainer}>
          <GlassButton
            variant="primary"
            label="Back to Home"
            icon="home"
            onPress={handleBackToHome}
            fullWidth
            glow
            size="lg"
          />
        </View>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    content: {
      flex: 1,
      paddingHorizontal: theme.spacing.lg,
    },
    contentContainer: {
      paddingBottom: theme.spacing.xl,
      paddingTop: theme.spacing.md,
    },
    statusContainer: {
      alignItems: 'center',
      borderRadius: theme.borderRadius.xxl,
      marginBottom: theme.spacing.lg,
    },
    statusIconContainer: {
      width: 80,
      height: 80,
      borderRadius: 40,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: theme.spacing.md,
    },
    statusTitle: {
      fontSize: theme.typography.heading2.fontSize,
      fontWeight: '600',
      marginBottom: theme.spacing.sm,
      textAlign: 'center',
    },
    statusMessage: {
      fontSize: theme.typography.body.fontSize,
      textAlign: 'center',
      lineHeight: 22,
    },
    detailsContainer: {
      borderRadius: theme.borderRadius.xl,
      marginBottom: theme.spacing.lg,
    },
    detailsTitle: {
      fontSize: theme.typography.heading3.fontSize,
      fontWeight: '600',
      marginBottom: theme.spacing.md,
      paddingBottom: theme.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.glassBorder,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
    },
    detailLabel: {
      fontSize: theme.typography.body.fontSize,
    },
    detailValue: {
      fontSize: theme.typography.body.fontSize,
      fontWeight: '500',
      textAlign: 'right',
      flex: 1,
      marginLeft: theme.spacing.md,
    },
    transactionIdContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      flex: 1,
      justifyContent: 'flex-end',
    },
    transactionIdText: {
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: '500',
      fontFamily: 'monospace',
    },
    buttonContainer: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
  });
