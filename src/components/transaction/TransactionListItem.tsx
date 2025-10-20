import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { TransactionInfo, AssetBalance } from '@/types/wallet';
import { Arc200TokenMetadata } from '@/services/mimir';
import { formatNativeBalance, formatAssetBalance } from '@/utils/bigint';
import TransactionAddressDisplay from './TransactionAddressDisplay';
import { useCurrentNetworkConfig } from '@/store/networkStore';
import { useThemedStyles, useThemeColors } from '@/hooks/useThemedStyles';
import { Theme } from '@/constants/themes';

interface TransactionListItemProps {
  transaction: TransactionInfo;
  activeAccountAddress: string;
  assets?: AssetBalance[];
  tokenMetadata?: Arc200TokenMetadata | null;
  onPress: (transaction: TransactionInfo) => void;
}

const TransactionListItem = React.memo(
  ({
    transaction,
    activeAccountAddress,
    assets,
    tokenMetadata,
    onPress,
  }: TransactionListItemProps) => {
    const [imageError, setImageError] = useState(false);
    const currentNetworkConfig = useCurrentNetworkConfig();
    const styles = useThemedStyles(createStyles);
    const themeColors = useThemeColors();

    const isOutgoing = transaction.from === activeAccountAddress;

    const formatTransactionType = (type: TransactionInfo['type']) => {
      switch (type) {
        case 'payment':
          return isOutgoing ? 'Sent' : 'Received';
        case 'asset-transfer':
          return isOutgoing ? 'Sent' : 'Received';
        case 'asset-config':
          return 'Asset Config';
        case 'application-call':
          return 'App Call';
        case 'arc200-transfer':
          return isOutgoing ? 'Sent' : 'Received';
        default:
          return 'Unknown';
      }
    };

    const getTransactionTypeIcon = (type: TransactionInfo['type']) => {
      switch (type) {
        case 'payment':
          return isOutgoing ? 'arrow-up' : 'arrow-down';
        case 'asset-transfer':
          return isOutgoing ? 'arrow-up' : 'arrow-down';
        case 'asset-config':
          return 'settings';
        case 'application-call':
          return 'cube';
        case 'arc200-transfer':
          return isOutgoing ? 'arrow-up' : 'arrow-down';
        default:
          return 'help-circle';
      }
    };

    const getTransactionTypeColor = (type: TransactionInfo['type']) => {
      switch (type) {
        case 'payment':
        case 'asset-transfer':
        case 'arc200-transfer':
          return isOutgoing ? themeColors.error : themeColors.success;
        case 'application-call':
          return '#8B5CF6'; // Purple for application calls
        case 'asset-config':
          return themeColors.warning;
        default:
          return themeColors.textSecondary;
      }
    };

    const formatTimestamp = (timestamp: number) => {
      const date = new Date(timestamp);
      const now = new Date();
      const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

      if (diffInHours < 24) {
        return date.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
      } else if (diffInHours < 24 * 7) {
        return date.toLocaleDateString([], {
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
        });
      } else {
        return date.toLocaleDateString();
      }
    };

    const getTransactionAmount = () => {
      const sign = isOutgoing ? '-' : '+';

      if (transaction.isArc200 && transaction.contractId) {
        // For ARC-200 tokens, prefer cached metadata, fallback to assets
        let decimals = 0;
        let symbol = 'TOKEN';

        if (tokenMetadata) {
          decimals = tokenMetadata.decimals;
          symbol = tokenMetadata.symbol;
        } else {
          const asset = assets?.find(
            (a) =>
              a.assetType === 'arc200' &&
              a.contractId === transaction.contractId
          );
          decimals = asset?.decimals || 0;
          symbol = asset?.symbol || 'TOKEN';
        }

        return `${sign}${formatAssetBalance(transaction.amount, decimals)} ${symbol}`;
      } else if (transaction.assetId && transaction.assetId !== 0) {
        // For ASA tokens
        const asset = assets?.find(
          (a) => a.assetType === 'asa' && a.assetId === transaction.assetId
        );
        const decimals = asset?.decimals || 0;
        const symbol = asset?.symbol || 'TOKEN';
        return `${sign}${formatAssetBalance(transaction.amount, decimals)} ${symbol}`;
      } else {
        // For native token
        return `${sign}${formatNativeBalance(transaction.amount, currentNetworkConfig.nativeToken)} ${currentNetworkConfig.nativeToken}`;
      }
    };

    const getTransactionStatus = () => {
      // For now, we'll assume all transactions are confirmed
      // In a real implementation, you'd check the transaction's confirmation status
      return 'confirmed';
    };

    const getStatusColor = (status: string) => {
      switch (status) {
        case 'pending':
          return 'warning';
        case 'failed':
          return 'error';
        default:
          return isOutgoing ? 'error' : 'success';
      }
    };

    const renderAssetIcon = () => {
      // For native token, use network-specific image
      if (
        !transaction.isArc200 &&
        (!transaction.assetId || transaction.assetId === 0)
      ) {
        return (
          <Image
            source={currentNetworkConfig.nativeTokenImage}
            style={styles.assetIcon}
          />
        );
      }

      // For ARC-200 tokens, prefer cached metadata
      let imageUrl: string | undefined;

      if (transaction.isArc200 && transaction.contractId) {
        if (tokenMetadata?.imageUrl) {
          imageUrl = tokenMetadata.imageUrl;
        } else {
          const asset = assets?.find(
            (a) =>
              a.assetType === 'arc200' &&
              a.contractId === transaction.contractId
          );
          imageUrl = asset?.imageUrl;
        }
      } else if (transaction.assetId && transaction.assetId !== 0) {
        const asset = assets?.find(
          (a) => a.assetType === 'asa' && a.assetId === transaction.assetId
        );
        imageUrl = asset?.imageUrl;
      }

      // If we have an image URL and no error, show it
      if (imageUrl && !imageError) {
        return (
          <Image
            source={{ uri: imageUrl }}
            style={styles.assetIcon}
            onError={() => setImageError(true)}
          />
        );
      }

      // Fallback icons based on asset type
      let iconName: keyof typeof Ionicons.glyphMap;
      let iconColor = '#007AFF';

      if (transaction.isArc200) {
        iconName = 'contract';
        iconColor = '#8B5CF6'; // Purple for ARC-200
      } else if (transaction.assetId && transaction.assetId !== 0) {
        iconName = 'diamond';
        iconColor = '#F59E0B'; // Amber for ASA
      } else {
        // This shouldn't happen for VOI since we have the image above
        iconName = 'logo-bitcoin';
        iconColor = '#007AFF';
      }

      return (
        <View style={styles.fallbackIcon}>
          <Ionicons name={iconName} size={28} color={iconColor} />
        </View>
      );
    };

    const status = getTransactionStatus();
    const statusColor = getStatusColor(status);

    const containerStyle = [
      styles.container,
      isOutgoing ? styles.outgoingContainer : styles.incomingContainer,
      status === 'pending' && styles.pendingContainer,
    ];

    const amountStyle = [
      styles.transactionAmount,
      isOutgoing ? styles.outgoingAmount : styles.incomingAmount,
      status === 'pending' && styles.pendingAmount,
    ];

    return (
      <TouchableOpacity
        style={containerStyle}
        onPress={() => onPress(transaction)}
      >
        <View style={styles.iconContainer}>
          {renderAssetIcon()}
          {status === 'pending' && (
            <View style={styles.pendingBadge}>
              <Ionicons name="time" size={10} color="white" />
            </View>
          )}
        </View>

        <View style={styles.details}>
          <View style={styles.header}>
            <View
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}
            >
              <Ionicons
                name={getTransactionTypeIcon(transaction.type) as any}
                size={16}
                color={getTransactionTypeColor(transaction.type)}
                style={{ marginRight: 4 }}
              />
              <Text style={styles.transactionType}>
                {formatTransactionType(transaction.type)}
              </Text>
              {status !== 'confirmed' && (
                <View
                  style={[
                    styles.statusBadge,
                    status === 'pending'
                      ? styles.pendingStatus
                      : status === 'failed'
                        ? styles.failedStatus
                        : styles.confirmedStatus,
                  ]}
                >
                  <Text style={styles.statusText}>{status}</Text>
                </View>
              )}
            </View>
            <Text style={styles.transactionDate}>
              {formatTimestamp(transaction.timestamp)}
            </Text>
          </View>

          {transaction.type === 'application-call' ? (
            <Text style={styles.applicationCall}>
              {transaction.applicationId
                ? `App ${transaction.applicationId}`
                : 'App Call'}
            </Text>
          ) : (
            <TransactionAddressDisplay
              address={isOutgoing ? transaction.to : transaction.from}
              isOutgoing={isOutgoing}
              style={styles.transactionAddress}
              nameStyle={styles.transactionName}
              addressStyle={styles.transactionAddressText}
            />
          )}

          <Text style={amountStyle}>{getTransactionAmount()}</Text>
        </View>

        <Ionicons
          name="chevron-forward"
          size={20}
          color={styles.chevronIcon.color}
        />
      </TouchableOpacity>
    );
  }
);

