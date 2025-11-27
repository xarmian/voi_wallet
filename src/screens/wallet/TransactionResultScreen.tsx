import React from 'react';
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
import { useThemedStyles } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

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
  errorMessage?: string;
  homeRoute?: string; // Route to navigate back to (e.g., 'HomeMain' or 'NFTMain')
  networkId?: string;
}

export default function TransactionResultScreen() {
  const route = useRoute<TransactionResultScreenRouteProp>();
  const navigation = useNavigation<TransactionResultScreenNavigationProp>();
  const params = route.params as TransactionResultParams;
  const styles = useThemedStyles(createStyles);

  const handleViewInExplorer = async () => {
    if (!params.transactionId) return;

    const url = getTransactionUrl(params.transactionId, params.networkId);
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

  const getStatusIcon = () => {
    return params.isSuccess ? 'checkmark-circle' : 'close-circle';
  };

  const getStatusColor = () => {
    return params.isSuccess
      ? styles.successColor.color
      : styles.errorColor.color;
  };

  const getStatusTitle = () => {
    return params.isSuccess ? 'Transaction Sent!' : 'Transaction Failed';
  };

  const getStatusMessage = () => {
    if (params.isSuccess) {
      return 'Your transaction has been submitted to the network and will be confirmed shortly.';
    }
    return (
      params.errorMessage ||
      'An error occurred while processing your transaction.'
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <UniversalHeader
        title={getStatusTitle()}
        subtitle={
          params.isSuccess ? 'Transaction submitted' : 'Please try again'
        }
        showAccountSelector={false}
        onAccountSelectorPress={() => {}}
      />

      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        {/* Status Icon and Message */}
        <View style={styles.statusContainer}>
          <Ionicons
            name={getStatusIcon()}
            size={80}
            color={getStatusColor()}
            style={styles.statusIcon}
          />
          <Text style={[styles.statusTitle, { color: getStatusColor() }]}>
            {getStatusTitle()}
          </Text>
          <Text style={styles.statusMessage}>{getStatusMessage()}</Text>
        </View>

        {/* Transaction Details */}
        <View style={styles.detailsContainer}>
          <Text style={styles.detailsTitle}>Transaction Details</Text>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Amount:</Text>
            <Text style={styles.detailValue}>
              {params.amount} {params.assetSymbol}
            </Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>To:</Text>
            <Text style={styles.detailValue}>
              {params.recipientName || formatAddress(params.recipient)}
            </Text>
          </View>

          {params.fee && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Fee:</Text>
              <Text style={styles.detailValue}>
                {formatVoiBalance(params.fee)} VOI
              </Text>
            </View>
          )}

          {params.transactionId && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Transaction ID:</Text>
              <TouchableOpacity
                style={styles.transactionIdContainer}
                onPress={handleCopyTransactionId}
              >
                <Text style={styles.transactionIdText}>
                  {params.transactionId.slice(0, 8)}...
                  {params.transactionId.slice(-8)}
                </Text>
                <Ionicons
                  name="copy-outline"
                  size={16}
                  color={styles.primaryIcon.color}
                />
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Action Buttons */}
        {params.isSuccess && params.transactionId && (
          <TouchableOpacity
            style={styles.explorerButton}
            onPress={handleViewInExplorer}
          >
            <Ionicons
              name="open-outline"
              size={20}
              color={styles.primaryIcon.color}
            />
            <Text style={styles.explorerButtonText}>
              View in Block Explorer
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Bottom Action */}
      <View style={styles.buttonContainer}>
        <TouchableOpacity style={styles.homeButton} onPress={handleBackToHome}>
          <Text style={styles.homeButtonText}>Back to Home</Text>
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
    content: {
      flex: 1,
      paddingHorizontal: theme.spacing.lg,
    },
    contentContainer: {
      paddingBottom: theme.spacing.xl,
    },
    statusContainer: {
      alignItems: 'center',
      paddingVertical: 40,
    },
    statusIcon: {
      marginBottom: theme.spacing.md,
    },
    statusTitle: {
      fontSize: 24,
      fontWeight: '600',
      marginBottom: theme.spacing.xs,
      textAlign: 'center',
    },
    statusMessage: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      textAlign: 'center',
      lineHeight: 22,
      paddingHorizontal: theme.spacing.lg,
    },
    detailsContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.md,
      marginBottom: theme.spacing.lg,
    },
    detailsTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.md,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    detailLabel: {
      fontSize: 16,
      color: theme.colors.textSecondary,
    },
    detailValue: {
      fontSize: 16,
      color: theme.colors.text,
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
      fontSize: 16,
      color: theme.colors.primary,
      fontWeight: '500',
      fontFamily: 'monospace',
    },
    explorerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      borderWidth: 2,
      borderColor: theme.colors.primary,
      marginBottom: theme.spacing.lg,
      gap: theme.spacing.xs,
    },
    explorerButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    buttonContainer: {
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    homeButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: theme.borderRadius.lg,
      paddingVertical: theme.spacing.md,
      alignItems: 'center',
    },
    homeButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.buttonText,
    },
    successColor: {
      color: theme.colors.success,
    },
    errorColor: {
      color: theme.colors.error,
    },
    primaryIcon: {
      color: theme.colors.primary,
    },
  });
