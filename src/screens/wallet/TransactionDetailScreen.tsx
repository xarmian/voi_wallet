import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { TransactionInfo } from '@/types/wallet';
import { formatNativeBalance, formatAssetBalance } from '@/utils/bigint';
import EnvoiService, { EnvoiNameInfo } from '@/services/envoi';
import {
  useCurrentNetwork,
  useCurrentNetworkConfig,
} from '@/store/networkStore';
import { getTransactionUrl } from '@/utils/blockExplorer';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';
import {
  SerializableTransactionInfo,
  deserializeTransactionFromNavigation,
} from '@/utils/navigationParams';
import { NFTBackground } from '@/components/common/NFTBackground';
import { BlurredContainer } from '@/components/common/BlurredContainer';
import UniversalHeader from '@/components/common/UniversalHeader';
import { useTheme } from '@/contexts/ThemeContext';

interface TransactionDetailRouteParams {
  transaction: SerializableTransactionInfo;
  assetName: string;
  assetId: number;
  accountAddress: string;
  decimals?: number;
}

export default function TransactionDetailScreen() {
  const route = useRoute();
  const navigation = useNavigation<StackNavigationProp<any>>();
  const currentNetwork = useCurrentNetwork();
  const currentNetworkConfig = useCurrentNetworkConfig();
  const { theme } = useTheme();
  const {
    transaction: serializedTransaction,
    assetName,
    assetId,
    accountAddress,
    decimals,
  } = route.params as TransactionDetailRouteParams;
  const transaction = useMemo<TransactionInfo>(
    () => deserializeTransactionFromNavigation(serializedTransaction),
    [serializedTransaction]
  );
  const styles = useThemedStyles(createStyles);
  const themeColors = useThemeColors();
  const transactionNote = useMemo(() => {
    if (!transaction.note) {
      return undefined;
    }

    const trimmedNote = transaction.note.trim();
    return trimmedNote.length > 0 ? trimmedNote : undefined;
  }, [transaction.note]);

  const [fromNameInfo, setFromNameInfo] = useState<EnvoiNameInfo | null>(null);
  const [toNameInfo, setToNameInfo] = useState<EnvoiNameInfo | null>(null);

  const formatTransactionType = (type: TransactionInfo['type']) => {
    switch (type) {
      case 'payment':
        return 'Payment';
      case 'asset-transfer':
        return 'Asset Transfer';
      case 'asset-config':
        return 'Asset Configuration';
      case 'application-call':
        return 'Application Call';
      case 'arc200-transfer':
        return 'ARC-200 Transfer';
      default:
        return 'Unknown Transaction';
    }
  };

  const formatFullTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  const formatAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-6)}`;
  };

  const formatFullAddress = (address: string) => {
    return address;
  };

  // Load Envoi names for transaction addresses
  useEffect(() => {
    const loadEnvoiNames = async () => {
      const envoiService = EnvoiService.getInstance();

      // Load from address name
      if (transaction.from) {
        try {
          const fromName = await envoiService.getName(transaction.from);
          setFromNameInfo(fromName);
        } catch (error) {
          console.warn('Failed to load from address name:', error);
        }
      }

      // Load to address name
      if (transaction.to) {
        try {
          const toName = await envoiService.getName(transaction.to);
          setToNameInfo(toName);
        } catch (error) {
          console.warn('Failed to load to address name:', error);
        }
      }
    };

    loadEnvoiNames();
  }, [transaction.from, transaction.to]);

  const formatBalance = (amount: number | bigint) => {
    return formatNativeBalance(amount, currentNetworkConfig.nativeToken);
  };

  const handleCopyAddress = (address: string) => {
    // Note: In a real app, you'd implement clipboard functionality
    Alert.alert('Address Copied', 'Address has been copied to clipboard');
  };

  const handleOpenExplorer = () => {
    const explorerUrl = getTransactionUrl(transaction.id, currentNetwork);
    navigation.navigate('WebView', {
      url: explorerUrl,
      title: 'Block Explorer',
    });
  };

  const getTransactionStatus = () => {
    // In a real implementation, you might have different statuses
    return 'Confirmed';
  };

  const getTransactionDirection = () => {
    if (!accountAddress || accountAddress.trim() === '') {
      return 'Unknown';
    }

    if (transaction.from === transaction.to) {
      return 'Self';
    }

    if (transaction.from === accountAddress) {
      return 'Sent';
    } else if (transaction.to === accountAddress) {
      return 'Received';
    } else {
      return 'Unknown';
    }
  };

  const direction = getTransactionDirection();
  const isReceived = direction === 'Received';
  const isSent = direction === 'Sent';

  return (
    <NFTBackground>
      <SafeAreaView style={styles.container} edges={['top']}>
        <UniversalHeader
          title="Transaction Details"
          showBackButton
          onBackPress={() => navigation.goBack()}
          showAccountSelector={false}
          onAccountSelectorPress={() => {}}
          rightAction={
            <TouchableOpacity
              style={styles.explorerButton}
              onPress={handleOpenExplorer}
            >
              <Ionicons
                name="open-outline"
                size={22}
                color={theme.colors.primary}
              />
            </TouchableOpacity>
          }
        />

        <ScrollView contentContainerStyle={styles.content}>
          {/* Status Card */}
          <BlurredContainer
            style={styles.statusContainer}
            borderRadius={theme.borderRadius.lg}
          >
            <View style={styles.statusBadge}>
              <Ionicons
                name="checkmark-circle"
                size={24}
                color={themeColors.success}
              />
              <Text style={styles.statusText}>{getTransactionStatus()}</Text>
            </View>
            <Text style={styles.roundText}>
              Round: {transaction.confirmedRound?.toString() || 'Pending'}
            </Text>
          </BlurredContainer>

          {/* Amount Card */}
          <BlurredContainer
            style={styles.amountContainer}
            borderRadius={theme.borderRadius.lg}
          >
            <View style={[
              styles.directionBadge,
              isReceived && styles.receivedBadge,
              isSent && styles.sentBadge,
            ]}>
              <Ionicons
                name={isReceived ? 'arrow-down' : isSent ? 'arrow-up' : 'swap-horizontal'}
                size={16}
                color={isReceived ? themeColors.success : isSent ? themeColors.error : themeColors.text}
              />
              <Text style={[
                styles.directionText,
                isReceived && styles.receivedText,
                isSent && styles.sentText,
              ]}>
                {direction}
              </Text>
            </View>
            <Text
              style={[
                styles.amount,
                isReceived && styles.receivedAmount,
                isSent && styles.sentAmount,
              ]}
              numberOfLines={2}
              adjustsFontSizeToFit={true}
              minimumFontScale={0.5}
            >
              {isReceived ? '+' : isSent ? '-' : ''}
              {assetId === 0
                ? formatBalance(transaction.amount)
                : formatAssetBalance(transaction.amount, decimals || 0)}{' '}
              {assetName}
            </Text>
          </BlurredContainer>

          {/* Transaction Details Card */}
          <BlurredContainer
            style={styles.detailsContainer}
            borderRadius={theme.borderRadius.lg}
          >
            <Text style={styles.sectionTitle}>Details</Text>

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Transaction ID</Text>
              <TouchableOpacity
                style={styles.detailValueContainer}
                onPress={() => handleCopyAddress(transaction.id)}
              >
                <Text
                  style={styles.detailValue}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {formatAddress(transaction.id)}
                </Text>
                <Ionicons
                  name="copy-outline"
                  size={14}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            </View>

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Type</Text>
              <Text style={styles.detailValue}>
                {formatTransactionType(transaction.type)}
              </Text>
            </View>

            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Date & Time</Text>
              <Text style={styles.detailValue}>
                {formatFullTimestamp(transaction.timestamp)}
              </Text>
            </View>

            <View style={[styles.detailRow, styles.detailRowLast]}>
              <Text style={styles.detailLabel}>Fee</Text>
              <Text style={styles.detailValue}>
                {formatBalance(transaction.fee)} VOI
              </Text>
            </View>

            {transactionNote && (
              <View style={styles.noteSection}>
                <Text style={styles.detailLabel}>Note</Text>
                <View style={styles.noteContainer}>
                  <Text style={styles.noteValue}>{transactionNote}</Text>
                </View>
              </View>
            )}
          </BlurredContainer>

          {/* Addresses Card */}
          <BlurredContainer
            style={styles.addressesContainer}
            borderRadius={theme.borderRadius.lg}
          >
            <Text style={styles.sectionTitle}>Addresses</Text>

            <View style={styles.addressSection}>
              <View style={styles.addressLabelRow}>
                <Ionicons name="arrow-up-circle-outline" size={18} color={themeColors.error} />
                <Text style={styles.addressLabel}>From</Text>
              </View>
              <TouchableOpacity
                style={styles.addressContainer}
                onPress={() => handleCopyAddress(transaction.from)}
              >
                <View style={styles.addressInfo}>
                  {fromNameInfo?.name && (
                    <Text
                      style={styles.envoiName}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {fromNameInfo.name}
                    </Text>
                  )}
                  <Text style={styles.addressShort}>
                    {formatAddress(transaction.from)}
                  </Text>
                  <Text
                    style={styles.addressFull}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {formatFullAddress(transaction.from)}
                  </Text>
                </View>
                <Ionicons
                  name="copy-outline"
                  size={16}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            </View>

            <View style={[styles.addressSection, styles.addressSectionLast]}>
              <View style={styles.addressLabelRow}>
                <Ionicons name="arrow-down-circle-outline" size={18} color={themeColors.success} />
                <Text style={styles.addressLabel}>To</Text>
              </View>
              <TouchableOpacity
                style={styles.addressContainer}
                onPress={() => handleCopyAddress(transaction.to)}
              >
                <View style={styles.addressInfo}>
                  {toNameInfo?.name && (
                    <Text
                      style={styles.envoiName}
                      numberOfLines={1}
                      ellipsizeMode="tail"
                    >
                      {toNameInfo.name}
                    </Text>
                  )}
                  <Text style={styles.addressShort}>
                    {formatAddress(transaction.to)}
                  </Text>
                  <Text
                    style={styles.addressFull}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    {formatFullAddress(transaction.to)}
                  </Text>
                </View>
                <Ionicons
                  name="copy-outline"
                  size={16}
                  color={theme.colors.primary}
                />
              </TouchableOpacity>
            </View>
          </BlurredContainer>
        </ScrollView>
      </SafeAreaView>
    </NFTBackground>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    explorerButton: {
      padding: 8,
    },
    content: {
      flexGrow: 1,
      padding: theme.spacing.sm,
      paddingBottom: theme.spacing.xxl,
    },
    statusContainer: {
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      alignItems: 'center',
    },
    statusBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4,
    },
    statusText: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.success,
    },
    roundText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    amountContainer: {
      padding: theme.spacing.xl,
      marginBottom: theme.spacing.sm,
      alignItems: 'center',
    },
    directionBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 20,
      backgroundColor: theme.colors.glassBackground,
      marginBottom: theme.spacing.sm,
    },
    receivedBadge: {
      backgroundColor: `${theme.colors.success}20`,
    },
    sentBadge: {
      backgroundColor: `${theme.colors.error}20`,
    },
    directionText: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    receivedText: {
      color: theme.colors.success,
    },
    sentText: {
      color: theme.colors.error,
    },
    amount: {
      fontSize: 32,
      fontWeight: 'bold',
      textAlign: 'center',
      color: theme.colors.text,
    },
    receivedAmount: {
      color: theme.colors.success,
    },
    sentAmount: {
      color: theme.colors.error,
    },
    detailsContainer: {
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: theme.spacing.sm,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: theme.spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.glassBorder,
    },
    detailRowLast: {
      borderBottomWidth: 0,
    },
    detailLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    detailValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
    },
    detailValueContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    noteSection: {
      marginTop: theme.spacing.sm,
      paddingTop: theme.spacing.sm,
      borderTopWidth: 1,
      borderTopColor: theme.colors.glassBorder,
    },
    noteContainer: {
      marginTop: theme.spacing.sm,
      padding: theme.spacing.sm,
      backgroundColor: theme.colors.glassBackground,
      borderRadius: theme.borderRadius.sm,
    },
    noteValue: {
      fontSize: 14,
      color: theme.colors.text,
      lineHeight: 20,
    },
    addressesContainer: {
      padding: theme.spacing.lg,
    },
    addressSection: {
      marginBottom: theme.spacing.lg,
    },
    addressSectionLast: {
      marginBottom: 0,
    },
    addressLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: theme.spacing.sm,
    },
    addressLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
    },
    addressContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.glassBackground,
      borderRadius: theme.borderRadius.sm,
      padding: theme.spacing.sm,
      borderWidth: 1,
      borderColor: theme.colors.glassBorder,
    },
    addressInfo: {
      flex: 1,
      paddingRight: 8,
    },
    addressShort: {
      fontSize: 15,
      fontWeight: '500',
      color: theme.colors.primary,
      marginBottom: 2,
    },
    addressFull: {
      fontSize: 11,
      color: theme.colors.textSecondary,
      fontFamily: 'monospace',
    },
    envoiName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 4,
    },
  });
