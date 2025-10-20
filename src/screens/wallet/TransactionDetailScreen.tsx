import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRoute, useNavigation } from '@react-navigation/native';
import type { StackNavigationProp } from '@react-navigation/stack';
import { TransactionInfo } from '@/types/wallet';
import { formatNativeBalance, formatAssetBalance } from '@/utils/bigint';
import EnvoiService, { EnvoiNameInfo } from '@/services/envoi';
import { formatAddressSync } from '@/utils/address';
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

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
        >
          <Ionicons
            name="arrow-back"
            size={24}
            color={styles.headerIcon.color}
          />
        </TouchableOpacity>
        <Text style={styles.title}>Transaction Details</Text>
        <TouchableOpacity
          style={styles.explorerButton}
          onPress={handleOpenExplorer}
        >
          <Ionicons
            name="open-outline"
            size={24}
            color={styles.headerIcon.color}
          />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.statusContainer}>
          <View style={styles.statusBadge}>
            <Ionicons
              name="checkmark-circle"
              size={20}
              color={styles.successIcon.color}
            />
            <Text style={styles.statusText}>{getTransactionStatus()}</Text>
          </View>
          <Text style={styles.directionText}>
            Round: {transaction.confirmedRound?.toString() || 'Pending'}
          </Text>
        </View>

        <View style={styles.amountContainer}>
          <Text style={styles.amountLabel}>{getTransactionDirection()}</Text>
          <Text
            style={[
              styles.amount,
              {
                color:
                  getTransactionDirection() === 'Received'
                    ? themeColors.success
                    : getTransactionDirection() === 'Sent'
                      ? themeColors.error
                      : themeColors.text,
              },
            ]}
            numberOfLines={2}
            adjustsFontSizeToFit={true}
            minimumFontScale={0.5}
          >
            {getTransactionDirection() === 'Received'
              ? '+'
              : getTransactionDirection() === 'Sent'
                ? '-'
                : ''}
            {assetId === 0
              ? formatBalance(transaction.amount)
              : formatAssetBalance(transaction.amount, decimals || 0)}{' '}
            {assetName}
          </Text>
        </View>

        <View style={styles.detailsContainer}>
          <Text style={styles.sectionTitle}>Transaction Details</Text>

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
                size={16}
                color={styles.primaryIcon.color}
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

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Fee</Text>
            <Text style={styles.detailValue}>
              {formatBalance(transaction.fee)} VOI
            </Text>
          </View>

          {transactionNote && (
            <View style={[styles.detailRow, styles.detailRowNote]}>
              <Text style={styles.detailLabel}>Note</Text>
              <View style={styles.noteContainer}>
                <Text style={styles.noteValue}>{transactionNote}</Text>
              </View>
            </View>
          )}
        </View>

        <View style={styles.addressesContainer}>
          <Text style={styles.sectionTitle}>Addresses</Text>

          <View style={styles.addressSection}>
            <Text style={styles.addressLabel}>From</Text>
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
                color={styles.primaryIcon.color}
              />
            </TouchableOpacity>
          </View>

          <View style={styles.addressSection}>
            <Text style={styles.addressLabel}>To</Text>
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
                color={styles.primaryIcon.color}
              />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 16,
      backgroundColor: theme.colors.card,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    backButton: {
      padding: 8,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
    },
    explorerButton: {
      padding: 8,
    },
    content: {
      flexGrow: 1,
      padding: 16,
    },
    statusContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: 12,
      padding: 20,
      marginBottom: 16,
      alignItems: 'center',
      ...theme.shadows.sm,
    },
    statusBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 8,
    },
    statusText: {
      fontSize: 16,
      fontWeight: '600',
      color: theme.colors.success,
    },
    directionText: {
      fontSize: 14,
      color: theme.colors.textSecondary,
    },
    amountContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: 12,
      padding: 24,
      marginBottom: 16,
      alignItems: 'center',
      ...theme.shadows.sm,
    },
    amountLabel: {
      fontSize: 16,
      color: theme.colors.textSecondary,
      marginBottom: 12,
    },
    amount: {
      fontSize: 28,
      fontWeight: 'bold',
      textAlign: 'center',
      paddingHorizontal: 16,
    },
    detailsContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: 12,
      padding: 20,
      marginBottom: 16,
      ...theme.shadows.sm,
    },
    sectionTitle: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 16,
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      minHeight: 40,
    },
    detailRowNote: {
      paddingBottom: 16,
    },
    detailLabel: {
      fontSize: 14,
      color: theme.colors.textSecondary,
      width: '35%',
      paddingRight: 8,
    },
    detailValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
      textAlign: 'right',
      width: '65%',
      flexShrink: 1,
    },
    noteContainer: {
      width: '65%',
    },
    noteValue: {
      fontSize: 14,
      color: theme.colors.text,
      fontWeight: '500',
      lineHeight: 20,
      textAlign: 'left',
    },
    detailValueContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      width: '65%',
      justifyContent: 'flex-end',
    },
    addressesContainer: {
      backgroundColor: theme.colors.card,
      borderRadius: 12,
      padding: 20,
      ...theme.shadows.sm,
    },
    addressSection: {
      marginBottom: 20,
    },
    addressLabel: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.text,
      marginBottom: 8,
    },
    addressContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.background,
      borderRadius: 8,
      padding: 16,
    },
    addressInfo: {
      flex: 1,
      paddingRight: 8,
    },
    addressShort: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.colors.primary,
      marginBottom: 4,
    },
    addressFull: {
      fontSize: 12,
      color: theme.colors.textSecondary,
      fontFamily: 'monospace',
    },
    envoiName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
      marginBottom: 4,
    },
    headerIcon: {
      color: theme.colors.primary,
    },
    successIcon: {
      color: theme.colors.success,
    },
    successColor: {
      color: theme.colors.success,
    },
    dangerColor: {
      color: theme.colors.error,
    },
    defaultColor: {
      color: theme.colors.text,
    },
    primaryIcon: {
      color: theme.colors.primary,
    },
  });