TransactionListItem.displayName = 'TransactionListItem';

const createStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.colors.card,
      borderRadius: theme.borderRadius.lg,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      ...theme.shadows.md,
      borderLeftWidth: 3,
      borderLeftColor: 'transparent',
    },
    outgoingContainer: {
      borderLeftColor: theme.colors.error,
    },
    incomingContainer: {
      borderLeftColor: theme.colors.success,
    },
    pendingContainer: {
      borderLeftColor: theme.colors.warning,
    },
    iconContainer: {
      marginRight: theme.spacing.md,
      position: 'relative',
    },
    assetIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
    },
    fallbackIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.colors.primary + '20',
      justifyContent: 'center',
      alignItems: 'center',
    },
    pendingBadge: {
      position: 'absolute',
      top: -2,
      right: -2,
      backgroundColor: theme.colors.warning,
      borderRadius: 8,
      width: 16,
      height: 16,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 2,
      borderColor: theme.colors.card,
    },
    details: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      marginBottom: theme.spacing.xs,
    },
    transactionType: {
      fontSize: 16,
      fontWeight: '700',
      color: theme.colors.text,
      flex: 1,
    },
    transactionAmount: {
      fontSize: 18,
      fontWeight: '700',
      marginTop: theme.spacing.xs,
      alignSelf: 'flex-start',
    },
    outgoingAmount: {
      color: theme.colors.error,
    },
    incomingAmount: {
      color: theme.colors.success,
    },
    pendingAmount: {
      color: theme.colors.warning,
    },
    transactionAddress: {
      marginBottom: theme.spacing.xs,
      color: theme.colors.textSecondary,
    },
    transactionName: {
      fontSize: 14,
      fontWeight: '600',
      color: theme.colors.primary,
    },
    transactionAddressText: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontFamily: 'monospace',
    },
    transactionDate: {
      fontSize: 12,
      color: theme.colors.textMuted,
      fontWeight: '500',
    },
    applicationCall: {
      fontSize: 14,
      fontWeight: '600',
      color: '#8B5CF6', // Purple color for application calls
      marginBottom: theme.spacing.xs,
    },
    chevronIcon: {
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.sm,
    },
    statusBadge: {
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 2,
      borderRadius: theme.borderRadius.sm,
      marginLeft: theme.spacing.xs,
      alignSelf: 'flex-start',
    },
    pendingStatus: {
      backgroundColor: theme.colors.warning + '20',
    },
    confirmedStatus: {
      backgroundColor: theme.colors.success + '20',
    },
    failedStatus: {
      backgroundColor: theme.colors.error + '20',
    },
    statusText: {
      fontSize: 10,
      fontWeight: '600',
      textTransform: 'uppercase',
    },
  });

export default TransactionListItem;
